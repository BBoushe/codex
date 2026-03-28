/**
 * @fileoverview Zustand store for user-configurable search settings.
 *
 * Provider, context budget, and model are persisted in localStorage.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ContextBudget } from "@/types/api";

export type LlmProvider = "siliconflow" | "openai" | "anthropic" | "gemini";

interface SettingsState {
	provider: LlmProvider;
	budget: ContextBudget;
	model: string;
}

interface SettingsActions {
	setProvider: (p: LlmProvider) => void;
	setBudget: (b: ContextBudget) => void;
	setModel: (m: string) => void;
}

export const useSettingsStore = create<SettingsState & SettingsActions>()(
	persist(
		(set) => ({
			provider: "siliconflow",
			budget: "standard",
			model: "",

			setProvider: (provider) => set({ provider }),
			setBudget: (budget) => set({ budget }),
			setModel: (model) => set({ model }),
		}),
		{ name: "codex-settings" },
	),
);
