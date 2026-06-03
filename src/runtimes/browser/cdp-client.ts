export interface CdpTransport {
  send(data: string): void;
  close(): void;
  onMessage: ((data: string) => void) | null;
  onClose: (() => void) | null;
  onError: ((err: Error) => void) | null;
}

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export class CdpClient {
  #transport: CdpTransport;
  #nextId = 1;
  #pending = new Map<number, PendingCommand>();
  #eventHandlers: Array<{
    method: string;
    sessionId: string | undefined;
    cb: (params: unknown) => void;
  }> = [];
  #closed = false;
  #onClose: (() => void) | undefined;
  #onError: ((err: Error) => void) | undefined;

  constructor(
    transport: CdpTransport,
    options?: {
      onClose?: () => void;
      onError?: (err: Error) => void;
    },
  ) {
    this.#transport = transport;
    this.#onClose = options?.onClose;
    this.#onError = options?.onError;
    this.#transport.onMessage = (data: string) => this.#dispatch(data);
    this.#transport.onClose = () => {
      this.#closed = true;
      for (const [, cmd] of this.#pending) {
        cmd.reject(new Error("CDP transport closed"));
      }
      this.#pending.clear();
      this.#onClose?.();
    };
    this.#transport.onError = (err: Error) => {
      this.#onError?.(err);
    };
  }

  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("CDP client is closed"));
    }

    const id = this.#nextId++;
    const msg: Record<string, unknown> = { id, method, params: params ?? {} };
    if (sessionId) msg.sessionId = sessionId;
    const message = JSON.stringify(msg);

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#transport.send(message);
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  onEvent(
    method: string,
    cb: (params: unknown) => void,
    sessionId?: string,
  ): () => void {
    const entry = { method, sessionId, cb };
    this.#eventHandlers.push(entry);
    return () => {
      const idx = this.#eventHandlers.indexOf(entry);
      if (idx !== -1) this.#eventHandlers.splice(idx, 1);
    };
  }

  close(): void {
    this.#closed = true;
    for (const [, cmd] of this.#pending) {
      cmd.reject(new Error("CDP client closed"));
    }
    this.#pending.clear();
    this.#eventHandlers = [];
    this.#transport.close();
  }

  #dispatch(data: string): void {
    let msg: {
      id?: number;
      method?: string;
      sessionId?: string;
      result?: unknown;
      error?: { code: number; message: string };
      params?: unknown;
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.id !== undefined && msg.id !== null) {
      const cmd = this.#pending.get(msg.id);
      if (!cmd) return;
      this.#pending.delete(msg.id);

      if (msg.error) {
        cmd.reject(
          new Error(`CDP error ${msg.error.code}: ${msg.error.message}`),
        );
      } else {
        cmd.resolve(msg.result);
      }
      return;
    }

    // Event (no id) — route to matching handlers
    if (msg.method) {
      for (const handler of this.#eventHandlers) {
        if (handler.method !== msg.method) continue;
        if (
          handler.sessionId !== undefined &&
          msg.sessionId !== undefined &&
          handler.sessionId !== msg.sessionId
        )
          continue;
        handler.cb(msg.params ?? {});
      }
    }
  }
}
