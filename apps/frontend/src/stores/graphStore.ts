/**
 * @fileoverview Zustand store for graph visualization state.
 *
 * Manages the HEB hierarchy data, active filters, hovered node,
 * and color mode. The fetchHierarchy action populates the store
 * from the backend endpoint.
 */

import { create } from "zustand";
import { fetchHierarchy } from "@/api/client";
import type {
	HierarchyResponse,
	ColorMode,
	ShapeMode,
	FocusMode,
} from "@/types/graph";

/** All edge types shown in the HEB filter panel. */
export const ALL_EDGE_TYPES = [
	"CALLS",
	"IMPORTS",
	"RENDERS",
	"USES_HOOK",
	"INHERITS",
	"IMPLEMENTS",
	"EXPORTS",
	"PASSES_PROP",
	"SETS_STATE",
	"DECORATED_BY",
	"OVERRIDES",
] as const;
export type EdgeType = (typeof ALL_EDGE_TYPES)[number];

interface GraphState {
	hierarchyData: HierarchyResponse | null;
	hoveredNodeId: string | null;
	edgeTypeFilter: string[];
	moduleFilter: string | null;
	colorMode: ColorMode;
	shapeMode: ShapeMode;
	zoomScale: number;
	focusMode: FocusMode;
	highlightedNodeIds: Set<string>;
	isLoading: boolean;
	error: string | null;
}

interface GraphActions {
	fetchHierarchy: () => Promise<void>;
	setHoveredNode: (nodeId: string | null) => void;
	setEdgeTypeFilter: (types: string[]) => void;
	setModuleFilter: (module: string | null) => void;
	setColorMode: (mode: ColorMode) => void;
	setShapeMode: (mode: ShapeMode) => void;
	setZoomScale: (scale: number) => void;
	setFocusMode: (mode: FocusMode) => void;
	setHighlightedNodes: (ids: string[]) => void;
	clearHighlightedNodes: () => void;
}

export const useGraphStore = create<GraphState & GraphActions>((set) => ({
	hierarchyData: null,
	hoveredNodeId: null,
	edgeTypeFilter: [...ALL_EDGE_TYPES],
	moduleFilter: null,
	colorMode: "module",
	shapeMode: "cluster",
	zoomScale: 1,
	focusMode: "all",
	highlightedNodeIds: new Set(),
	isLoading: false,
	error: null,

	fetchHierarchy: async () => {
		set({ isLoading: true, error: null });

		const result = await fetchHierarchy();

		if (result.ok) {
			set({ hierarchyData: result.data, isLoading: false });
		} else {
			set({ error: result.error.message, isLoading: false });
		}
	},

	setHoveredNode: (hoveredNodeId) => set({ hoveredNodeId }),
	setEdgeTypeFilter: (edgeTypeFilter) => set({ edgeTypeFilter }),
	setModuleFilter: (moduleFilter) => set({ moduleFilter }),
	setColorMode: (colorMode) => set({ colorMode }),
	setShapeMode: (shapeMode) => set({ shapeMode }),
	setZoomScale: (zoomScale) =>
		set({ zoomScale: Math.max(0.5, Math.min(2.5, zoomScale)) }),
	setFocusMode: (focusMode) => set({ focusMode }),
	setHighlightedNodes: (ids) => set({ highlightedNodeIds: new Set(ids) }),
	clearHighlightedNodes: () => set({ highlightedNodeIds: new Set() }),
}));
