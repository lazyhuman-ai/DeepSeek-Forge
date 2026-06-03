import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ExecutableToolDefinition } from "../src/tools/schemas.js";

function echo(): ExecutableToolDefinition {
  return {
    name: "echo",
    description: "Echoes back the input",
    params: {
      message: { type: "string", description: "The message to echo" },
    },
    handler: async (args) => `echo: ${args.message}`,
  };
}

function add(): ExecutableToolDefinition {
  return {
    name: "add",
    description: "Adds two numbers",
    params: {
      a: { type: "number", description: "First number" },
      b: { type: "number", description: "Second number" },
    },
    handler: async (args) => (args.a as number) + (args.b as number),
  };
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("registers and retrieves a tool", () => {
    registry.register(echo());
    const tool = registry.get("echo");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("echo");
    expect(tool!.description).toBe("Echoes back the input");
  });

  it("returns undefined for unknown tool", () => {
    expect(registry.get("nope")).toBeUndefined();
  });

  it("has returns true for registered, false for unknown", () => {
    registry.register(echo());
    expect(registry.has("echo")).toBe(true);
    expect(registry.has("nope")).toBe(false);
  });

  it("list returns all registered tools", () => {
    registry.register(echo());
    registry.register(add());
    const tools = registry.list();
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain("echo");
    expect(names).toContain("add");
  });

  it("overwrites tool with same name", () => {
    registry.register(echo());
    registry.register({
      name: "echo",
      description: "Better echo",
      params: { text: { type: "string", description: "Text" } },
      handler: async () => "better",
    });
    expect(registry.get("echo")!.description).toBe("Better echo");
    expect(registry.list()).toHaveLength(1);
  });
});
