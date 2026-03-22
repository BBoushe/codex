/**
 * @fileoverview Batch upsert logic for ChromaDB embeddings.
 *
 * Mirrors the graph-client inserter pattern: batch operations with
 * failure tracking and stats reporting.
 *
 * Uses `upsert()` instead of `add()` for idempotency — re-running
 * the embed pipeline overwrites existing vectors rather than erroring.
 */

import type { Collection } from "chromadb";
import type { EmbeddingVector } from "@codex/shared";
import type {
	EmbeddableEntity,
	ChromaEntityMetadata,
	EmbedFailure,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Max records per ChromaDB upsert call. Conservative default. */
const CHROMA_BATCH_SIZE = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Upsert result
// ─────────────────────────────────────────────────────────────────────────────

export interface UpsertResult {
	upserted: number;
	failed: number;
	failures: EmbedFailure[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extracts ChromaDB-compatible metadata from an EmbeddableEntity. */
function toMetadata(
	entity: EmbeddableEntity,
): Record<string, string | number | boolean> {
	return {
		nodeId: entity.nodeId,
		name: entity.name,
		qualifiedName: entity.qualifiedName,
		filePath: entity.filePath,
		label: entity.label,
		language: entity.language,
		startLine: entity.startLine,
		endLine: entity.endLine,
		isExported: entity.isExported,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upserts embedding vectors into a ChromaDB collection.
 *
 * @param collection - The ChromaDB collection to write to.
 * @param entities - Entities with formatted contextStrings.
 * @param vectors - Parallel array of embedding vectors (same order as entities).
 * @param batchSize - Records per upsert call. Default 100.
 * @returns Counts and any individual failures.
 */
export async function upsertEmbeddings(
	collection: Collection,
	entities: EmbeddableEntity[],
	vectors: EmbeddingVector[],
	batchSize: number = CHROMA_BATCH_SIZE,
): Promise<UpsertResult> {
	if (entities.length !== vectors.length) {
		throw new Error(
			`upsertEmbeddings: entity count (${entities.length}) does not match vector count (${vectors.length})`,
		);
	}

	let upserted = 0;
	let failed = 0;
	const failures: EmbedFailure[] = [];

	for (let i = 0; i < entities.length; i += batchSize) {
		const batchEntities = entities.slice(i, i + batchSize);
		const batchVectors = vectors.slice(i, i + batchSize);

		const ids = batchEntities.map((e) => e.nodeId);
		const embeddings = batchVectors;
		const metadatas = batchEntities.map(toMetadata);
		const documents = batchEntities.map((e) => e.contextString);

		try {
			await collection.upsert({ ids, embeddings, metadatas, documents });
			upserted += batchEntities.length;
		} catch (err) {
			// If the batch fails, try individual records to isolate the bad ones
			for (let j = 0; j < batchEntities.length; j++) {
				const entity = batchEntities[j]!;
				const vector = batchVectors[j]!;
				try {
					await collection.upsert({
						ids: [entity.nodeId],
						embeddings: [vector],
						metadatas: [toMetadata(entity)],
						documents: [entity.contextString],
					});
					upserted += 1;
				} catch (innerErr) {
					failed += 1;
					failures.push({
						nodeId: entity.nodeId,
						name: entity.name,
						error:
							innerErr instanceof Error
								? innerErr.message
								: String(innerErr),
					});
				}
			}
		}
	}

	return { upserted, failed, failures };
}
