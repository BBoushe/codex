/**
 * @fileoverview Zustand store for UI view-mode state.
 *
 * Controls which view is active in the side panel and main area.
 */

import { create } from "zustand";

export type SidePanelMode = "results" | "entity" | "browser";
export type MainAreaMode = "placeholder" | "heb" | "force";

interface UiState {
	sidePanelMode: SidePanelMode;
	mainAreaMode: MainAreaMode;
}

interface UiActions {
	setSidePanelMode: (mode: SidePanelMode) => void;
	setMainAreaMode: (mode: MainAreaMode) => void;
}

export const useUiStore = create<UiState & UiActions>((set) => ({
	sidePanelMode: "browser",
	mainAreaMode: "placeholder",

	setSidePanelMode: (sidePanelMode) => set({ sidePanelMode }),
	setMainAreaMode: (mainAreaMode) => set({ mainAreaMode }),
}));
