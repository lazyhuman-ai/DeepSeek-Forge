import { readStoredHtmlPreview } from "./html-preview-window";

export function HtmlPreviewPage() {
  const id = new URLSearchParams(window.location.search).get("id") ?? "";
  const preview = id ? readStoredHtmlPreview(id) : null;

  if (!preview) {
    return (
      <main className="standalone-preview-missing">
        <h1>Preview expired</h1>
        <p>This HTML preview is no longer available. Return to DeepSeek-Forge and open it again.</p>
      </main>
    );
  }

  document.title = preview.title;
  return (
    <>
      <div className="standalone-preview-toolbar">
        <button type="button" onClick={() => {
          if (window.history.length > 1) window.history.back();
          else window.location.href = "/";
        }}>
          Back to DeepSeek-Forge
        </button>
      </div>
      <iframe
        className="standalone-html-preview-frame"
        title={preview.title}
        sandbox="allow-scripts"
        srcDoc={preview.html}
      />
    </>
  );
}
