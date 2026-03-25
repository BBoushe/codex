/**
 * @fileoverview Domain types for the git-miner package.
 *
 * `MineResult` is the handoff contract between git-miner and graph-client,
 * analogous to `FileParseResult[]` for the parser.
 */

// ─── Git data ─────────────────────────────────────────────────────────────────

/** A deduplicated developer extracted from git log. */
export interface DeveloperInfo {
	email: string;
	name: string;
	totalCommits: number;
}

/** A single commit extracted from git log. */
export interface CommitInfo {
	sha: string;
	message: string;
	/** ISO 8601 */
	timestamp: string;
	authorEmail: string;
	linesAdded: number;
	linesDeleted: number;
	/** Relative file paths touched by this commit. */
	filesChanged: string[];
}

/** Per-line blame attribution for a single file. */
export interface BlameLineInfo {
	/** 1-based line number in the current file. */
	line: number;
	authorEmail: string;
	authorName: string;
	commitSha: string;
	/** Unix epoch string from git porcelain output. */
	timestamp: string;
}

/** Full blame output for one file. */
export interface FileBlame {
	/** Relative to repo root. */
	filePath: string;
	lines: BlameLineInfo[];
}

/** Per-file add/delete counts for a single commit. */
export interface DiffStatEntry {
	filePath: string;
	linesAdded: number;
	linesDeleted: number;
}

// ─── Edge data (graph-client handoff) ────────────────────────────────────────

/** Produces a HAS_EXPERTISE edge (Developer → File). */
export interface ExpertiseRecord {
	developerEmail: string;
	/** nodeId of the File node. */
	fileNodeId: string;
	filePath: string;
	/** Normalized [0, 1]. */
	doaScore: number;
	rawDoa: number;
	isFirstAuthor: boolean;
	/** Number of commits by this developer to this file. */
	deliveries: number;
	/** Number of commits by OTHERS after this dev's last commit. */
	acceptances: number;
	/** ISO 8601 timestamp of last commit to this file by this developer. */
	lastContribution: string;
}

/** Produces a MODIFIED edge (Commit → Entity). */
export interface ModifiedRecord {
	commitSha: string;
	/** nodeId of the target entity (File, Function, Class, Component). */
	entityNodeId: string;
	linesAdded: number;
	linesDeleted: number;
}

/** Produces a COMMITTED edge (Developer → Commit). */
export interface CommittedRecord {
	developerEmail: string;
	commitSha: string;
}

// ─── DOA internals ────────────────────────────────────────────────────────────

/** Aggregated per-file history used to compute DOA. */
export interface FileHistory {
	filePath: string;
	/** nodeId of the File node. */
	fileNodeId: string;
	/** All commits that touched this file, in chronological order (oldest first). */
	commits: Array<{
		sha: string;
		authorEmail: string;
		/** ISO 8601 */
		timestamp: string;
	}>;
	currentBlame: FileBlame;
}

// ─── Truck Factor ─────────────────────────────────────────────────────────────

export interface TruckFactorResult {
	/** Minimum developers whose removal orphans >50% of files. */
	truckFactor: number;
	/** Developer emails in removal order (highest risk first). */
	criticalDevelopers: string[];
	/** How many files each developer "owns" (highest DOA). */
	ownershipCounts: Map<string, number>;
}

// ─── Code churn ───────────────────────────────────────────────────────────────

/** Churn metrics to be stored as File node properties. */
export interface FileChurn {
	fileNodeId: string;
	filePath: string;
	totalCommits: number;
	totalAdded: number;
	totalDeleted: number;
	/** (added + deleted) per month over the last 6 months. */
	churnRate: number;
}

// ─── Progress ─────────────────────────────────────────────────────────────────

export type MinePhase =
	| "log"
	| "blame"
	| "map"
	| "doa"
	| "insert"
	| "done";

export interface MineProgress {
	phase: MinePhase;
	current: number;
	total: number;
	detail?: string;
}

export type OnMineProgress = (progress: MineProgress) => void;

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface MineStats {
	developers: number;
	commits: number;
	filesBlamed: number;
	blameFailures: number;
	/** Paths of files that git blame returned no lines for (binary, deleted, etc.). */
	blameFailureFiles: string[];
	entitiesMapped: number;
	filesWithNoEntities: number;
	/** Paths of blamed files that had no matching entity nodes in the graph. */
	noEntityFiles: string[];
	expertiseEdges: number;
	modifiedEdges: number;
	modifiedEdgeFailures: number;
	durationMs: number;
}

// ─── Top-level result ─────────────────────────────────────────────────────────

/** The full output of the mining pipeline — consumed by graph-client's insertMineResults(). */
export interface MineResult {
	developers: DeveloperInfo[];
	commits: CommitInfo[];
	fileExpertise: ExpertiseRecord[];
	modifiedEdges: ModifiedRecord[];
	committedEdges: CommittedRecord[];
	churn: FileChurn[];
	truckFactor: TruckFactorResult;
	stats: MineStats;
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface MineOptions {
	onProgress?: OnMineProgress;
	/** Only process commits after this ISO 8601 date. */
	since?: string;
	/** Cap the number of commits processed (for large repos). */
	maxCommits?: number;
}

// ─── Entity line range (from Neo4j) ──────────────────────────────────────────

/** An entity node with its source line range — fetched from Neo4j for blame mapping. */
export interface EntityLineRange {
	nodeId: string;
	filePath: string;
	startLine: number;
	endLine: number;
	label: string;
}

/** Per-entity, per-developer attribution from current blame. */
export interface EntityAttribution {
	entityNodeId: string;
	developerEmail: string;
	lineCount: number;
	proportion: number;
}
