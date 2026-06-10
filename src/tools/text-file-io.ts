import { readFileSync, writeFileSync } from "node:fs";

export type TextEncoding = "utf8" | "utf16le";
export type LineEnding = "\n" | "\r\n";

export type TextFileRead = {
  content: string;
  encoding: TextEncoding;
  hadBom: boolean;
  lineEnding: LineEnding;
};

export type TextFileWriteOptions = {
  encoding?: TextEncoding;
  hadBom?: boolean;
  lineEnding?: LineEnding;
};

function looksUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  let oddNulls = 0;
  let evenNulls = 0;
  for (let index = 0; index < sample.length; index++) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 0) evenNulls++;
    else oddNulls++;
  }
  return oddNulls > 2 && oddNulls > evenNulls * 2;
}

function detectLineEnding(content: string): LineEnding {
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const lf = (content.match(/(?<!\r)\n/g)?.length ?? 0) + crlf;
  return crlf > 0 && crlf >= lf / 2 ? "\r\n" : "\n";
}

function normalizeForAgent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function applyLineEnding(content: string, lineEnding: LineEnding): string {
  const normalized = normalizeForAgent(content);
  return lineEnding === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

export function readTextFile(filePath: string): TextFileRead {
  const buffer = readFileSync(filePath);
  const utf16Bom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const utf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const encoding: TextEncoding = utf16Bom || looksUtf16Le(buffer) ? "utf16le" : "utf8";
  const hadBom = utf16Bom || utf8Bom;
  let content = encoding === "utf16le" ? buffer.toString("utf16le") : buffer.toString("utf8");
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const lineEnding = detectLineEnding(content);
  return {
    content: normalizeForAgent(content),
    encoding,
    hadBom,
    lineEnding,
  };
}

export function writeTextFile(filePath: string, content: string, options: TextFileWriteOptions = {}): void {
  const encoding = options.encoding ?? "utf8";
  const lineEnding = options.lineEnding ?? "\n";
  const withLineEndings = applyLineEnding(content, lineEnding);
  const bom = options.hadBom ? "\ufeff" : "";
  writeFileSync(filePath, bom + withLineEndings, encoding);
}
