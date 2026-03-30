/**
 * @fileoverview Filter controls overlay for the HEB visualization.
 *
 * Renders edge type checkboxes, color mode radio, and module focus dropdown.
 * All controls write directly to graphStore.
 */

import { useGraphStore, ALL_EDGE_TYPES } from "@/stores/graphStore";
import { EDGE_TYPE_COLORS } from "@/lib/colors";
import type { ColorMode, ShapeMode, FocusMode } from "@/types/graph";
import { cn } from "@/lib/utils";

const COLOR_MODES: { value: ColorMode; label: string }[] = [
	{ value: "module", label: "Module" },
	{ value: "churn", label: "Churn" },
	{ value: "doa", label: "DOA" },
];

const SHAPE_MODES: { value: ShapeMode; label: string }[] = [
	{ value: "cluster", label: "Cluster" },
	{ value: "pack", label: "Pack" },
	{ value: "arc", label: "Arc" },
	{ value: "tree", label: "Tree" },
];

const ZOOM_PRESETS = [0.75, 1, 1.25, 1.5, 2];

const FOCUS_MODES: { value: FocusMode; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "module", label: "Module" },
	{ value: "highlights", label: "Hits" },
];

export function HebControls() {
	const {
		edgeTypeFilter,
		colorMode,
		shapeMode,
		zoomScale,
		focusMode,
		moduleFilter,
		hierarchyData,
		setEdgeTypeFilter,
		setColorMode,
		setShapeMode,
		setZoomScale,
		setFocusMode,
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
	const churnDiagnostics = hierarchyData?.churnDiagnostics;

	return (
		<div
			className={cn(
				"absolute top-3 right-3 w-75 rounded-lg border border-[--color-border]",
				"bg-[--color-surface]/90 backdrop-blur-sm p-3",
				"text-md flex flex-col gap-3",
			)}
		>
			{/* Edge types */}
			<div>
				<p className="font-medium text-[--color-text-muted] uppercase tracking-wider mb-1.5">
					Edges
				</p>
				<div className="flex flex-col gap-1">
					{ALL_EDGE_TYPES.map((type) => (
						<label
							key={type}
							className="flex items-center gap-2 cursor-pointer"
						>
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
												backgroundColor:
													EDGE_TYPE_COLORS[type] ??
													EDGE_TYPE_COLORS["default"]!,
											}
										: {}
								}
							>
								{edgeTypeFilter.includes(type) && (
									<svg width="8" height="8" viewBox="0 0 8 8" fill="none">
										<path
											d="M1 4l2 2 4-4"
											stroke="#0f1117"
											strokeWidth="1.5"
											strokeLinecap="round"
										/>
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

			{/* Shape mode */}
			<div>
				<p className="font-medium text-[--color-text-muted] uppercase tracking-wider mb-1.5">
					Shape
				</p>
				<div className="grid grid-cols-2 gap-1">
					{SHAPE_MODES.map((mode) => (
						<button
							key={mode.value}
							onClick={() => setShapeMode(mode.value)}
							className={cn(
								"py-0.5 rounded text-[10px] transition-colors",
								shapeMode === mode.value
									? "bg-[--color-accent] text-white"
									: "text-[--color-text-muted] hover:text-[--color-text] border border-[--color-border]",
							)}
						>
							{mode.label}
						</button>
					))}
				</div>
			</div>

			{/* Zoom mode */}
			<div>
				<p className="font-medium text-[--color-text-muted] uppercase tracking-wider mb-1.5">
					Zoom
				</p>
				<div className="grid grid-cols-3 gap-1">
					{ZOOM_PRESETS.map((preset) => {
						const active = Math.abs(zoomScale - preset) < 0.001;
						return (
							<button
								key={preset}
								onClick={() => setZoomScale(preset)}
								className={cn(
									"py-0.5 rounded text-[10px] transition-colors",
									active
										? "bg-[--color-accent] text-white"
										: "text-[--color-text-muted] hover:text-[--color-text] border border-[--color-border]",
								)}
							>
								{Math.round(preset * 100)}%
							</button>
						);
					})}
				</div>
			</div>

			{/* Focus mode */}
			<div>
				<p className="font-medium text-[--color-text-muted] uppercase tracking-wider mb-1.5">
					Focus
				</p>
				<div className="grid grid-cols-3 gap-1">
					{FOCUS_MODES.map((mode) => (
						<button
							key={mode.value}
							onClick={() => setFocusMode(mode.value)}
							className={cn(
								"py-0.5 rounded text-[10px] transition-colors",
								focusMode === mode.value
									? "bg-[--color-accent] text-white"
									: "text-[--color-text-muted] hover:text-[--color-text] border border-[--color-border]",
							)}
						>
							{mode.label}
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

			{/* Churn validation diagnostics */}
			{churnDiagnostics && (
				<div>
					<p className="font-medium text-[--color-text-muted] uppercase tracking-wider mb-1.5">
						Churn Checks
					</p>
					<div className="text-[10px] text-[--color-text-subtle] flex flex-col gap-0.5">
						<span>
							{churnDiagnostics.filesWithChurn}/{churnDiagnostics.totalFiles}{" "}
							files have churn
						</span>
						<span>
							Missing: {churnDiagnostics.failureBreakdown.missingChurnFiles} ·
							Invalid: {churnDiagnostics.failureBreakdown.invalidChurnValues}
						</span>
						{churnDiagnostics.failureBreakdown.zeroVariance && (
							<span className="text-amber-300">
								All churn values are identical (zero variance).
							</span>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function collectModules(
	nodes: import("@/types/graph").HierarchyNode[],
): string[] {
	const seen = new Set<string>();
	for (const n of nodes) {
		if (n.module && n.module !== "root") seen.add(n.module);
	}
	return [...seen].sort();
}
