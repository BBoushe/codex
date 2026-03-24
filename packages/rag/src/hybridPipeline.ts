/**
 * @fileoverview Hybrid RAG pipeline orchestrator.
 *
 * Coordinates the full flow:
 *   1. Intent classification (LLM-based)
 *   2a. Structural intent → direct Cypher query (no embedding, no LLM synthesis)
 *   2b. Social intent    → developer Cypher query (stub until Phase 3 git mining)
 *   2c. Hybrid intent    → vector search → graph expansion → context assembly → LLM synthesis
 *
 * Every SearchResult includes per-phase PipelineTimings for performance analysis.
 *
 * `runSearch()` is the unified entry point consumed by both the backend routes
 * and the CLI `query` command.
 */

import type { Driver } from "neo4j-driver";
import type { ChromaClient } from "chromadb";
import type { EmbeddingProvider, LLMProvider } from "@codex/shared";
import {
	getOrCreateEntityCollection,
	searchEntities,
} from "@codex/vector-client";
import { expandContext, executeStructuralSpec } from "@codex/graph-client";
import { classifyIntent } from "./intentClassifier.js";
import { assembleContext } from "./contextAssembler.js";
import { synthesize } from "./synthesizer.js";
import type {
	SearchResult,
	HybridSearchResult,
	SocialSearchResult,
	QueryIntent,
	ExpansionOptions,
	ContextBudget,
	PipelineTimings,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline options
// ─────────────────────────────────────────────────────────────────────────────

export interface HybridPipelineOptions {
	/** Neo4j driver for graph queries and expansion. */
	driver: Driver;
	/** ChromaDB client for vector search. */
	chromaClient: ChromaClient;
	/** Embedding provider for query vectorization. */
	embeddingProvider: EmbeddingProvider;
	/** LLM provider for answer synthesis. */
	llmProvider: LLMProvider;
	/** Dedicated LLM provider for intent classification (low temperature). */
	classifierProvider: LLMProvider;
	/** Override auto-detected topK. If omitted, classifier determines K. */
	topK?: number;
	/** Context budget for assembled context (default: env RAG_CONTEXT_BUDGET or "standard"). */
	budget?: ContextBudget;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timing helper
// ─────────────────────────────────────────────────────────────────────────────

function emptyTimings(): PipelineTimings {
	return {
		classifierMs: 0,
		embeddingMs: 0,
		vectorSearchMs: 0,
		graphExpansionMs: 0,
		assemblyMs: 0,
		synthesisMs: 0,
		totalMs: 0,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the full search pipeline for a user query.
 *
 * Classifies intent, delegates to the appropriate handler, and returns a
 * discriminated SearchResult with per-phase timings.
 */
export async function runSearch(
	query: string,
	options: HybridPipelineOptions,
): Promise<SearchResult> {
	const totalStart = Date.now();
	const timings = emptyTimings();

	const budget: ContextBudget =
		options.budget ??
		((process.env["RAG_CONTEXT_BUDGET"] as ContextBudget | undefined) ??
			"standard");

	// ── 1. Classify intent ───────────────────────────────────────────────
	const classifierStart = Date.now();
	const intent = await classifyIntent(query, options.classifierProvider);
	timings.classifierMs = Date.now() - classifierStart;

	// ── 2. Route to handler ──────────────────────────────────────────────
	if (intent.kind === "structural") {
		const neoStart = Date.now();
		const result = await executeStructuralSpec(
			options.driver,
			intent.spec,
			query,
		);
		timings.graphExpansionMs = Date.now() - neoStart;
		timings.totalMs = Date.now() - totalStart;
		return { kind: "structural", result, intent, timings };
	}

	if (intent.kind === "social") {
		const neoStart = Date.now();
		const result = await runSocialSearch(query, intent, options.driver);
		timings.graphExpansionMs = Date.now() - neoStart;
		timings.totalMs = Date.now() - totalStart;
		return { kind: "social", result, intent, timings };
	}

	// ── 3. Hybrid pipeline ───────────────────────────────────────────────
	const topK = options.topK ?? intent.topK;
	const result = await runHybridSearch(query, topK, budget, options, timings);
	timings.totalMs = Date.now() - totalStart;
	return { kind: "hybrid", result, intent, timings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hybrid search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the hybrid RAG pipeline: embed → search → expand → assemble → synthesize.
 * Mutates the provided `timings` object with per-phase durations.
 */
export async function runHybridSearch(
	query: string,
	topK: number,
	budget: ContextBudget,
	options: HybridPipelineOptions,
	timings?: PipelineTimings,
): Promise<HybridSearchResult> {
	const startTime = Date.now();
	const t = timings ?? emptyTimings();

	// 1. Embed the query
	const embedStart = Date.now();
	const queryVector = await options.embeddingProvider.embedOne(query);
	t.embeddingMs = Date.now() - embedStart;

	// 2. Vector search
	const vecStart = Date.now();
	const collection = await getOrCreateEntityCollection(options.chromaClient);
	const anchors = await searchEntities(collection, queryVector, topK);
	t.vectorSearchMs = Date.now() - vecStart;

	if (anchors.length === 0) {
		// No results — synthesize an honest "nothing found" answer
		const emptyContext = {
			text: "(No matching code entities found in the index.)",
			referencedNodeIds: [],
			charCount: 48,
			wasTruncated: false,
		};
		const synthStart = Date.now();
		const synthesis = await synthesize(
			options.llmProvider,
			query,
			emptyContext,
		);
		t.synthesisMs = Date.now() - synthStart;
		return {
			answer: synthesis.answer,
			model: synthesis.model,
			anchors: [],
			referencedNodeIds: [],
			usage: synthesis.usage,
			durationMs: Date.now() - startTime,
		};
	}

	// 3. Graph expansion for each anchor
	const perAnchorBudget: ContextBudget = topK === 1 ? budget : "compact";
	const expansionOptions: ExpansionOptions = { budget: perAnchorBudget };

	const contextParts: string[] = [];
	const allReferencedNodeIds: string[] = [];

	const expandStart = Date.now();
	for (let i = 0; i < anchors.length; i++) {
		const anchor = anchors[i];
		if (!anchor) continue;

		const expanded = await expandContext(options.driver, anchor.nodeId);
		if (!expanded) continue;

		const assembled = assembleContext(expanded, expansionOptions);
		allReferencedNodeIds.push(...assembled.referencedNodeIds);

		const header =
			anchors.length > 1
				? `--- Result ${i + 1} of ${anchors.length} ---\n`
				: "";
		contextParts.push(header + assembled.text);
	}
	t.graphExpansionMs = Date.now() - expandStart;

	const assemblyStart = Date.now();
	const combinedText = contextParts.join("\n\n");
	const combinedContext = {
		text: combinedText,
		referencedNodeIds: allReferencedNodeIds,
		charCount: combinedText.length,
		wasTruncated: false,
	};
	t.assemblyMs = Date.now() - assemblyStart;

	// 4. LLM synthesis
	const synthStart = Date.now();
	const synthesis = await synthesize(
		options.llmProvider,
		query,
		combinedContext,
	);
	t.synthesisMs = Date.now() - synthStart;

	return {
		answer: synthesis.answer,
		model: synthesis.model,
		anchors,
		referencedNodeIds: [...new Set(allReferencedNodeIds)],
		usage: synthesis.usage,
		durationMs: Date.now() - startTime,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Social search (stub — Phase 3 git mining)
// ─────────────────────────────────────────────────────────────────────────────

async function runSocialSearch(
	query: string,
	intent: Extract<QueryIntent, { kind: "social" }>,
	driver: Driver,
): Promise<SocialSearchResult> {
	const session = driver.session({ database: "neo4j" });

	try {
		const result = await session.run(
			`
			MATCH (dev:Developer)-[exp:HAS_EXPERTISE]->(f:File)
			WHERE f.filePath CONTAINS $name
			RETURN dev.name AS name, dev.email AS email,
			       exp.doaScore AS doaScore, exp.isFirstAuthor AS isFirstAuthor,
			       exp.lastContribution AS lastContribution
			ORDER BY exp.doaScore DESC
			LIMIT 10
			`,
			{ name: intent.extractedName },
		);

		const developers = result.records
			.map((record) => ({
				name: record.get("name") as string,
				email: record.get("email") as string,
				doaScore: (record.get("doaScore") as number | null) ?? 0,
				isFirstAuthor:
					(record.get("isFirstAuthor") as boolean | null) ?? false,
				lastContribution: record.get("lastContribution") as string | null,
			}))
			.filter((d) => d.name !== null);

		if (developers.length === 0) {
			return {
				query,
				developers: [],
				message:
					"No developer data found. Run `codex mine` to populate expertise data from git history.",
			};
		}

		return { query, developers };
	} finally {
		await session.close();
	}
}
