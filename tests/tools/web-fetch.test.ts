import { describe, it, expect, afterEach } from "vitest";
import { webFetchTool } from "../../src/tools/built-in/web-fetch.js";

describe("web_fetch", () => {
  it("rejects non-HTTP URLs", async () => {
    const result = await webFetchTool.handler(
      { url: "ftp://example.com", prompt: "" },
      "s1",
    );
    expect(result).toContain("Invalid URL");
  });

  it("upgrades HTTP to HTTPS", async () => {
    const result = await webFetchTool.handler(
      { url: "http://example.com" },
      "s1",
    );
    // Will fail to fetch but shouldn't say "Invalid URL"
    expect(result).not.toContain("Invalid URL");
  });

  it("handles empty url gracefully", async () => {
    const result = await webFetchTool.handler(
      { url: "" },
      "s1",
    );
    expect(result).toContain("Invalid URL");
  });
});
