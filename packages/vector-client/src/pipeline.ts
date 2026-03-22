/**
 * @fileoverview Embedding pipeline orchestrator.
 *
 * Coordinates the full flow: Neo4j → context formatting → embedding API → ChromaDB.
 * Consumed by both the CLI `embed` command and the backend.
 */

import type { Driver } from "neo4j-driver";
import type { ChromaClient } from "chromadb";
import type { EmbeddingProvider } from "@codex/shared";
import { tokenTracker } from "@codex/shared";
import type {
	EmbeddableEntity,
	RawEntityRecord,
	EmbedStats,
	EmbedFailure,
} from "./types.js";
import { formatContextString } from "./contextFormatter.js";
import {
	getOrCreateEntityCollection,
	clearCollection,
	COLLECTION_NAME,
} from "./client.js";
import { upsertEmbeddings } from "./inserter.js";
import { withRetry } from "./retry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default batch size for embedding API calls (SiliconFlow limit). */
const DEFAULT_BATCH_SIZE = 64;

/** Approximate cost per million tokens by provider (USD). */
const COST_PER_MILLION_TOKENS: Record<string, number> = {
	siliconflow: 0.02,
	openai: 0.13,
};

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline options
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineOptions {
	/** Neo4j driver for fetching embeddable nodes. */
	driver: Driver;
	/** ChromaDB client for indexing vectors. */
	chromaClient: ChromaClient;
	/** Embedding provider (SiliconFlow, OpenAI, etc.). */
	embeddingProvider: EmbeddingProvider;
	/** Wipe existing embeddings before re-embedding. */
	clean?: boolean;
	/** Texts per embedding API call (default 64). */
	batchSize?: number;
	/** Progress callback: (embeddedSoFar, total). */
	onProgress?: (embedded: number, total: number) => void;
	/** Called before each retry with attempt info. */
	onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Neo4j query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches all embeddable entities from Neo4j with their parent file's language.
 *
 * Embeddable: Function, Class, Component, custom Hook.
 * Joins via DEFINED_IN to get the language from the parent FileNode.
 */
export async function fetchEmbeddableNodes(
	driver: Driver,
): Promise<EmbeddableEntity[]> {
	const session = driver.session({ database: "neo4j" });

	try {
		const result = await session.run(`
			MATCH (n)-[:DEFINED_IN]->(f:File)
			WHERE n:Function OR n:Class OR n:Component OR (n:Hook AND n.hookType = 'custom')
			OPTIONAL MATCH (n)-[:RENDERS]->(rendered:Component)
			WITH n, f, collect(rendered.name) AS renderedComponents
			RETURN n.nodeId      AS nodeId,
			       n.name        AS name,
			       n.qualifiedName AS qualifiedName,
			       n.filePath    AS filePath,
			       labels(n)[0]  AS label,
			       n.startLine   AS startLine,
			       n.endLine     AS endLine,
			       n.isExported  AS isExported,
			       n.sourceCode  AS sourceCode,
			       n.parameters  AS parameters,
			       n.returnType  AS returnType,
			       n.methods     AS methods,
			       n.parentClass AS parentClass,
			       n.componentKind AS componentKind,
			       n.props       AS props,
			       n.hookType    AS hookType,
			       n.returnBindings AS returnBindings,
			       n.dependencies AS dependencies,
			       n.arguments   AS arguments,
			       renderedComponents,
			       f.language    AS language
		`);

		const entities: EmbeddableEntity[] = [];

		for (const record of result.records) {
			const raw: RawEntityRecord = {
				nodeId: record.get("nodeId"),
				name: record.get("name"),
				qualifiedName: record.get("qualifiedName"),
				filePath: record.get("filePath"),
				label: record.get("label"),
				language: record.get("language") ?? "Unknown",
				startLine: toNumber(record.get("startLine")),
				endLine: toNumber(record.get("endLine")),
				isExported: record.get("isExported") ?? false,
				sourceCode: record.get("sourceCode"),
				parameters: record.get("parameters"),
				returnType: record.get("returnType"),
				methods: record.get("methods"),
				parentClass: record.get("parentClass"),
				componentKind: record.get("componentKind"),
				props: record.get("props"),
				renderedComponents: record.get("renderedComponents") ?? null,
				hookType: record.get("hookType"),
				returnBindings: record.get("returnBindings"),
				dependencies: record.get("dependencies"),
				arguments: record.get("arguments"),
			};

			const contextString = formatContextString(raw);
			if (!contextString) continue; // Skip entities that can't be formatted

			entities.push({
				nodeId: raw.nodeId,
				name: raw.name,
				qualifiedName: raw.qualifiedName,
				filePath: raw.filePath,
				label: raw.label,
				language: raw.language,
				startLine: raw.startLine,
				endLine: raw.endLine,
				isExported: raw.isExported,
				contextString,
			});
		}

		return entities;
	} finally {
		await session.close();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the full embedding pipeline: fetch → embed → index.
 *
 * @returns Statistics about the run (entities embedded, tokens, cost, failures).
 */
export async function runEmbeddingPipeline(
	opts: PipelineOptions,
): Promise<EmbedStats> {
	const startTime = Date.now();
	const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
	const allFailures: EmbedFailure[] = [];
	let totalTokens = 0;
	let totalEmbedded = 0;

	// 1. Fetch embeddable entities from Neo4j
	const entities = await fetchEmbeddableNodes(opts.driver);

	if (entities.length === 0) {
		return {
			entitiesEmbedded: 0,
			entitiesFailed: 0,
			totalTokens: 0,
			durationMs: Date.now() - startTime,
			model: opts.embeddingProvider.modelId,
			collectionName: COLLECTION_NAME,
			estimatedCost: 0,
			failures: [],
		};
	}

	// 2. Prepare ChromaDB collection
	const collection = opts.clean
		? await clearCollection(opts.chromaClient)
		: await getOrCreateEntityCollection(opts.chromaClient);

	// 3. Process in batches
	for (let i = 0; i < entities.length; i += batchSize) {
		const batchEntities = entities.slice(i, i + batchSize);
		const contextStrings = batchEntities.map((e) => e.contextString);

		try {
			// Embed with retry
			const embedResult = await withRetry(
				() => opts.embeddingProvider.embedBatch(contextStrings),
				{
					maxRetries: 3,
					onRetry: opts.onRetry,
				},
			);

			// Track tokens
			totalTokens += embedResult.totalTokens;
			tokenTracker.add({ embedded: embedResult.totalTokens });

			// Upsert into ChromaDB
			const upsertResult = await upsertEmbeddings(
				collection,
				batchEntities,
				embedResult.vectors,
			);

			totalEmbedded += upsertResult.upserted;
			allFailures.push(...upsertResult.failures);
		} catch (err) {
			// Entire batch failed (embedding API error after retries exhausted)
			const errorMsg = err instanceof Error ? err.message : String(err);
			for (const entity of batchEntities) {
				allFailures.push({
					nodeId: entity.nodeId,
					name: entity.name,
					error: errorMsg,
				});
			}
		}

		// Report progress
		const embeddedSoFar = Math.min(i + batchSize, entities.length);
		opts.onProgress?.(embeddedSoFar, entities.length);
	}

	// 4. Compute cost estimate
	const providerName = opts.embeddingProvider.providerName.toLowerCase();
	const costPerMillion = COST_PER_MILLION_TOKENS[providerName] ?? 0;
	const estimatedCost = (totalTokens / 1_000_000) * costPerMillion;

	return {
		entitiesEmbedded: totalEmbedded,
		entitiesFailed: allFailures.length,
		totalTokens,
		durationMs: Date.now() - startTime,
		model: opts.embeddingProvider.modelId,
		collectionName: COLLECTION_NAME,
		estimatedCost,
		failures: allFailures,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Safely converts Neo4j Integer to JS number. */
function toNumber(value: unknown): number {
	if (typeof value === "number") return value;
	// neo4j-driver returns Integer objects with .toNumber()
	if (value && typeof value === "object" && "toNumber" in value) {
		return (value as { toNumber: () => number }).toNumber();
	}
	return 0;
}
