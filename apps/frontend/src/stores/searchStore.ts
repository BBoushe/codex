/**
 * @fileoverview Zustand store for search state.
 *
 * Holds the current query, result, loading flag, and error.
 * The executeSearch action calls the API and updates state atomically.
 */

import { create } from "zustand";
import { hybridSearch } from "@/api/client";
import type { SearchResult } from "@/types/api";

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
		} else {
			set({ error: result.error.message, isLoading: false });
		}
	},

	clear: () => set({ query: "", result: null, error: null }),
}));
