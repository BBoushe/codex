/**
 * @fileoverview Types for the graph visualization layer.
 *
 * Used by the HEB (Week 12) and force-directed graph (Week 13).
 * Matches the response shape of GET /api/graph/hierarchy.
 */

export type HierarchyNodeType =
	| "directory"
	| "file"
	| "function"
	| "class"
	| "component"
	| "hook"
	| "interface"
	| "decorator";

export interface HierarchyNode {
	/** nodeId for entities; directory path or filePath for structural nodes. */
	id: string;
	name: string;
	type: HierarchyNodeType;
	/** Top-level directory segment — used for categorical color coding. */
	module: string;
	language?: string;
	/** File-level churn rate (commits per month over last 6 months). */
	churnRate?: number;
	/** Max DOA score of any developer for this file. */
	doaScore?: number;
	children?: HierarchyNode[];
}

export interface HierarchyEdge {
	/** nodeId of the source entity. */
	source: string;
	/** nodeId of the target entity. */
	target: string;
	/** Edge type: CALLS, IMPORTS, RENDERS, USES_HOOK, INHERITS, IMPLEMENTS. */
	type: string;
}

export interface HierarchyResponse {
	tree: HierarchyNode;
	edges: HierarchyEdge[];
	churnDiagnostics?: {
		totalFiles: number;
		filesWithChurn: number;
		minChurnRate: number | null;
		maxChurnRate: number | null;
		failureBreakdown: {
			missingChurnFiles: number;
			invalidChurnValues: number;
			zeroVariance: boolean;
		};
	};
}

export type ColorMode = "module" | "churn" | "doa";
export type ShapeMode = "cluster" | "pack" | "arc" | "tree";
export type FocusMode = "all" | "module" | "highlights";

export interface HebOptions {
	edgeTypeFilter: string[];
	colorMode: ColorMode;
	shapeMode: ShapeMode;
	zoomScale: number;
	focusMode: FocusMode;
	moduleFilter: string | null;
	highlightedNodeIds: Set<string>;
	onNodeHover: (nodeId: string | null) => void;
	onNodeClick: (nodeId: string) => void;
}

/** A SubgraphNode extended with d3-force simulation fields. */
export interface ForceGraphNode {
	nodeId: string;
	name: string;
	label: string;
	filePath: string;
	directory: string;
	module: string;
	language: string | null;
	linesOfCode: number;
	churnRate: number;
	doaScore: number;
	isDeveloper: boolean;
	// d3-force fields (added at runtime)
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
	fx?: number;
	fy?: number;
}
