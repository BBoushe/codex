/**
 * @fileoverview Hybrid RAG search endpoint.
 *
 * POST /search/hybrid — classifies query intent, then runs the appropriate
 * pipeline (structural Cypher, social developer lookup, or hybrid vector+graph+LLM).
 *
 * Returns a discriminated SearchResult for frontend rendering.
 */

import { Elysia, t } from "elysia";
import type { Driver } from "neo4j-driver";
import type { ChromaClient } from "chromadb";
import type { EmbeddingProvider, LLMProvider } from "@codex/shared";
import { runSearch, type SearchResult, type ContextBudget } from "@codex/rag";

// ─────────────────────────────────────────────────────────────────────────────
// Route factory
// ─────────────────────────────────────────────────────────────────────────────

interface HybridSearchDeps {
	driver: Driver;
	chromaClient: ChromaClient;
	embeddingProvider: EmbeddingProvider;
	llmProvider: LLMProvider;
	classifierProvider: LLMProvider;
	/** Optional factory — when provided, a model override in the request body
	 *  creates a new provider instance instead of using the default. */
	createLlmProvider?: (model: string) => LLMProvider;
}

interface HybridRequestBody {
	/** The natural language query. */
	query: string;
	/** Override auto-detected topK. */
	topK?: number;
	/** Context budget tier (default: env RAG_CONTEXT_BUDGET or "standard"). */
	budget?: ContextBudget;
	/** Override the LLM model for this request (must match active provider). */
	model?: string;
}

export function hybridRoutes(deps: HybridSearchDeps) {
	return new Elysia({ prefix: "/search" }).post(
		"/hybrid",
		async ({
			body,
		}: {
			body: HybridRequestBody;
		}): Promise<SearchResult> => {
			const llmProvider =
				body.model && deps.createLlmProvider
					? deps.createLlmProvider(body.model)
					: deps.llmProvider;

			return runSearch(body.query, {
				driver: deps.driver,
				chromaClient: deps.chromaClient,
				embeddingProvider: deps.embeddingProvider,
				llmProvider,
				classifierProvider: deps.classifierProvider,
				topK: body.topK,
				budget: body.budget,
			});
		},
		{
			body: t.Object({
				query: t.String({ minLength: 1 }),
				topK: t.Optional(t.Number({ minimum: 1, maximum: 10 })),
				budget: t.Optional(
					t.Union([t.Literal("compact"), t.Literal("standard"), t.Literal("full")]),
				),
				model: t.Optional(t.String()),
			}),
		},
	);
}
