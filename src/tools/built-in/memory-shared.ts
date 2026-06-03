import type { MemoryStore } from "../../memory/memory-store.js";

let memoryStore: MemoryStore | null = null;

export function setMemoryStoreForTools(store: MemoryStore | null): void {
  memoryStore = store;
}

export function getMemoryStoreForTools(): MemoryStore | null {
  return memoryStore;
}
