/**
 * @fileoverview Shared types for the vector embedding pipeline.
 *
 * These types flow between: Neo4j (source) → context formatter → embedding API → ChromaDB (sink).
 * The `nodeId` field is the deterministic cross-reference key shared with Neo4j.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Entity ready for embedding (fetched from Neo4j, formatted)
// ─────────────────────────────────────────────────────────────────────────────

/** An entity fetched from Neo4j and prepared for embedding. */
export interface EmbeddableEntity {
	/** Deterministic 16-char hex hash — shared with Neo4j, used as ChromaDB record ID. */
	nodeId: string;
	/** Short entity name (e.g. "fetchUser"). */
	name: string;
	/** Scoped name (e.g. "src/api/user.ts::fetchUser"). */
	qualifiedName: string;
	/** Relative file path (e.g. "src/api/user.ts"). */
	filePath: string;
	/** NodeLabel value: "Function", "Class", "Component", or "Hook". */
	label: string;
	/** Source language from parent FileNode (e.g. "TypeScript", "Python"). */
	language: string;
	/** First line of the entity in the source file. */
	startLine: number;
	/** Last line of the entity in the source file. */
	endLine: number;
	/** Whether the entity is exported from its module. */
	isExported: boolean;
	/** The formatted context string sent to the embedding model. */
	contextString: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ChromaDB metadata — must be scalar types only (string | number | boolean)
// ─────────────────────────────────────────────────────────────────────────────

/** Metadata stored alongside each vector in ChromaDB. */
export interface ChromaEntityMetadata {
	nodeId: string;
	name: string;
	qualifiedName: string;
	filePath: string;
	label: string;
	language: string;
	startLine: number;
	endLine: number;
	isExported: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search results
// ─────────────────────────────────────────────────────────────────────────────

/** A single result from a vector similarity search. */
export interface VectorSearchResult {
	nodeId: string;
	name: string;
	qualifiedName: string;
	filePath: string;
	label: string;
	language: string;
	startLine: number;
	endLine: number;
	/** Cosine distance (lower = more similar). */
	distance: number;
	/** The context string stored as the ChromaDB document. */
	document: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline stats and failures
// ─────────────────────────────────────────────────────────────────────────────

/** Summary statistics returned after an embedding pipeline run. */
export interface EmbedStats {
	entitiesEmbedded: number;
	entitiesFailed: number;
	totalTokens: number;
	durationMs: number;
	model: string;
	collectionName: string;
	/** Approximate USD cost based on provider pricing. */
	estimatedCost: number;
	/** Individual failure records, if any. */
	failures: EmbedFailure[];
	/** Number of entities skipped due to checkpointing (already in ChromaDB). */
	cachedCount?: number;
	/** Number of File metadata documents included (context enrichment). */
	fileCount?: number;
}

/** A single entity that failed during embedding or indexing. */
export interface EmbedFailure {
	nodeId: string;
	name: string;
	error: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw entity record from Neo4j query (before formatting)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape of a single row returned by the `fetchEmbeddableNodes` Cypher query.
 * All fields are nullable because Neo4j returns null for missing properties.
 */
export interface RawEntityRecord {
	nodeId: string;
	name: string;
	qualifiedName: string;
	filePath: string;
	label: string;
	language: string;
	startLine: number;
	endLine: number;
	isExported: boolean;
	sourceCode: string | null;
	// Function-specific
	parameters: string[] | null;
	returnType: string | null;
	// Class-specific
	methods: string[] | null;
	parentClass: string | null;
	// Component-specific
	componentKind: string | null;
	props: string[] | null;
	renderedComponents: string[] | null;
	// Hook-specific
	hookType: string | null;
	returnBindings: string[] | null;
	dependencies: string[] | null;
	arguments: string[] | null;
	// File-specific (for context enrichment)
	loc: number | null;
	extension: string | null;
	totalCommits: number | null;
	churnRate: number | null;
	totalAdded: number | null;
	totalDeleted: number | null;
}
