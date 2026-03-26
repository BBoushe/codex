/**
 * @fileoverview Zustand store for the force-directed subgraph explorer.
 *
 * Separate from graphStore — different data shape and lifecycle.
 * fetchSubgraph replaces the entire subgraph; expandNode merges neighbors in.
 */

import { create } from "zustand";
import { fetchSubgraph as apiFetchSubgraph } from "@/api/client";
import type { SubgraphResponse, SizingMetric } from "@/types/api";

interface ForceState {
	subgraphData: SubgraphResponse | null;
	centerNodeId: string | null;
	showDevelopers: boolean;
	sizingMetric: SizingMetric;
	expandedNodeIds: Set<string>;
	highlightedNodeIds: Set<string>;
	isLoading: boolean;
	error: string | null;
}

interface ForceActions {
	fetchSubgraph: (nodeId: string, depth?: number) => Promise<void>;
	expandNode: (nodeId: string) => Promise<void>;
	recenterOn: (nodeId: string) => Promise<void>;
	setHighlightedNodes: (ids: string[]) => void;
	clearHighlightedNodes: () => void;
	toggleDevelopers: () => void;
	setSizingMetric: (metric: SizingMetric) => void;
	reset: () => void;
}

const initialState: ForceState = {
	subgraphData: null,
	centerNodeId: null,
	showDevelopers: false,
	sizingMetric: "loc",
	expandedNodeIds: new Set(),
	highlightedNodeIds: new Set(),
	isLoading: false,
	error: null,
};

export const useForceStore = create<ForceState & ForceActions>((set, get) => ({
	...initialState,

	fetchSubgraph: async (nodeId, depth = 2) => {
		set({ isLoading: true, error: null, centerNodeId: nodeId, expandedNodeIds: new Set() });

		const result = await apiFetchSubgraph(nodeId, depth);

		if (result.ok) {
			set({ subgraphData: result.data, isLoading: false });
		} else {
			set({ error: result.error.message, isLoading: false });
		}
	},

	expandNode: async (nodeId) => {
		const existing = get().subgraphData;
		if (!existing) return;

		const result = await apiFetchSubgraph(nodeId, 1);
		if (!result.ok) return;

		const existingIds = new Set(existing.nodes.map((n) => n.nodeId));
		const newNodes = result.data.nodes.filter((n) => !existingIds.has(n.nodeId));
		const allNodes = [...existing.nodes, ...newNodes];
		const allNodeIds = new Set(allNodes.map((n) => n.nodeId));

		const existingEdgeKeys = new Set(
			existing.edges.map((e) => `${e.source}-${e.target}-${e.type}`),
		);
		const newEdges = result.data.edges
			.filter((e) => allNodeIds.has(e.source) && allNodeIds.has(e.target))
			.filter((e) => !existingEdgeKeys.has(`${e.source}-${e.target}-${e.type}`));

		const expandedNodeIds = new Set(get().expandedNodeIds);
		expandedNodeIds.add(nodeId);

		set({
			subgraphData: {
				nodes: allNodes,
				edges: [...existing.edges, ...newEdges],
				centerNodeId: existing.centerNodeId,
			},
			expandedNodeIds,
		});
	},

	recenterOn: async (nodeId) => {
		await get().fetchSubgraph(nodeId, 2);
	},

	setHighlightedNodes: (ids) => set({ highlightedNodeIds: new Set(ids) }),

	clearHighlightedNodes: () => set({ highlightedNodeIds: new Set() }),

	toggleDevelopers: () => set((s) => ({ showDevelopers: !s.showDevelopers })),

	setSizingMetric: (sizingMetric) => set({ sizingMetric }),

	reset: () => set({ ...initialState, expandedNodeIds: new Set(), highlightedNodeIds: new Set() }),
}));
