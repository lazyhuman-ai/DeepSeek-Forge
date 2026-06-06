// ── HTTP client with retry and exponential backoff ──

import { createLogger } from "./logger.js";

const logger = createLogger("http-client");

export interface RetryOptions {
  /** Maximum number of retries (default 3). Total attempts = maxRetries + 1 */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms (default 30000) */
  maxDelayMs?: number;
  /** HTTP status codes that trigger a retry (default [429, 500, 502, 503, 504]) */
  retryOn?: number[];
  /** Per-attempt timeout in ms (default 120000) */
  timeoutMs?: number;
  /** External cancellation signal for the whole request sequence */
  signal?: AbortSignal;
  /** Optional observer for user-visible retry progress. */
  onRetry?: (event: {
    attempt: number;
    maxRetries: number;
    delayMs: number;
    reason: string;
    status?: number;
  }) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "signal" | "onRetry">> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryOn: [429, 500, 502, 503, 504],
  timeoutMs: 120_000,
};

// ── Per-attempt fetch with timeout ──

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) {
    const err = new Error("API request aborted");
    err.name = "AbortError";
    throw err;
  }

  const controller = new AbortController();
  const abortFromSignal = (): void => controller.abort();
  signal?.addEventListener("abort", abortFromSignal, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (signal?.aborted) {
        const abortErr = new Error("API request aborted");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      throw new Error(`API request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromSignal);
  }
}

// ── Sleep ──

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const err = new Error("API request aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      const err = new Error("API request aborted");
      err.name = "AbortError";
      reject(err);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Backoff computation ──

function computeBackoff(
  opts: Required<Omit<RetryOptions, "signal" | "onRetry">> & Pick<RetryOptions, "signal" | "onRetry">,
  attempt: number,
  retryAfterHeader: string | null,
): number {
  // On 429 with a valid Retry-After header, use that value
  if (retryAfterHeader !== null) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, opts.maxDelayMs);
    }
  }

  // Exponential backoff with ±25% jitter
  const exponential = opts.baseDelayMs * Math.pow(2, attempt);
  const withCap = Math.min(exponential, opts.maxDelayMs);
  const jitter = withCap * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

// ── fetchWithRetry ──

/**
 * Fetch a URL with configurable retry and exponential backoff.
 *
 * Retries on: network errors, timeouts, and matching HTTP status codes.
 * On 429, respects the Retry-After header if present.
 * When retries are exhausted on a matching status code, the error response
 * is returned as-is (so callers' existing `!resp.ok` handling works).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let attempt = 0;

  while (true) {
    if (opts.signal?.aborted) {
      const err = new Error("API request aborted");
      err.name = "AbortError";
      throw err;
    }

    let resp: Response;
    try {
      resp = await fetchWithTimeout(url, init, opts.timeoutMs, opts.signal);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      // Network errors and timeouts are retryable
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (attempt >= opts.maxRetries) {
        logger.error(
          `Request failed after ${attempt + 1} attempt(s): ${errorMsg}`,
        );
        throw err instanceof Error ? err : new Error(errorMsg);
      }
      const delay = computeBackoff(opts, attempt, null);
      opts.onRetry?.({
        attempt: attempt + 1,
        maxRetries: opts.maxRetries,
        delayMs: delay,
        reason: errorMsg,
      });
      logger.warn(
        `Request failed (${errorMsg}), retrying in ${delay}ms (attempt ${attempt + 1}/${opts.maxRetries})`,
      );
      await sleep(delay, opts.signal);
      attempt++;
      continue;
    }

    // Got a response — check if it's a retryable status code
    if (!resp.ok && opts.retryOn.includes(resp.status)) {
      if (attempt >= opts.maxRetries) {
        logger.error(
          `API returned ${resp.status} after ${attempt + 1} attempt(s), giving up`,
        );
        return resp; // Return error response so callers' !resp.ok checks work
      }
      const retryAfter = resp.headers.get("Retry-After");
      const delay = computeBackoff(opts, attempt, retryAfter);
      opts.onRetry?.({
        attempt: attempt + 1,
        maxRetries: opts.maxRetries,
        delayMs: delay,
        reason: `${resp.status} ${resp.statusText}`,
        status: resp.status,
      });
      logger.warn(
        `API returned ${resp.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${opts.maxRetries})`,
      );
      // Don't consume the body for retryable errors — next attempt is a fresh request
      await sleep(delay, opts.signal);
      attempt++;
      continue;
    }

    // Non-retryable status OR success — return as-is
    return resp;
  }
}
