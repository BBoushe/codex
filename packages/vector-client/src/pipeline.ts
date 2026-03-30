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
	RawFunctionRecord,
	RawClassRecord,
	RawComponentRecord,
	RawHookRecord,
	RawFileRecord,
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
	/**
	 * Entity nodeIds already present in ChromaDB.
	 * When provided, entities with matching IDs are skipped entirely —
	 * the embedding API call is never made for them. This enables crash
	 * recovery: if a pipeline run fails mid-way, re-running with the
	 * existing ChromaDB IDs resumes from where it left off without
	 * re-embedding or re-spending tokens on already-indexed entities.
	 */
	skipIds?: Set<string>;
	/**
	 * Pre-fetched embeddable entities. When provided, the pipeline skips
	 * the internal `fetchEmbeddableNodes()` call. Useful when the caller
	 * already fetched entities for UI reporting (e.g. `codex analyze`).
	 */
	prefetchedEntities?: EmbeddableEntity[];
	/**
	 * Embed File-level metadata documents alongside code entities.
	 * Improves hybrid recall for file-related questions (size, churn, language).
	 * Default: true. Set to false via `--no-enrich` or `CODEX_ENRICH_FILES=false`.
	 */
	enrichFiles?: boolean;
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
			const label = record.get("label") as string;
			const base = {
				nodeId: record.get("nodeId") as string,
				name: record.get("name") as string,
				qualifiedName: record.get("qualifiedName") as string,
				filePath: record.get("filePath") as string,
				language: (record.get("language") as string | null) ?? "Unknown",
				startLine: toNumber(record.get("startLine")),
				endLine: toNumber(record.get("endLine")),
				isExported: (record.get("isExported") as boolean | null) ?? false,
				sourceCode: (record.get("sourceCode") as string | null) ?? null,
			};

			let raw: RawEntityRecord | null = null;

			switch (label) {
				case "Function":
					raw = {
						...base,
						label: "Function",
						parameters: (record.get("parameters") as string[] | null) ?? null,
						returnType: (record.get("returnType") as string | null) ?? null,
					} satisfies RawFunctionRecord;
					break;
				case "Class":
					raw = {
						...base,
						label: "Class",
						methods: (record.get("methods") as string[] | null) ?? null,
						parentClass: (record.get("parentClass") as string | null) ?? null,
					} satisfies RawClassRecord;
					break;
				case "Component":
					raw = {
						...base,
						label: "Component",
						componentKind:
							(record.get("componentKind") as string | null) ?? null,
						props: (record.get("props") as string[] | null) ?? null,
						renderedComponents:
							(record.get("renderedComponents") as string[] | null) ?? null,
					} satisfies RawComponentRecord;
					break;
				case "Hook":
					raw = {
						...base,
						label: "Hook",
						hookType: (record.get("hookType") as string | null) ?? null,
						returnBindings:
							(record.get("returnBindings") as string[] | null) ?? null,
						dependencies:
							(record.get("dependencies") as string[] | null) ?? null,
						arguments: (record.get("arguments") as string[] | null) ?? null,
					} satisfies RawHookRecord;
					break;
				default:
					raw = null;
			}

			if (!raw) continue;

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

/**
 * Fetches File nodes as metadata-only embeddable entities.
 * Used for context enrichment — enables hybrid queries to find files by
 * properties like size, language, and churn.
 */
export async function fetchFileNodes(
	driver: Driver,
): Promise<EmbeddableEntity[]> {
	const session = driver.session({ database: "neo4j" });
	try {
		const result = await session.run(`
			MATCH (f:File)
			RETURN f.nodeId      AS nodeId,
			       f.name        AS name,
			       f.qualifiedName AS qualifiedName,
			       f.filePath    AS filePath,
			       'File'        AS label,
			       f.language    AS language,
			       f.loc         AS loc,
			       f.extension   AS extension,
			       f.totalCommits AS totalCommits,
			       f.churnRate   AS churnRate,
			       f.totalAdded  AS totalAdded,
			       f.totalDeleted AS totalDeleted
		`);

		const entities: EmbeddableEntity[] = [];
		for (const record of result.records) {
			const raw: RawFileRecord = {
				nodeId: record.get("nodeId"),
				name: record.get("name"),
				qualifiedName: record.get("qualifiedName"),
				filePath: record.get("filePath"),
				label: "File",
				language: record.get("language") ?? "Unknown",
				startLine: 0,
				endLine: 0,
				isExported: false,
				sourceCode: null,
				// For File nodes, these fields are not applicable, so we set them to null.
				// parameters: null,
				// returnType: null,
				// methods: null,
				// parentClass: null,
				// componentKind: null,
				// props: null,
				// renderedComponents: null,
				// hookType: null,
				// returnBindings: null,
				// dependencies: null,
				// arguments: null,
				loc: toNumber(record.get("loc")) || null,
				extension: record.get("extension") as string | null,
				totalCommits: toNumber(record.get("totalCommits")) || null,
				churnRate: toNumberFloat(record.get("churnRate")),
				totalAdded: toNumber(record.get("totalAdded")) || null,
				totalDeleted: toNumber(record.get("totalDeleted")) || null,
			};

			const contextString = formatContextString(raw);
			if (!contextString) continue;

			entities.push({
				nodeId: raw.nodeId,
				name: raw.name,
				qualifiedName: raw.qualifiedName,
				filePath: raw.filePath,
				label: "File",
				language: raw.language,
				startLine: 0,
				endLine: 0,
				isExported: false,
				contextString,
			});
		}
		return entities;
	} finally {
		await session.close();
	}
}

/** Safely converts Neo4j Float to JS number (for churnRate). */
function toNumberFloat(value: unknown): number {
	if (typeof value === "number") return value;
	if (value && typeof value === "object" && "toNumber" in value) {
		return (value as { toNumber: () => number }).toNumber();
	}
	return 0;
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

	// 1. Fetch embeddable entities from Neo4j (or use pre-fetched)
	const codeEntities =
		opts.prefetchedEntities ?? (await fetchEmbeddableNodes(opts.driver));

	// 1b. Optionally enrich with File metadata documents
	const enrichFiles =
		opts.enrichFiles ?? process.env["CODEX_ENRICH_FILES"] !== "false";
	let fileEntities: EmbeddableEntity[] = [];
	if (enrichFiles) {
		fileEntities = await fetchFileNodes(opts.driver);
	}
	const allEntities = [...codeEntities, ...fileEntities];

	// Apply checkpointing: skip entities already indexed in ChromaDB.
	// Used by `codex analyze` on re-runs to avoid re-embedding entities that
	// were successfully indexed in a prior (possibly interrupted) run.
	const entities = opts.skipIds?.size
		? allEntities.filter((e) => !opts.skipIds!.has(e.nodeId))
		: allEntities;

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
			cachedCount: allEntities.length,
			fileCount: fileEntities.length,
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
		cachedCount: opts.skipIds?.size ?? 0,
		fileCount: fileEntities.length,
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
