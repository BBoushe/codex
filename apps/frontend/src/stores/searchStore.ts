/**
 * @fileoverview Zustand store for search state and history.
 *
 * Holds the current query, result, loading flag, error, and a history of past
 * results. executeSearch auto-opens the left chat panel on every search.
 */

import { create } from "zustand";
import { hybridSearch } from "@/api/client";
import type { SearchResult } from "@/types/api";
import { useGraphStore } from "./graphStore";
import { useForceStore } from "./forceStore";
import { useUiStore } from "./uiStore";
import { useSettingsStore } from "./settingsStore";

export interface HistoryEntry {
	id: string;
	query: string;
	result: SearchResult;
	timestamp: number;
}

interface SearchState {
	query: string;
	result: SearchResult | null;
	isLoading: boolean;
	error: string | null;
	history: HistoryEntry[];
}

interface SearchActions {
	setQuery: (query: string) => void;
	executeSearch: (query: string) => Promise<void>;
	restoreHistoryEntry: (entry: HistoryEntry) => void;
	removeHistoryEntry: (id: string) => void;
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
	history: [],

	setQuery: (query) => set({ query }),

	executeSearch: async (query) => {
		set({ isLoading: true, error: null, query });

		// Clear stale highlights immediately
		useGraphStore.getState().clearHighlightedNodes();
		useForceStore.getState().clearHighlightedNodes();

		// Auto-open the left panel
		useUiStore.getState().setLeftPanelOpen(true);

		const { budget, model } = useSettingsStore.getState();
		const result = await hybridSearch(query, { budget, model: model || undefined });

		if (result.ok) {
			const entry: HistoryEntry = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
				query,
				result: result.data,
				timestamp: Date.now(),
			};
			set((s) => ({
				result: result.data,
				isLoading: false,
				history: [entry, ...s.history].slice(0, 50),
			}));
			const nodeIds = extractNodeIds(result.data);
			useGraphStore.getState().setHighlightedNodes(nodeIds);
			useForceStore.getState().setHighlightedNodes(nodeIds);
		} else {
			set({ error: result.error.message, isLoading: false });
		}
	},

	restoreHistoryEntry: (entry) => {
		set({ query: entry.query, result: entry.result, error: null });
		const nodeIds = extractNodeIds(entry.result);
		useGraphStore.getState().setHighlightedNodes(nodeIds);
		useForceStore.getState().setHighlightedNodes(nodeIds);
	},

	removeHistoryEntry: (id) => {
		set((s) => ({ history: s.history.filter((e) => e.id !== id) }));
	},

	clear: () => {
		set({ query: "", result: null, error: null });
		useGraphStore.getState().clearHighlightedNodes();
		useForceStore.getState().clearHighlightedNodes();
	},
}));
