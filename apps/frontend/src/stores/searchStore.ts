/**
 * @fileoverview Zustand store for search state.
 *
 * Holds the current query, result, loading flag, and error.
 * The executeSearch action calls the API and updates state atomically.
 */

import { create } from "zustand";
import { hybridSearch } from "@/api/client";
import type { SearchResult } from "@/types/api";
import { useGraphStore } from "./graphStore";
import { useForceStore } from "./forceStore";

interface SearchState {
	query: string;
	result: SearchResult | null;
	isLoading: boolean;
	error: string | null;
}

interface SearchActions {
	setQuery: (query: string) => void;
	executeSearch: (query: string) => Promise<void>;
	clear: () => void;
}

function extractNodeIds(result: SearchResult): string[] {
	switch (result.kind) {
		case "hybrid":
			return result.result.anchors?.map((a) => a.nodeId) ?? [];
		case "structural":
			return result.result.entities?.map((e) => e.nodeId).filter(Boolean) ?? [];
		case "path":
			return result.result.path?.map((p) => p.nodeId) ?? [];
		case "social":
			return [];
	}
}

export const useSearchStore = create<SearchState & SearchActions>((set) => ({
	query: "",
	result: null,
	isLoading: false,
	error: null,

	setQuery: (query) => set({ query }),

	executeSearch: async (query) => {
		set({ isLoading: true, error: null, query });

		const result = await hybridSearch(query);

		if (result.ok) {
			set({ result: result.data, isLoading: false });
			const nodeIds = extractNodeIds(result.data);
			useGraphStore.getState().setHighlightedNodes(nodeIds);
			useForceStore.getState().setHighlightedNodes(nodeIds);
		} else {
			set({ error: result.error.message, isLoading: false });
		}
	},

	clear: () => {
		set({ query: "", result: null, error: null });
		useGraphStore.getState().clearHighlightedNodes();
		useForceStore.getState().clearHighlightedNodes();
	},
}));
