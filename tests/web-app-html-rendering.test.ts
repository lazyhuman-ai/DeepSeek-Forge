import { describe, expect, it } from "vitest";
import { extractRenderableHtml, toPreviewDocument } from "../web/src/html-rendering.js";

describe("web app HTML document rendering detection", () => {
  it("detects a complete HTML document inside an assistant message", () => {
    const text = [
      "Here is the preview:",
      "<!doctype html>",
      "<html><head><style>.hero{color:red}</style></head><body><main class=\"hero\">Hello</main></body></html>",
      "Notes after.",
    ].join("\n");

    const candidate = extractRenderableHtml(text);

    expect(candidate).toMatchObject({ kind: "document" });
    expect(candidate?.html).toContain("<style>");
    expect(text.slice(candidate?.sourceEnd ?? 0)).toContain("Notes after.");
  });

  it("detects fenced renderable HTML when it includes page-level styling", () => {
    const candidate = extractRenderableHtml([
      "```html",
      "<style>.card{padding:24px}</style><section class=\"card\">Rendered</section>",
      "```",
    ].join("\n"));

    expect(candidate).toMatchObject({ kind: "fragment" });
    expect(candidate?.html).toContain("<section");
  });

  it("does not turn ordinary safe inline HTML into a document preview", () => {
    const candidate = extractRenderableHtml("This is <strong>important</strong> text.");

    expect(candidate).toBeNull();
  });

  it("wraps fragments in a standalone preview document", () => {
    const doc = toPreviewDocument("<style>body{margin:0}</style><main>Hi</main>");

    expect(doc).toContain("<!doctype html>");
    expect(doc).toContain("<body>");
    expect(doc).toContain("<main>Hi</main>");
  });
});
