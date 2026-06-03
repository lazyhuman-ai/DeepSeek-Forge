import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { resolve as pathResolve, join as pathJoin } from "node:path";
import { randomUUID } from "node:crypto";

export type ArtifactInfo = {
  artifactId: string;
  sessionId: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};

type MetadataFile = Omit<ArtifactInfo, "sizeBytes">;

export class ArtifactStore {
  #baseDir: string;

  constructor(baseDir = ".forge/artifacts") {
    this.#baseDir = pathResolve(baseDir);
    mkdirSync(this.#baseDir, { recursive: true });
  }

  store(
    sessionId: string,
    data: Buffer | string,
    mimeType: string,
  ): ArtifactInfo {
    const artifactId = randomUUID();
    const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;

    const dataPath = pathJoin(this.#baseDir, `${artifactId}.bin`);
    writeFileSync(dataPath, buf);

    const meta: MetadataFile = {
      artifactId,
      sessionId,
      mimeType,
      createdAt: new Date().toISOString(),
    };
    const metaPath = pathJoin(this.#baseDir, `${artifactId}.meta.json`);
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    return { ...meta, sizeBytes: buf.length };
  }

  retrieve(artifactId: string): Buffer | null {
    const dataPath = pathJoin(this.#baseDir, `${artifactId}.bin`);
    if (!existsSync(dataPath)) return null;
    return readFileSync(dataPath);
  }

  getInfo(artifactId: string): ArtifactInfo | null {
    const metaPath = pathJoin(this.#baseDir, `${artifactId}.meta.json`);
    if (!existsSync(metaPath)) return null;
    const raw = readFileSync(metaPath, "utf-8");
    const meta = JSON.parse(raw) as MetadataFile;
    const dataPath = pathJoin(this.#baseDir, `${artifactId}.bin`);
    const sizeBytes = existsSync(dataPath)
      ? readFileSync(dataPath).length
      : 0;
    return { ...meta, sizeBytes };
  }

  delete(artifactId: string): boolean {
    const dataPath = pathJoin(this.#baseDir, `${artifactId}.bin`);
    const metaPath = pathJoin(this.#baseDir, `${artifactId}.meta.json`);
    let deleted = false;

    if (existsSync(dataPath)) {
      rmSync(dataPath);
      deleted = true;
    }
    if (existsSync(metaPath)) {
      rmSync(metaPath);
      deleted = true;
    }
    return deleted;
  }

  listBySession(sessionId: string): ArtifactInfo[] {
    const results: ArtifactInfo[] = [];
    if (!existsSync(this.#baseDir)) return results;

    for (const entry of readdirSync(this.#baseDir)) {
      if (!entry.endsWith(".meta.json")) continue;
      const metaPath = pathJoin(this.#baseDir, entry);
      const raw = readFileSync(metaPath, "utf-8");
      const meta = JSON.parse(raw) as ArtifactInfo;
      if (meta.sessionId === sessionId) {
        results.push(meta);
      }
    }
    return results;
  }
}
