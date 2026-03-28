/**
 * @fileoverview ChromaDB client initialization and collection management.
 *
 * Mirrors the `@codex/graph-client` pattern: clean exported functions
 * hiding the ChromaDB client behind a typed interface.
 *
 * Key caveat from Phase 0: `getOrCreateCollection` requires
 * `embeddingFunction: null` when supplying pre-computed vectors.
 */

// Suppress ChromaDB's "No embedding function configuration found" deserialization
// warnings. These fire whenever the client deserialises a collection that was
// created without server-side embedding function metadata — expected when
// supplying pre-computed vectors directly. The warnings are harmless.
const _consoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
	if (
		typeof args[0] === "string" &&
		args[0].includes("No embedding function")
	)
		return;
	_consoleWarn(...args);
};

import { ChromaClient, type Collection, type EmbeddingFunction } from "chromadb";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Name of the single ChromaDB collection for all code entities. */
export const COLLECTION_NAME = "codex_entities";

/** Default ChromaDB URL. Override via CHROMA_URL env var. */
const DEFAULT_CHROMA_URL = "http://localhost:8000";

/**
 * No-op embedding function passed to ChromaDB collection creation.
 *
 * We always supply pre-computed vectors directly, so ChromaDB never calls
 * `generate()`. Providing this stub instead of `null` suppresses the
 * "No embedding function configuration found" console warning that ChromaDB
 * emits when it deserialises a collection with no embedding function metadata.
 */
const NO_OP_EMBEDDING_FN: EmbeddingFunction = {
	generate: async (_texts: string[]) => [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Client creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a ChromaDB client instance.
 *
 * @param url - ChromaDB HTTP URL. Defaults to CHROMA_URL env var or http://localhost:8000.
 */
export function createChromaClient(url?: string): ChromaClient {
	const chromaUrl = url ?? process.env.CHROMA_URL ?? DEFAULT_CHROMA_URL;
	const parsed = new URL(chromaUrl);
	return new ChromaClient({
		host: parsed.hostname,
		port: parseInt(parsed.port || "8000", 10),
		ssl: parsed.protocol === "https:",
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the `codex_entities` collection, creating it if it doesn't exist.
 *
 * Uses `embeddingFunction: null` because we supply pre-computed vectors
 * from the embedding provider — ChromaDB should not attempt to embed.
 */
export async function getOrCreateEntityCollection(
	client: ChromaClient,
): Promise<Collection> {
	return client.getOrCreateCollection({
		name: COLLECTION_NAME,
		embeddingFunction: NO_OP_EMBEDDING_FN,
	});
}

/**
 * Drops and recreates the entity collection (for `--clean` flag).
 * Returns the fresh empty collection.
 */
export async function clearCollection(
	client: ChromaClient,
): Promise<Collection> {
	try {
		await client.deleteCollection({ name: COLLECTION_NAME });
	} catch {
		// Collection may not exist yet — that's fine
	}
	return getOrCreateEntityCollection(client);
}

/**
 * Verifies ChromaDB is reachable by calling the heartbeat endpoint.
 * @returns The heartbeat timestamp (nanoseconds) on success.
 * @throws If ChromaDB is unreachable.
 */
export async function verifyChromaConnectivity(
	client: ChromaClient,
): Promise<number> {
	const heartbeat = await client.heartbeat();
	if (typeof heartbeat !== "number" || heartbeat <= 0) {
		throw new Error(
			"ChromaDB heartbeat returned an unexpected value — is the server running?",
		);
	}
	return heartbeat;
}

/** Diagnostic info about a ChromaDB collection. */
export interface CollectionInfo {
	count: number;
	name: string;
}

/**
 * Returns diagnostic info about the entity collection.
 * Useful for debugging empty-results issues.
 */
export async function getCollectionInfo(
	client: ChromaClient,
): Promise<CollectionInfo> {
	const collection = await getOrCreateEntityCollection(client);
	const count = await collection.count();
	return { count, name: COLLECTION_NAME };
}

/**
 * Returns the set of entity nodeIds currently stored in ChromaDB.
 *
 * Used for embedding checkpointing: the caller can pass this set as
 * `skipIds` to `runEmbeddingPipeline` so that already-indexed entities
 * are skipped on re-run, avoiding redundant API calls and token spend.
 */
export async function getExistingIds(client: ChromaClient): Promise<Set<string>> {
	const collection = await getOrCreateEntityCollection(client);
	const count = await collection.count();
	if (count === 0) return new Set();
	// Fetch IDs only — no vectors, documents, or metadata loaded.
	const result = await collection.get({ limit: count, include: [] });
	return new Set(result.ids);
}
