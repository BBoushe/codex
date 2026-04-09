/**
 * @fileoverview Hover tooltip for HEB graph nodes.
 *
 * Reads hoveredNodeId from graphStore and finds the matching node in hierarchyData.
 * Renders as a small floating card positioned via CSS in the top-left corner —
 * since D3 manages the exact mouse position, we use a fixed corner position
 * to avoid z-index / SVG clipping issues.
 */

import { useGraphStore } from "@/stores/graphStore";
import { formatChurnRate, formatDoa } from "@/lib/formatters";
import type { HierarchyNode } from "@/types/graph";
import { LabelBadge } from "@/components/search/labelBadge";
import { cn } from "@/lib/utils";

export function HebTooltip() {
	const hoveredNodeId = useGraphStore((s) => s.hoveredNodeId);
	const hierarchyData = useGraphStore((s) => s.hierarchyData);

	if (!hoveredNodeId || !hierarchyData) return null;

	const node = findNode(hierarchyData.tree, hoveredNodeId);
	if (!node) return null;

	const labelMap: Record<string, string> = {
		function: "Function",
		component: "Component",
		class: "Class",
		hook: "Hook",
		interface: "Interface",
		decorator: "Decorator",
		file: "File",
		directory: "Directory",
	};

	return (
		<div
			className={cn(
				"absolute bottom-3 left-3 pointer-events-none",
				"rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur-sm",
				"px-3 py-2 text-xs max-w-xs",
			)}
		>
			<div className="flex items-center gap-2 mb-1">
				<LabelBadge label={labelMap[node.type] ?? node.type} />
				<span className="text-[var(--color-text)] font-medium truncate">{node.name}</span>
			</div>
			<p className="text-[11px] text-[var(--color-text-muted)] font-mono">{node.module}</p>
			{node.churnRate !== undefined && (
				<p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
					churn: {formatChurnRate(node.churnRate)}
				</p>
			)}
			{node.doaScore !== undefined && (
				<p className="text-[10px] text-[var(--color-text-muted)]">
					DOA: {formatDoa(node.doaScore)}
				</p>
			)}
		</div>
	);
}

function findNode(tree: HierarchyNode, id: string): HierarchyNode | null {
	if (tree.id === id) return tree;
	for (const child of tree.children ?? []) {
		const found = findNode(child, id);
		if (found) return found;
	}
	return null;
}
