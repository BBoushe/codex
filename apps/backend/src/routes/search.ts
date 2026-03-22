/**
 * @fileoverview Vector search endpoint.
 *
 * POST /search/vector — embeds a natural language query and returns
 * the most similar code entities from ChromaDB.
 */

import { Elysia, t } from "elysia";
import type { ChromaClient } from "chromadb";
import type { EmbeddingProvider } from "@codex/shared";
import {
	getOrCreateEntityCollection,
	searchEntities,
	type VectorSearchResult,
} from "@codex/vector-client";

// ─────────────────────────────────────────────────────────────────────────────
// Route factory
// ─────────────────────────────────────────────────────────────────────────────

interface SearchDeps {
	chromaClient: ChromaClient;
	embeddingProvider: EmbeddingProvider;
}

interface SearchRequestBody {
	/** The natural language query to embed and search for. */
	query: string;
	/** Maximum number of results to return (default: 5, max: 50). */
	limit?: number;
	/** Optional filters to apply to the search results. */
	filter?: Record<string, string | number | boolean>;
}

export function searchRoutes(deps: SearchDeps) {
	return new Elysia({ prefix: "/search" }).post(
		"/vector",
		async ({
			body,
		}: {
			body: SearchRequestBody;
		}): Promise<{ results: VectorSearchResult[]; query: string }> => {
			const { query, limit, filter } = body;

			// 1. Embed the query string
			const queryVector = await deps.embeddingProvider.embedOne(query);

			// 2. Query ChromaDB
			const collection = await getOrCreateEntityCollection(deps.chromaClient);
			const results = await searchEntities(
				collection,
				queryVector,
				limit ?? 5,
				filter,
			);

			return { results, query };
		},
		{
			body: t.Object({
				query: t.String({ minLength: 1 }),
				limit: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
				filter: t.Optional(
					t.Record(t.String(), t.Union([t.String(), t.Number(), t.Boolean()])),
				),
			}),
		},
	);
}
