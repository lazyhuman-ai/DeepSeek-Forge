export type FileState = {
  content: string;
  mtimeMs: number;
  offset?: number;
  limit?: number;
  isPartialView?: boolean;
};

class ReadFileState {
  #files = new Map<string, FileState>();

  get(path: string): FileState | undefined {
    return this.#files.get(path);
  }

  set(path: string, state: FileState): void {
    this.#files.set(path, state);
  }

  clear(): void {
    this.#files.clear();
  }
}

export const readFileState = new ReadFileState();
