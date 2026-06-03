import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { getArtifactStoreForTools } from "./artifact-shared.js";

const DEFAULT_LIMIT_CHARS = 50_000;
const MAX_LIMIT_CHARS = 50_000;

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml" ||
    mimeType === "application/x-yaml"
  );
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
): Promise<unknown> {
  const store = getArtifactStoreForTools();
  if (!store) {
    return {
      output: "Artifact store is not configured.",
      isError: true,
    };
  }

  const artifactId = typeof args.artifact_id === "string"
    ? args.artifact_id.trim()
    : "";
  if (!artifactId) {
    return {
      output: "artifact_id is required.",
      isError: true,
    };
  }

  const info = store.getInfo(artifactId);
  if (!info) {
    return {
      output: `Artifact not found: ${artifactId}`,
      isError: true,
    };
  }

  if (info.sessionId !== sessionId) {
    return {
      output: `Artifact ${artifactId} belongs to a different session.`,
      isError: true,
    };
  }

  if (!isTextMimeType(info.mimeType)) {
    return {
      output: `Artifact ${artifactId} is ${info.mimeType} (${info.sizeBytes} bytes) and cannot be read as text by read_artifact.`,
      isError: true,
    };
  }

  const data = store.retrieve(artifactId);
  if (!data) {
    return {
      output: `Artifact data missing: ${artifactId}`,
      isError: true,
    };
  }

  const offset = Math.max(0, Math.floor((args.offset as number | undefined) ?? 0));
  const requestedLimit = Math.floor((args.limit as number | undefined) ?? DEFAULT_LIMIT_CHARS);
  const limit = Math.max(1, Math.min(requestedLimit, MAX_LIMIT_CHARS));
  const text = data.toString("utf-8");
  const chunk = text.slice(offset, offset + limit);
  const end = offset + chunk.length;
  const suffix = end < text.length
    ? `\n\n[Artifact truncated: showing chars ${offset}-${end} of ${text.length}. Call read_artifact with offset=${end} to continue.]`
    : "";

  return `[Artifact ${artifactId} (${info.mimeType}, ${info.sizeBytes} bytes)]\n${chunk}${suffix}`;
}

export const readArtifactTool: ExecutableToolDefinition = buildTool({
  name: "read_artifact",
  description: "Read a text artifact that was previously saved from a large tool result.",
  params: {
    artifact_id: {
      type: "string",
      description: "The artifact id from an artifact_pointer event.",
    },
    offset: {
      type: "number",
      description: "Optional character offset to start reading from.",
      optional: true,
    },
    limit: {
      type: "number",
      description: `Optional maximum characters to read, capped at ${MAX_LIMIT_CHARS}.`,
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["artifact.read"],
  maxResultSizeChars: Infinity,
});
