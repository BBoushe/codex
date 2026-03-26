/**
 * @fileoverview Frontend mirrors of backend API response types.
 *
 * These are pure interface definitions — no imports from workspace packages.
 * They must stay in sync with:
 *   - packages/rag/src/types.ts
 *   - packages/graph-client/src/retriever.ts
 *   - packages/vector-client/src/types.ts
 */

// ─────────────────────────────────────────────────────────────────────────────
// Vector search (mirrors @codex/vector-client VectorSearchResult)
// ─────────────────────────────────────────────────────────────────────────────

export interface VectorSearchResult {
	nodeId: string;
	name: string;
	qualifiedName: string;
	filePath: string;
	label: string;
	language: string;
	startLine: number;
	endLine: number;
	/** Cosine distance — lower = more similar. */
	distance: number;
	/** Context string stored in ChromaDB. */
	document: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph expansion types (mirrors @codex/graph-client retriever.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface RelatedEntity {
	nodeId: string;
	name: string;
	qualifiedName: string;
	filePath: string;
	label: string;
	sourceCode: string | null;
	callSiteLine?: number;
}

export interface DeveloperExpertise {
	name: string;
	email: string;
	doaScore: number;
	isFirstAuthor: boolean;
	lastContribution: string | null;
}

export interface ImportedFile {
	filePath: string;
	language: string;
}

export interface ExpandedContext {
	target: {
		nodeId: string;
		name: string;
		qualifiedName: string;
		label: string;
		filePath: string;
		sourceCode: string | null;
		startLine: number;
		endLine: number;
	};
	file: { filePath: string; language: string } | null;
	callers: RelatedEntity[];
	callees: RelatedEntity[];
	renderedComponents: RelatedEntity[];
	hooksUsed: RelatedEntity[];
	importedFiles: ImportedFile[];
	developers: DeveloperExpertise[];
}

export interface StructuralQueryResult {
	pattern: string;
	query: string;
	entities: Array<{
		nodeId: string;
		name: string;
		qualifiedName: string;
		filePath: string;
		label: string;
		startLine?: number;
		endLine?: number;
	}>;
}

export interface PathQueryResult {
	path: Array<{
		nodeId: string;
		name: string;
		qualifiedName: string;
		label: string;
		filePath: string;
	}>;
	edgeTypes: string[];
	hops: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// RAG pipeline types (mirrors @codex/rag types.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type ContextBudget = "compact" | "standard" | "full";

export type HybridSubKind = "direct_lookup" | "semantic" | "architectural";

export type QueryIntent =
	| {
			kind: "structural";
			spec: {
				from: { label?: string; name?: string; filePath?: string };
				edge: string;
				direction: "outgoing" | "incoming";
				to: { label?: string; name?: string; filePath?: string };
			};
			relationship: string;
			wasFallback: false;
	  }
	| { kind: "social"; extractedName: string; wasFallback: false }
	| { kind: "hybrid"; subKind: HybridSubKind; topK: number; wasFallback: boolean };

export interface PipelineTimings {
	classifierMs: number;
	embeddingMs: number;
	vectorSearchMs: number;
	graphExpansionMs: number;
	assemblyMs: number;
	synthesisMs: number;
	totalMs: number;
}

export interface HybridSearchResult {
	answer: string;
	model: string;
	anchors: VectorSearchResult[];
	referencedNodeIds: string[];
	usage: { inputTokens: number; outputTokens: number };
	durationMs: number;
}

export interface SocialDeveloper {
	name: string;
	email: string;
	doaScore: number;
	isFirstAuthor: boolean;
	lastContribution: string | null;
	topFiles: string[];
}

export interface FileChurnInfo {
	path: string;
	totalCommits: number;
	totalAdded: number;
	totalDeleted: number;
	churnRate: number;
}

export interface SocialSearchResult {
	query: string;
	developers: SocialDeveloper[];
	files: FileChurnInfo[];
	answer: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
}

export type SearchResult =
	| { kind: "structural"; result: StructuralQueryResult; intent: QueryIntent; timings: PipelineTimings }
	| { kind: "hybrid"; result: HybridSearchResult; intent: QueryIntent; timings: PipelineTimings }
	| { kind: "social"; result: SocialSearchResult; intent: QueryIntent; timings: PipelineTimings }
	| { kind: "path"; result: PathQueryResult; intent: QueryIntent; timings: PipelineTimings };

// ─────────────────────────────────────────────────────────────────────────────
// Browse tree (used by file browser component)
// ─────────────────────────────────────────────────────────────────────────────

export interface FileTreeNode {
	name: string;
	path: string;
	type: "directory" | "file";
	language?: string;
	children?: FileTreeNode[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Force-directed subgraph types (Week 13)
// ─────────────────────────────────────────────────────────────────────────────

export interface SubgraphNode {
	nodeId: string;
	name: string;
	label: string;
	filePath: string;
	module: string;
	language: string | null;
	linesOfCode: number;
	churnRate: number;
	doaScore: number;
	isDeveloper: boolean;
}

export interface SubgraphEdge {
	source: string;
	target: string;
	type: string;
}

export interface SubgraphResponse {
	nodes: SubgraphNode[];
	edges: SubgraphEdge[];
	centerNodeId: string;
}

export type SizingMetric = "loc" | "doa" | "churn";

// ─────────────────────────────────────────────────────────────────────────────
// Generic API result wrapper
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiError {
	message: string;
	status: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
