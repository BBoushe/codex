/**
 * @fileoverview Vector similarity search against ChromaDB.
 *
 * Transforms ChromaDB's column-oriented query response into
 * row-oriented `VectorSearchResult[]` for consumer convenience.
 */

import type { Collection } from "chromadb";
import type { EmbeddingVector } from "@codex/shared";
import type { ChromaEntityMetadata, VectorSearchResult } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Searches the entity collection for vectors most similar to `queryVector`.
 *
 * @param collection - The ChromaDB collection to query.
 * @param queryVector - The embedded query vector.
 * @param nResults - Max results to return (default 5).
 * @param where - Optional metadata filter (e.g. `{ label: "Function" }`).
 * @returns Row-oriented results sorted by similarity (closest first).
 */
export async function searchEntities(
	collection: Collection,
	queryVector: EmbeddingVector,
	nResults: number = 5,
	where?: Record<string, string | number | boolean>,
): Promise<VectorSearchResult[]> {
	let queryResponse;
	try {
		queryResponse = await collection.query({
			queryEmbeddings: [queryVector],
			nResults,
			...(where ? { where } : {}),
			include: ["metadatas", "distances", "documents"],
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[vector-client] ChromaDB query failed: ${msg}`);
		// Dimension mismatch is the most common silent failure
		if (msg.includes("dimension") || msg.includes("InvalidDimension")) {
			console.error(
				`[vector-client] Likely dimension mismatch: query vector has ${queryVector.length} dims but collection expects a different size. Re-run 'codex embed' with the same embedding provider.`,
			);
		}
		return [];
	}

	// ChromaDB returns column-oriented arrays wrapped in an outer array
	// (one per query embedding — we always send exactly one).
	const ids = queryResponse.ids[0] ?? [];
	const metadatas = queryResponse.metadatas?.[0] ?? [];
	const distances = queryResponse.distances?.[0] ?? [];
	const documents = queryResponse.documents?.[0] ?? [];

	const results: VectorSearchResult[] = [];

	for (let i = 0; i < ids.length; i++) {
		const meta = metadatas[i] as ChromaEntityMetadata | null;
		if (!meta) continue;

		results.push({
			nodeId: meta.nodeId,
			name: meta.name,
			qualifiedName: meta.qualifiedName,
			filePath: meta.filePath,
			label: meta.label,
			language: meta.language,
			startLine: meta.startLine,
			endLine: meta.endLine,
			distance: distances[i] ?? 1,
			document: documents[i] ?? "",
		});
	}

	return results;
}
