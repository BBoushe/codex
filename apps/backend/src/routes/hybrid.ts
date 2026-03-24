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
}

interface HybridRequestBody {
	/** The natural language query. */
	query: string;
	/** Override auto-detected topK. */
	topK?: number;
	/** Context budget tier (default: env RAG_CONTEXT_BUDGET or "standard"). */
	budget?: ContextBudget;
}

export function hybridRoutes(deps: HybridSearchDeps) {
	return new Elysia({ prefix: "/search" }).post(
		"/hybrid",
		async ({
			body,
		}: {
			body: HybridRequestBody;
		}): Promise<SearchResult> => {
			return runSearch(body.query, {
				driver: deps.driver,
				chromaClient: deps.chromaClient,
				embeddingProvider: deps.embeddingProvider,
				llmProvider: deps.llmProvider,
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
			}),
		},
	);
}
