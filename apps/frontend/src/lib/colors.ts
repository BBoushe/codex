/**
 * @fileoverview Color mapping for graph visualization.
 *
 * Used by the HEB (Week 12) and force-directed graph (Week 13).
 */

/** Categorical palette for top-level modules (directories). */
const MODULE_PALETTE = [
	"#6366f1", // indigo
	"#22d3ee", // cyan
	"#a3e635", // lime
	"#f59e0b", // amber
	"#ec4899", // pink
	"#14b8a6", // teal
	"#f97316", // orange
	"#8b5cf6", // violet
	"#06b6d4", // sky
	"#84cc16", // green
];

/** Returns a consistent module color given the module name. */
export function moduleColor(moduleName: string): string {
	let hash = 0;
	for (let i = 0; i < moduleName.length; i++) {
		hash = (hash * 31 + moduleName.charCodeAt(i)) >>> 0;
	}
	return MODULE_PALETTE[hash % MODULE_PALETTE.length] ?? MODULE_PALETTE[0]!;
}

/** Node type colors for the force-directed graph (Week 13). */
export const NODE_TYPE_COLORS: Record<string, string> = {
	function: "#60a5fa",   // blue-400
	component: "#4ade80",  // green-400
	class: "#c084fc",      // purple-400
	hook: "#fb923c",       // orange-400
	interface: "#94a3b8",  // slate-400
	decorator: "#f472b6",  // pink-400
	file: "#475569",       // slate-600
	directory: "#64748b",  // slate-500
	developer: "#facc15",  // yellow-400
	default: "#6b7280",    // gray-500
};

/** Edge type colors for HEB and force-directed graph. */
export const EDGE_TYPE_COLORS: Record<string, string> = {
	CALLS: "#60a5fa",      // blue
	IMPORTS: "#94a3b8",    // gray
	RENDERS: "#4ade80",    // green
	USES_HOOK: "#fb923c",  // orange
	INHERITS: "#c084fc",   // purple
	IMPLEMENTS: "#2dd4bf", // teal
	MODIFIED: "#fbbf24",   // amber
	default: "#475569",    // slate
};

/**
 * Maps a 0–1 value to a churn heatmap color.
 * 0 = green (low churn), 0.5 = yellow, 1 = red (high churn).
 */
export function churnColor(normalizedValue: number): string {
	const v = Math.max(0, Math.min(1, normalizedValue));
	if (v < 0.5) {
		// green → yellow
		const t = v * 2;
		const r = Math.round(34 + (250 - 34) * t);
		const g = Math.round(197 + (204 - 197) * t);
		const b = Math.round(94 + (21 - 94) * t);
		return `rgb(${r},${g},${b})`;
	}
	// yellow → red
	const t = (v - 0.5) * 2;
	const r = Math.round(250 + (239 - 250) * t);
	const g = Math.round(204 + (68 - 204) * t);
	const b = Math.round(21 + (68 - 21) * t);
	return `rgb(${r},${g},${b})`;
}

/**
 * Maps a DOA score (0–1) to a blue sequential scale.
 * 0 = light blue (low expertise), 1 = deep blue (high expertise).
 */
export function doaColor(score: number): string {
	const v = Math.max(0, Math.min(1, score));
	const r = Math.round(219 - (219 - 30) * v);
	const g = Math.round(234 - (234 - 64) * v);
	const b = Math.round(254 - (254 - 175) * v);
	return `rgb(${r},${g},${b})`;
}
