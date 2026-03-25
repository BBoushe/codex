/**
 * @fileoverview Typed API client for the CODEX backend.
 *
 * All functions return ApiResult<T> — a discriminated union that forces callers
 * to handle both success and error cases. Each request has a 30s timeout via
 * AbortController.
 *
 * The Vite dev-server proxy maps /api/* → http://localhost:3000/*,
 * so no base URL config is needed here.
 */

import type {
	ApiError,
	ApiResult,
	ContextBudget,
	ExpandedContext,
	FileTreeNode,
	SearchResult,
} from "@/types/api";
import type { HierarchyResponse } from "@/types/graph";

const TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function timeoutSignal(): AbortSignal {
	return AbortSignal.timeout(TIMEOUT_MS);
}

async function parseJson<T>(response: Response): Promise<ApiResult<T>> {
	if (!response.ok) {
		let message = `HTTP ${response.status}`;
		try {
			const body = (await response.json()) as { message?: string; error?: string };
			message = body.message ?? body.error ?? message;
		} catch {
			// ignore parse error — use the HTTP status message
		}
		const error: ApiError = { message, status: response.status };
		return { ok: false, error };
	}

	try {
		const data = (await response.json()) as T;
		return { ok: true, data };
	} catch {
		return { ok: false, error: { message: "Failed to parse response JSON", status: 0 } };
	}
}

async function request<T>(
	input: RequestInfo,
	init?: RequestInit,
): Promise<ApiResult<T>> {
	try {
		const response = await fetch(input, {
			...init,
			signal: timeoutSignal(),
		});
		return parseJson<T>(response);
	} catch (err) {
		const message =
			err instanceof DOMException && err.name === "TimeoutError"
				? "Request timed out"
				: err instanceof Error
					? err.message
					: "Network error";
		return { ok: false, error: { message, status: 0 } };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API functions
// ─────────────────────────────────────────────────────────────────────────────

export interface HybridSearchOptions {
	topK?: number;
	budget?: ContextBudget;
}

/**
 * Runs an intent-classified hybrid RAG search.
 * Routes to structural Cypher, social developer lookup, or vector+graph+LLM.
 */
export function hybridSearch(
	query: string,
	options?: HybridSearchOptions,
): Promise<ApiResult<SearchResult>> {
	return request<SearchResult>("/api/search/hybrid", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query, ...options }),
	});
}

/**
 * Fetches the full expanded context for a single entity node.
 * Returns null from the backend when the nodeId is not found (404).
 */
export function fetchEntityContext(
	nodeId: string,
): Promise<ApiResult<ExpandedContext>> {
	return request<ExpandedContext>(`/api/entity/${encodeURIComponent(nodeId)}`);
}

/**
 * Fetches the hierarchy tree + dependency edges for the HEB visualization.
 */
export function fetchHierarchy(): Promise<ApiResult<HierarchyResponse>> {
	return request<HierarchyResponse>("/api/graph/hierarchy");
}

/**
 * Fetches the flat file tree for the file browser.
 */
export function fetchBrowseTree(): Promise<ApiResult<FileTreeNode[]>> {
	return request<FileTreeNode[]>("/api/browse/tree");
}

/**
 * Health check — confirms Neo4j and ChromaDB are reachable.
 */
export function healthCheck(): Promise<ApiResult<{ status: string; neo4j: boolean; chroma: boolean }>> {
	return request("/api/health");
}
