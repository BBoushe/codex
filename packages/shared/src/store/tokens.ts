/**
 * Global token usage tracker.
 *
 * Tracks two counters simultaneously:
 *   - Session totals: cumulative across all queries since process start
 *   - Current query: resets at the start of each query via `resetCurrentQuery()`
 *
 * Usage:
 *   import { tokenTracker } from "../store/tokens.js";
 *   tokenTracker.resetCurrentQuery();            // call at start of runSearch()
 *   tokenTracker.add({ embedded: 1240 });        // call after embedding
 *   tokenTracker.add({ llmInput: 800, llmOutput: 312 }); // call after LLM
 */

import { createStore } from "zustand/vanilla";

export interface TokenStats {
	/** Tokens sent to the embedding API. */
	embedded: number;
	/** Prompt tokens sent to the LLM. */
	llmInput: number;
	/** Completion tokens received from the LLM. */
	llmOutput: number;
}

interface TokenStore extends TokenStats {
	// Per-current-query stats (reset via resetCurrentQuery)
	currentEmbedded: number;
	currentLlmInput: number;
	currentLlmOutput: number;
	/** Add tokens to both session totals and current-query counters. */
	add: (delta: Partial<TokenStats>) => void;
	/** Zero the current-query counters. Call at the start of each query. */
	resetCurrentQuery: () => void;
	/** Zero everything (session + current). */
	reset: () => void;
}

export const tokenStore = createStore<TokenStore>((set) => ({
	embedded: 0,
	llmInput: 0,
	llmOutput: 0,
	currentEmbedded: 0,
	currentLlmInput: 0,
	currentLlmOutput: 0,

	add: (delta) =>
		set((s) => ({
			embedded: s.embedded + (delta.embedded ?? 0),
			llmInput: s.llmInput + (delta.llmInput ?? 0),
			llmOutput: s.llmOutput + (delta.llmOutput ?? 0),
			currentEmbedded: s.currentEmbedded + (delta.embedded ?? 0),
			currentLlmInput: s.currentLlmInput + (delta.llmInput ?? 0),
			currentLlmOutput: s.currentLlmOutput + (delta.llmOutput ?? 0),
		})),

	resetCurrentQuery: () =>
		set({ currentEmbedded: 0, currentLlmInput: 0, currentLlmOutput: 0 }),

	reset: () =>
		set({
			embedded: 0,
			llmInput: 0,
			llmOutput: 0,
			currentEmbedded: 0,
			currentLlmInput: 0,
			currentLlmOutput: 0,
		}),
}));

/** Convenience accessor — call this from non-React code. */
export const tokenTracker = {
	add: (delta: Partial<TokenStats>) => tokenStore.getState().add(delta),
	resetCurrentQuery: () => tokenStore.getState().resetCurrentQuery(),
	reset: () => tokenStore.getState().reset(),
	get: () => tokenStore.getState(),
};
