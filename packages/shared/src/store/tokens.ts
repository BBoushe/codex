/**
 * Global token usage tracker.
 *
 * Any part of the pipeline (embedding, LLM synthesis) calls
 * `tokenTracker.add()` and the footer ticker re-renders automatically
 * via Zustand's reactive store.
 *
 * Usage:
 *   import { tokenTracker } from "../store/tokens.js";
 *   tokenTracker.add({ embedded: 1240, llmInput: 800, llmOutput: 312 });
 */

import { createStore } from "zustand/vanilla";

export interface TokenStats {
	/** Total source-code tokens sent to the embedding API. */
	embedded: number;
	/** Total prompt tokens sent to the LLM. */
	llmInput: number;
	/** Total completion tokens received from the LLM. */
	llmOutput: number;
}

interface TokenStore extends TokenStats {
	add: (delta: Partial<TokenStats>) => void;
	reset: () => void;
}

export const tokenStore = createStore<TokenStore>((set) => ({
	embedded: 0,
	llmInput: 0,
	llmOutput: 0,
	add: (delta) =>
		set((s) => ({
			embedded: s.embedded + (delta.embedded ?? 0),
			llmInput: s.llmInput + (delta.llmInput ?? 0),
			llmOutput: s.llmOutput + (delta.llmOutput ?? 0),
		})),
	reset: () => set({ embedded: 0, llmInput: 0, llmOutput: 0 }),
}));

/** Convenience accessor — call this from non-React code. */
export const tokenTracker = {
	add: (delta: Partial<TokenStats>) => tokenStore.getState().add(delta),
	reset: () => tokenStore.getState().reset(),
	get: () => tokenStore.getState(),
};
