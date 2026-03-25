/**
 * @fileoverview Zustand store for the selected entity and its expanded context.
 */

import { create } from "zustand";
import { fetchEntityContext } from "@/api/client";
import type { ExpandedContext } from "@/types/api";

interface EntityState {
	selectedNodeId: string | null;
	expandedContext: ExpandedContext | null;
	isLoading: boolean;
	error: string | null;
}

interface EntityActions {
	selectEntity: (nodeId: string) => Promise<void>;
	clearSelection: () => void;
}

export const useEntityStore = create<EntityState & EntityActions>((set) => ({
	selectedNodeId: null,
	expandedContext: null,
	isLoading: false,
	error: null,

	selectEntity: async (nodeId) => {
		set({ selectedNodeId: nodeId, isLoading: true, error: null, expandedContext: null });

		const result = await fetchEntityContext(nodeId);

		if (result.ok) {
			set({ expandedContext: result.data, isLoading: false });
		} else {
			set({ error: result.error.message, isLoading: false });
		}
	},

	clearSelection: () =>
		set({ selectedNodeId: null, expandedContext: null, error: null }),
}));
