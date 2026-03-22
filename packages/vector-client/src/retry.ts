/**
 * @fileoverview Generic retry utility with exponential backoff and jitter.
 *
 * Designed for wrapping embedding API calls that may fail transiently
 * due to rate limiting (429) or server errors (5xx).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryOptions {
	/** Maximum number of retry attempts (default 3). */
	maxRetries?: number;
	/** Base delay in ms before first retry (default 1000). */
	baseDelayMs?: number;
	/** Maximum delay cap in ms (default 10000). */
	maxDelayMs?: number;
	/** Called before each retry with attempt number and delay. */
	onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** HTTP status codes that warrant a retry. */
const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

/** HTTP status codes that indicate a client error — do NOT retry. */
const NON_RETRYABLE_STATUSES = [400, 401, 403, 404];

/** Max jitter added to each delay (ms). */
const JITTER_MAX_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts an HTTP status code from an error message, if present.
 * Embedding providers throw errors like: "[siliconflow] Embedding API error 429: ..."
 */
function extractStatusCode(error: Error): number | null {
	const match = error.message.match(/\b([345]\d{2})\b/);
	return match?.[1] ? parseInt(match[1], 10) : null;
}

/** Returns true if the error is likely a transient failure worth retrying. */
function isRetryable(error: Error): boolean {
	const status = extractStatusCode(error);

	// If we can identify a non-retryable status, abort immediately
	if (status !== null && NON_RETRYABLE_STATUSES.includes(status)) {
		return false;
	}

	// If we can identify a retryable status, retry
	if (status !== null && RETRYABLE_STATUSES.includes(status)) {
		return true;
	}

	// Network errors (no status code) are typically transient
	const msg = error.message.toLowerCase();
	if (
		msg.includes("econnrefused") ||
		msg.includes("econnreset") ||
		msg.includes("etimedout") ||
		msg.includes("fetch failed") ||
		msg.includes("network")
	) {
		return true;
	}

	// Unknown errors — don't retry by default
	return false;
}

/** Computes delay with exponential backoff + jitter. */
function computeDelay(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
): number {
	const exponential = baseDelayMs * Math.pow(2, attempt);
	const jitter = Math.random() * JITTER_MAX_MS;
	return Math.min(exponential + jitter, maxDelayMs);
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps an async function with retry logic using exponential backoff + jitter.
 *
 * @param fn - The async function to execute and potentially retry.
 * @param options - Retry configuration.
 * @returns The result of the function on success.
 * @throws The last error if all retries are exhausted.
 *
 * @example
 * const result = await withRetry(
 *   () => provider.embedBatch(texts),
 *   { maxRetries: 3, onRetry: (n, ms) => console.log(`Retry ${n} in ${ms}ms`) }
 * );
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	options?: RetryOptions,
): Promise<T> {
	const maxRetries = options?.maxRetries ?? 3;
	const baseDelayMs = options?.baseDelayMs ?? 1000;
	const maxDelayMs = options?.maxDelayMs ?? 10000;
	const onRetry = options?.onRetry;

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			lastError = error;

			// Don't retry on the last attempt or non-retryable errors
			if (attempt >= maxRetries || !isRetryable(error)) {
				throw error;
			}

			const delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs);
			onRetry?.(attempt + 1, delayMs, error);
			await sleep(delayMs);
		}
	}

	// Unreachable, but TypeScript needs it
	throw lastError ?? new Error("withRetry: unexpected state");
}
