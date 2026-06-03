import type { ExecutableToolDefinition } from "./schemas.js";

export class ToolRegistry {
  #tools = new Map<string, ExecutableToolDefinition>();

  register(tool: ExecutableToolDefinition): void {
    this.#tools.set(tool.name, tool);
  }

  get(name: string): ExecutableToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): ExecutableToolDefinition[] {
    return [...this.#tools.values()];
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  unregisterBySource(source: { kind: "builtin" | "mcp"; serverId?: string }): number {
    let deleted = 0;
    for (const [name, tool] of this.#tools) {
      if (tool.source?.kind !== source.kind) continue;
      if (source.serverId !== undefined && tool.source.serverId !== source.serverId) continue;
      this.#tools.delete(name);
      deleted++;
    }
    return deleted;
  }

  replaceBySource(
    source: { kind: "builtin" | "mcp"; serverId?: string },
    tools: ExecutableToolDefinition[],
  ): void {
    this.unregisterBySource(source);
    for (const tool of tools) {
      this.register(tool);
    }
  }
}
