import { useMemo } from "react";
import { RichText } from "./RichText";
import { extractRenderableHtml, toPreviewDocument } from "./html-rendering";
import { openHtmlPreviewDocument } from "./html-preview-window";

export function AssistantContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const candidate = useMemo(() => extractRenderableHtml(text), [text]);
  if (!candidate) return <RichText text={text} />;

  const before = text.slice(0, candidate.sourceStart).trim();
  const after = text.slice(candidate.sourceEnd).trim();

  return (
    <div className="assistant-content">
      {before ? <RichText text={before} /> : null}
      <InlineHtmlPreview
        html={candidate.html}
        label={candidate.kind === "document" ? "HTML document preview" : "HTML preview"}
        streaming={streaming}
      />
      {after ? <RichText text={after} /> : null}
    </div>
  );
}

function InlineHtmlPreview(props: { html: string; label: string; streaming: boolean }) {
  const srcDoc = useMemo(() => toPreviewDocument(props.html), [props.html]);

  async function copyHtml() {
    await navigator.clipboard?.writeText(props.html);
  }

  function openPreview() {
    openHtmlPreviewDocument(srcDoc, props.label);
  }

  return (
    <section className="inline-html-preview">
      <div className="inline-html-preview-head">
        <div>
          <strong>{props.label}</strong>
          <p>{props.streaming ? "Rendering live in a sandboxed iframe." : "Rendered in a sandboxed iframe."}</p>
        </div>
        <div className="inline-html-preview-actions">
          <button type="button" onClick={openPreview}>Open tab</button>
          <button type="button" onClick={() => void copyHtml()}>Copy HTML</button>
        </div>
      </div>
      <iframe
        className="inline-html-preview-frame"
        title={props.label}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
      />
      <details className="inline-html-source">
        <summary>View source</summary>
        <pre>{props.html}</pre>
      </details>
    </section>
  );
}
