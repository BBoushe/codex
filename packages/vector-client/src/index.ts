// ChromaDB client management
export {
	createChromaClient,
	getOrCreateEntityCollection,
	clearCollection,
	verifyChromaConnectivity,
	COLLECTION_NAME,
} from "./client.js";

// Batch upsert
export { upsertEmbeddings, type UpsertResult } from "./inserter.js";

// Vector search
export { searchEntities } from "./searcher.js";

// Context formatting
export { formatContextString } from "./contextFormatter.js";

// Retry utility
export { withRetry, type RetryOptions } from "./retry.js";

// Pipeline orchestrator
export {
	fetchEmbeddableNodes,
	runEmbeddingPipeline,
	type PipelineOptions,
} from "./pipeline.js";

// Types
export type {
	EmbeddableEntity,
	ChromaEntityMetadata,
	VectorSearchResult,
	EmbedStats,
	EmbedFailure,
	RawEntityRecord,
} from "./types.js";
