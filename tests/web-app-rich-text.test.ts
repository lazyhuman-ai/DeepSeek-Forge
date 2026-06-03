import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichText } from "../web/src/RichText.js";
import { extractRenderableHtml, toPreviewDocument } from "../web/src/html-rendering.js";

function render(text: string): string {
  return renderToStaticMarkup(createElement(RichText, { text }));
}

describe("web app rich text rendering", () => {
  it("renders markdown, GFM tables, code blocks, and safe HTML", () => {
    const html = render([
      "## Report",
      "",
      "- one",
      "- two",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "<strong>safe html</strong>",
    ].join("\n"));

    expect(html).toContain("<h2>Report</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain("const x = 1");
    expect(html).toContain("<strong>safe html</strong>");
    expect(html).toContain("Copy");
  });

  it("sanitizes scripts, event handlers, and unsafe links", () => {
    const html = render('<script>alert(1)</script><a href="javascript:alert(1)" onclick="bad()">bad</a>');

    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(">bad</a>");
  });

  it("detects assistant HTML documents for inline sandbox previews", () => {
    const candidate = extractRenderableHtml([
      "Here is the preview:",
      "<!doctype html>",
      "<html><body><main><h1>Hello</h1></main></body></html>",
    ].join("\n"));

    expect(candidate?.kind).toBe("document");
    expect(candidate?.html).toContain("<h1>Hello</h1>");
  });

  it("wraps fenced HTML fragments for iframe srcDoc previews", () => {
    const candidate = extractRenderableHtml([
      "```html",
      "<style>main{color:red}</style><main><h1>Hello</h1></main>",
      "```",
    ].join("\n"));

    expect(candidate?.kind).toBe("fragment");
    const srcDoc = toPreviewDocument(candidate!.html);
    expect(srcDoc).toContain("<!doctype html>");
    expect(srcDoc).toContain("<main><h1>Hello</h1></main>");
  });

  it("detects prose-wrapped assistant HTML fragments for inline sandbox previews", () => {
    const candidate = extractRenderableHtml([
      "Here is the rendered result:",
      "",
      '<div style="background:#111;color:white;padding:20px">',
      '  <section><h1>Human Evolution</h1><p>Rendered directly in chat.</p></section>',
      "</div>",
      "",
      "The file was also saved locally.",
    ].join("\n"));

    expect(candidate?.kind).toBe("fragment");
    expect(candidate?.html).toContain("<h1>Human Evolution</h1>");
    expect(candidate?.sourceStart).toBeGreaterThan(0);
    expect(candidate?.sourceEnd).toBeLessThan("Here is the rendered result:\n\n<div style=\"background:#111;color:white;padding:20px\">\n  <section><h1>Human Evolution</h1><p>Rendered directly in chat.</p></section>\n</div>\n\nThe file was also saved locally.".length);
  });
});
