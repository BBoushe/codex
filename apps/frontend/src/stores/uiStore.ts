/**
 * @fileoverview Zustand store for UI view-mode state.
 *
 * Controls which view is active in the side panel and main area,
 * plus the left chat panel visibility and theme preference.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SidePanelMode = "entity" | "browser" | "risk";
export type MainAreaMode = "placeholder" | "heb" | "force";
export type ThemeMode = "dark" | "light" | "system";

interface UiState {
	sidePanelMode: SidePanelMode;
	mainAreaMode: MainAreaMode;
	leftPanelOpen: boolean;
	themeMode: ThemeMode;
}

interface UiActions {
	setSidePanelMode: (mode: SidePanelMode) => void;
	setMainAreaMode: (mode: MainAreaMode) => void;
	setLeftPanelOpen: (open: boolean) => void;
	toggleLeftPanel: () => void;
	setThemeMode: (mode: ThemeMode) => void;
}

export const useUiStore = create<UiState & UiActions>()(
	persist(
		(set) => ({
			sidePanelMode: "browser",
			mainAreaMode: "placeholder",
			leftPanelOpen: false,
			themeMode: "dark",

			setSidePanelMode: (sidePanelMode) => set({ sidePanelMode }),
			setMainAreaMode: (mainAreaMode) => set({ mainAreaMode }),
			setLeftPanelOpen: (leftPanelOpen) => set({ leftPanelOpen }),
			toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
			setThemeMode: (themeMode) => set({ themeMode }),
		}),
		{
			name: "codex-ui",
			partialize: (s) => ({ themeMode: s.themeMode }),
		},
	),
);
