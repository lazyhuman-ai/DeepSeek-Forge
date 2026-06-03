import type { ArtifactStore } from "../../artifacts/artifact-store.js";

let artifactStore: ArtifactStore | null = null;

export function setArtifactStoreForTools(store: ArtifactStore | null): void {
  artifactStore = store;
}

export function getArtifactStoreForTools(): ArtifactStore | null {
  return artifactStore;
}
