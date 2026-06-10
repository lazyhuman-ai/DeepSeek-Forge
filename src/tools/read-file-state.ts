import { resolve } from "node:path";

export type FileState = {
  content: string;
  mtimeMs: number;
  encoding?: import("./text-file-io.js").TextEncoding;
  hadBom?: boolean;
  lineEnding?: import("./text-file-io.js").LineEnding;
  offset?: number;
  limit?: number;
  isPartialView?: boolean;
};

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_CONTENT_BYTES = 25 * 1024 * 1024;

function normalizeStatePath(path: string): string {
  return resolve(path);
}

function stateSize(state: FileState): number {
  return Buffer.byteLength(state.content, "utf8");
}

export class ReadFileState {
  #files = new Map<string, FileState>();
  #totalContentBytes = 0;
  #maxEntries: number;
  #maxContentBytes: number;

  constructor(options?: { maxEntries?: number; maxContentBytes?: number }) {
    this.#maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxContentBytes = options?.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  }

  get(path: string): FileState | undefined {
    const key = normalizeStatePath(path);
    const state = this.#files.get(key);
    if (!state) return undefined;
    this.#files.delete(key);
    this.#files.set(key, state);
    return state;
  }

  set(path: string, state: FileState): void {
    const key = normalizeStatePath(path);
    const previous = this.#files.get(key);
    if (previous) this.#totalContentBytes -= stateSize(previous);
    this.#files.set(key, state);
    this.#totalContentBytes += stateSize(state);
    this.#evictIfNeeded();
  }

  delete(path: string): void {
    const key = normalizeStatePath(path);
    const previous = this.#files.get(key);
    if (!previous) return;
    this.#files.delete(key);
    this.#totalContentBytes -= stateSize(previous);
  }

  clear(): void {
    this.#files.clear();
    this.#totalContentBytes = 0;
  }

  size(): number {
    return this.#files.size;
  }

  contentBytes(): number {
    return this.#totalContentBytes;
  }

  #evictIfNeeded(): void {
    while (
      this.#files.size > this.#maxEntries ||
      this.#totalContentBytes > this.#maxContentBytes
    ) {
      const first = this.#files.entries().next().value as [string, FileState] | undefined;
      if (!first) break;
      this.#files.delete(first[0]);
      this.#totalContentBytes -= stateSize(first[1]);
    }
  }
}

export const readFileState = new ReadFileState();

const scopedReadFileStates = new Map<string, ReadFileState>();

export function readFileStateForScope(scope?: string): ReadFileState {
  if (!scope) return readFileState;
  const existing = scopedReadFileStates.get(scope);
  if (existing) return existing;
  const state = new ReadFileState();
  scopedReadFileStates.set(scope, state);
  return state;
}

export function readFileStateForContext(context?: { readFileStateScope?: string }): ReadFileState {
  return readFileStateForScope(context?.readFileStateScope);
}

export function clearScopedReadFileStates(): void {
  scopedReadFileStates.clear();
}
