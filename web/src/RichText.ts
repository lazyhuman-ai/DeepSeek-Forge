import { createElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return textFromNode(props?.children ?? "");
  }
  return "";
}

function copyText(text: string): void {
  const host = globalThis as typeof globalThis & {
    navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } };
  };
  void host.navigator?.clipboard?.writeText?.(text);
}

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      ["target"],
      ["rel"],
    ],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-[\w-]+$/],
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
};

const components: Components = {
  a({ children, href, ...props }) {
    return createElement("a", { ...props, href, target: "_blank", rel: "noreferrer" }, children);
  },
  pre({ children }) {
    const text = textFromNode(children).replace(/\n$/, "");
    return createElement(
      "div",
      { className: "rich-code-frame" },
      createElement(
        "button",
        {
          type: "button",
          className: "copy-code",
          onClick: () => copyText(text),
        },
        "Copy",
      ),
      createElement("pre", null, children),
    );
  },
  table({ children }) {
    return createElement("div", { className: "rich-table-wrap" }, createElement("table", null, children));
  },
};

export function RichText({ text, className = "" }: { text: string; className?: string }) {
  return createElement(
    "div",
    { className: `rich-text ${className}` },
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeRaw, [rehypeSanitize, sanitizeSchema]],
        components,
      },
      text,
    ),
  );
}
