/**
 * @fileoverview Filter controls overlay for the HEB visualization.
 *
 * Renders edge type checkboxes, color mode radio, and module focus dropdown.
 * All controls write directly to graphStore.
 */

import { useGraphStore, ALL_EDGE_TYPES } from "@/stores/graphStore";
import { EDGE_TYPE_COLORS } from "@/lib/colors";
import type { ColorMode } from "@/types/graph";
import { cn } from "@/lib/utils";

const COLOR_MODES: { value: ColorMode; label: string }[] = [
	{ value: "module", label: "Module" },
	{ value: "churn", label: "Churn" },
	{ value: "doa", label: "DOA" },
];

export function HebControls() {
	const {
		edgeTypeFilter,
		colorMode,
		moduleFilter,
		hierarchyData,
		setEdgeTypeFilter,
		setColorMode,
		setModuleFilter,
	} = useGraphStore();

	function toggleEdgeType(type: string) {
		if (edgeTypeFilter.includes(type)) {
			setEdgeTypeFilter(edgeTypeFilter.filter((t) => t !== type));
		} else {
			setEdgeTypeFilter([...edgeTypeFilter, type]);
		}
	}

	// Collect unique module names from the hierarchy data
	const modules = collectModules(hierarchyData?.tree.children ?? []);

	return (
		<div
			className={cn(
				"absolute top-3 right-3 w-44 rounded-lg border border-[--color-border]",
				"bg-[--color-surface]/90 backdrop-blur-sm p-3",
				"text-xs flex flex-col gap-3",
			)}
		>
			{/* Edge types */}
			<div>
				<p className="font-medium text-[--color-text-muted] uppercase tracking-wider mb-1.5">
					Edges
				</p>
				<div className="flex flex-col gap-1">
					{ALL_EDGE_TYPES.map((type) => (
						<label key={type} className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={edgeTypeFilter.includes(type)}
								onChange={() => toggleEdgeType(type)}
								className="hidden"
							/>
							<span
								className={cn(
									"w-3 h-3 rounded-sm border shrink-0 flex items-center justify-center transition-colors",
									edgeTypeFilter.includes(type)
										? "border-transparent"
										: "border-[--color-border] bg-transparent",
								)}
								style={
									edgeTypeFilter.includes(type)
										? {
												backgroundColor: EDGE_TYPE_COLORS[type] ?? EDGE_TYPE_COLORS["default"]!,
											}
										: {}
								}
							>
								{edgeTypeFilter.includes(type) && (
									<svg width="8" height="8" viewBox="0 0 8 8" fill="none">
										<path d="M1 4l2 2 4-4" stroke="#0f1117" strokeWidth="1.5" strokeLinecap="round" />
									</svg>
								)}
							</span>
							<span className="text-[--color-text-muted]">{type}</span>
						</label>
					))}
				</div>
			</div>

			{/* Color mode */}
			<div>
				<p className="font-medium text-[--color-text-muted] uppercase tracking-wider mb-1.5">
					Color
				</p>
				<div className="flex gap-1">
					{COLOR_MODES.map((m) => (
						<button
							key={m.value}
							onClick={() => setColorMode(m.value)}
							className={cn(
								"flex-1 py-0.5 rounded text-[10px] transition-colors",
								colorMode === m.value
									? "bg-[--color-accent] text-white"
									: "text-[--color-text-muted] hover:text-[--color-text] border border-[--color-border]",
							)}
						>
							{m.label}
						</button>
					))}
				</div>
			</div>

			{/* Module focus */}
			{modules.length > 0 && (
				<div>
					<p className="font-medium text-[--color-text-muted] uppercase tracking-wider mb-1.5">
						Focus
					</p>
					<select
						value={moduleFilter ?? ""}
						onChange={(e) => setModuleFilter(e.target.value || null)}
						className={cn(
							"w-full py-1 px-1.5 rounded border border-[--color-border]",
							"bg-[--color-surface-2] text-[--color-text] text-[10px]",
							"focus:outline-none focus:border-[--color-accent]",
						)}
					>
						<option value="">All modules</option>
						{modules.map((m) => (
							<option key={m} value={m}>
								{m}
							</option>
						))}
					</select>
				</div>
			)}
		</div>
	);
}

function collectModules(nodes: import("@/types/graph").HierarchyNode[]): string[] {
	const seen = new Set<string>();
	for (const n of nodes) {
		if (n.module && n.module !== "root") seen.add(n.module);
	}
	return [...seen].sort();
}
