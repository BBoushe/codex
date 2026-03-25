/**
 * @fileoverview Type definitions for the CODEX RAG pipeline.
 *
 * Graph expansion types (ExpandedContext, RelatedEntity, etc.) live in
 * @codex/graph-client to avoid a circular dependency. This file re-exports
 * them alongside RAG-specific types.
 */

export type {
	ExpandedContext,
	RelatedEntity,
	DeveloperExpertise,
	ImportedFile,
	StructuralPattern,
	StructuralQueryResult,
	StructuralQuerySpec,
	NodeFilter,
	PathQueryResult,
} from "@codex/graph-client";

import type { VectorSearchResult } from "@codex/vector-client";

// ─────────────────────────────────────────────────────────────────────────────
// Context assembly types
// ─────────────────────────────────────────────────────────────────────────────

export type ContextBudget = "compact" | "standard" | "full";

export interface ExpansionOptions {
	/** Graph traversal depth (default: 1). */
	depth?: number;
	/** Character budget for assembled context (default: "standard"). */
	budget?: ContextBudget;
}

/** Budget character limits: compact=8000, standard=24000, full=unlimited */
export const BUDGET_LIMITS: Record<ContextBudget, number> = {
	compact: 8_000,
	standard: 24_000,
	full: Infinity,
};

export interface AssembledContext {
	text: string;
	referencedNodeIds: string[];
	charCount: number;
	wasTruncated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent classification types
// ─────────────────────────────────────────────────────────────────────────────

/** Sub-classification for hybrid queries — determines topK. */
export type HybridSubKind =
	| "direct_lookup" // Query contains a specific identifier → K=1
	| "semantic" // Concept-level query → K=3
	| "architectural"; // Multi-module reasoning → K=5

/**
 * Query intent — discriminated union returned by the intent classifier.
 *
 * `wasFallback` is true when the classifier failed to parse the LLM response
 * and fell back to semantic hybrid. When false, the classification was a
 * genuine LLM decision. This disambiguates "the LLM chose semantic" from
 * "the LLM gave garbage and we defaulted to semantic".
 */
export type QueryIntent =
	| {
			kind: "structural";
			spec: import("@codex/graph-client").StructuralQuerySpec;
			/** Natural language description of the relationship. */
			relationship: string;
			wasFallback: false;
	  }
	| {
			kind: "social";
			extractedName: string;
			wasFallback: false;
	  }
	| {
			kind: "hybrid";
			subKind: HybridSubKind;
			topK: number;
			wasFallback: boolean;
	  };

// ─────────────────────────────────────────────────────────────────────────────
// Search result types
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline timing
// ─────────────────────────────────────────────────────────────────────────────

/** Per-phase wall-clock timing for the search pipeline. */
export interface PipelineTimings {
	/** Intent classification LLM call. */
	classifierMs: number;
	/** Query embedding via embedding provider. */
	embeddingMs: number;
	/** ChromaDB vector similarity search. */
	vectorSearchMs: number;
	/** Neo4j graph expansion (sum across all anchors). */
	graphExpansionMs: number;
	/** Context assembly (CPU-only, typically <1ms). */
	assemblyMs: number;
	/** LLM synthesis call. */
	synthesisMs: number;
	/** Total wall-clock (includes overhead between phases). */
	totalMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search result types
// ─────────────────────────────────────────────────────────────────────────────

/** Result from a structural (Cypher-direct) query. No LLM involved. */
export type StructuralSearchResult = import("@codex/graph-client").StructuralQueryResult;

/** Result from the hybrid RAG pipeline. */
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
	/** Average DOA score across their top files. */
	doaScore: number;
	isFirstAuthor: boolean;
	lastContribution: string | null;
	/** Top files by DOA score (up to 5). */
	topFiles: string[];
}

/** Per-file churn metrics from git history (stored as File node properties). */
export interface FileChurnInfo {
	path: string;
	totalCommits: number;
	totalAdded: number;
	totalDeleted: number;
	churnRate: number;
}

/** Result from social/developer queries. */
export interface SocialSearchResult {
	query: string;
	developers: SocialDeveloper[];
	/** Top files by commit count — populated for churn/hotspot queries. */
	files: FileChurnInfo[];
	/** LLM-synthesized prose answer. Also used for error messages. */
	answer: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
}

/** Multi-hop path result (Week 8). */
export type PathSearchResult = import("@codex/graph-client").PathQueryResult;

/** Unified search result — discriminated union for frontend rendering. */
export type SearchResult =
	| { kind: "structural"; result: StructuralSearchResult; intent: QueryIntent; timings: PipelineTimings }
	| { kind: "hybrid"; result: HybridSearchResult; intent: QueryIntent; timings: PipelineTimings }
	| { kind: "social"; result: SocialSearchResult; intent: QueryIntent; timings: PipelineTimings }
	| { kind: "path"; result: PathSearchResult; intent: QueryIntent; timings: PipelineTimings }; // Week 8
