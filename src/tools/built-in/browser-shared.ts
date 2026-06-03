import type { LinkInfo } from "../../runtimes/browser/browser-runtime.js";

export type BrowserPageInfo = {
  title: string;
  url: string;
  textPreview: string;
};

export type BrowserToolRuntime = {
  createTab(sessionId: string): Promise<string>;
  closeTab(sessionId: string): Promise<void>;
  navigate(sessionId: string, url: string): Promise<void>;
  click(sessionId: string, selector: string): Promise<void>;
  typeText(sessionId: string, selector: string, text: string): Promise<void>;
  pressKey(sessionId: string, key: string): Promise<void>;
  scroll(sessionId: string, deltaY: number): Promise<void>;
  scrollToBottom(sessionId: string): Promise<void>;
  waitForSelector(sessionId: string, selector: string, timeoutMs?: number): Promise<boolean>;
  extract(sessionId: string, selector?: string): Promise<string>;
  extractLinks(sessionId: string, selector?: string): Promise<LinkInfo[]>;
  screenshot(sessionId: string): Promise<string>;
  currentPage(sessionId: string): Promise<BrowserPageInfo>;
};

const runtimes = new Map<string, BrowserToolRuntime>();
const FALLBACK_DEFAULT_RUNTIME_NAME = "webridge";
let defaultRuntimeName: string | null = FALLBACK_DEFAULT_RUNTIME_NAME;

export function setBrowserRuntimeForTools(
  name: string,
  runtime: BrowserToolRuntime | null,
): void {
  if (runtime === null) {
    runtimes.delete(name);
    if (defaultRuntimeName === name) {
      defaultRuntimeName = FALLBACK_DEFAULT_RUNTIME_NAME;
    }
    return;
  }
  runtimes.set(name, runtime);
}

export function setDefaultBrowserRuntimeForTools(name: string): void {
  defaultRuntimeName = name;
}

export function clearBrowserRuntimesForTools(): void {
  runtimes.clear();
  defaultRuntimeName = FALLBACK_DEFAULT_RUNTIME_NAME;
}

export function getBrowserRuntimeForTools(
  runtimeName?: string,
): BrowserToolRuntime | null {
  const name = runtimeName ?? defaultRuntimeName;
  if (!name) return null;
  return runtimes.get(name) ?? null;
}

export function listBrowserRuntimeNamesForTools(): string[] {
  return [...runtimes.keys()];
}
