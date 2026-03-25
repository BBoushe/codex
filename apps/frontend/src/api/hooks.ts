/**
 * @fileoverview React hooks wrapping the API client.
 *
 * These hooks manage loading/error state locally. They do NOT sync to Zustand —
 * callers are responsible for dispatching results to stores if needed.
 * This keeps the hooks reusable without coupling them to any specific store slice.
 */

import { useState, useCallback } from "react";
import { hybridSearch, fetchEntityContext } from "./client";
import type { ApiError, ExpandedContext, SearchResult } from "@/types/api";

// ─────────────────────────────────────────────────────────────────────────────
// useSearch
// ─────────────────────────────────────────────────────────────────────────────

export interface UseSearchReturn {
	/** Execute a search query. Resolves when the result is available. */
	execute: (query: string) => Promise<SearchResult | null>;
	isLoading: boolean;
	error: ApiError | null;
}

/** Hook for running hybrid RAG searches. */
export function useSearch(): UseSearchReturn {
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<ApiError | null>(null);

	const execute = useCallback(async (query: string): Promise<SearchResult | null> => {
		setIsLoading(true);
		setError(null);

		const result = await hybridSearch(query);

		setIsLoading(false);

		if (!result.ok) {
			setError(result.error);
			return null;
		}

		return result.data;
	}, []);

	return { execute, isLoading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// useEntityContext
// ─────────────────────────────────────────────────────────────────────────────

export interface UseEntityContextReturn {
	fetchContext: (nodeId: string) => Promise<ExpandedContext | null>;
	isLoading: boolean;
	error: ApiError | null;
}

/** Hook for fetching entity expanded context. */
export function useEntityContext(): UseEntityContextReturn {
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<ApiError | null>(null);

	const fetchContext = useCallback(async (nodeId: string): Promise<ExpandedContext | null> => {
		setIsLoading(true);
		setError(null);

		const result = await fetchEntityContext(nodeId);

		setIsLoading(false);

		if (!result.ok) {
			setError(result.error);
			return null;
		}

		return result.data;
	}, []);

	return { fetchContext, isLoading, error };
}
