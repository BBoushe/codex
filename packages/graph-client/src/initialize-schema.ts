/**
 * @fileoverview Neo4j schema initialization.
 *
 * `initializeSchema` is called once during backend startup. It runs all
 * constraint and index creation statements against Neo4j. Because every
 * statement uses `IF NOT EXISTS`, the function is fully idempotent — safe
 * to call on every boot without accumulating duplicate constraints.
 *
 * ## Why not a shell script?
 * - No external tooling required (no `cypher-shell` binary in PATH).
 * - Runs after the driver has confirmed connectivity — no race condition
 *   with the Docker container becoming ready.
 * - TypeScript-native error reporting: a failed statement throws a typed
 *   error with the Cypher text included, making debugging straightforward.
 */

import type { Driver } from "neo4j-driver";

// ─────────────────────────────────────────────────────────────────────────────
// Schema statements
//
// Kept as a TypeScript constant (rather than a .cypher file read at runtime)
// so the graph-client package has no file-system dependency and works
// correctly regardless of the working directory from which the server starts.
//
// This array is the authoritative source. The schema.cypher file in this
// package is a human-readable reference copy — keep them in sync.
// NOTE: Think about this design descision later on.
// I don't think this is good for separation of concerns.
// Maybe we can have a .cypher file and read it at runtime. --- IGNORE ---
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_STATEMENTS: readonly string[] = [
	`
    CREATE CONSTRAINT file_nodeId IF NOT EXISTS
    FOR (n:File) REQUIRE n.nodeId IS UNIQUE;`,
	`
    CREATE CONSTRAINT directory_nodeId IF NOT EXISTS
    FOR (n:Directory) REQUIRE n.nodeId IS UNIQUE;`,
	`
    CREATE CONSTRAINT function_nodeId IF NOT EXISTS
    FOR (n:Function) REQUIRE n.nodeId IS UNIQUE;`,
	`
    CREATE CONSTRAINT class_nodeId IF NOT EXISTS
    FOR (n:Class) REQUIRE n.nodeId IS UNIQUE;`,
	`
    CREATE CONSTRAINT component_nodeId IF NOT EXISTS
    FOR (n:Component) REQUIRE n.nodeId IS UNIQUE;`,
	`
    CREATE CONSTRAINT hook_nodeId IF NOT EXISTS
    FOR (n:Hook) REQUIRE n.nodeId IS UNIQUE;`,
	`
    CREATE CONSTRAINT prop_nodeId IF NOT EXISTS
    FOR (n:Prop) REQUIRE n.nodeId IS UNIQUE;`,
	`
    CREATE CONSTRAINT developer_nodeId IF NOT EXISTS
    FOR (n:Developer) REQUIRE n.nodeId IS UNIQUE;`,

	`CREATE CONSTRAINT commit_nodeId IF NOT EXISTS
    FOR (n:Commit) REQUIRE n.nodeId IS UNIQUE;`,

	`CREATE CONSTRAINT file_path_unique IF NOT EXISTS
    FOR (n:File) REQUIRE n.filePath IS UNIQUE;`,

	`CREATE CONSTRAINT directory_path_unique IF NOT EXISTS
    FOR (n:Directory) REQUIRE n.path IS UNIQUE;`,

	`CREATE CONSTRAINT developer_email_unique IF NOT EXISTS
    FOR (n:Developer) REQUIRE n.email IS UNIQUE;`,

	`CREATE CONSTRAINT commit_sha_unique IF NOT EXISTS
    FOR (n:Commit) REQUIRE n.sha IS UNIQUE;`,

	`CREATE INDEX function_name IF NOT EXISTS
    FOR (n:Function) ON (n.name);`,

	`CREATE INDEX class_name IF NOT EXISTS
    FOR (n:Class) ON (n.name);`,

	`CREATE INDEX component_name IF NOT EXISTS
    FOR (n:Component) ON (n.name);`,

	`CREATE INDEX hook_hookType IF NOT EXISTS
    FOR (n:Hook) ON (n.hookType);`,

	`CREATE INDEX prop_name IF NOT EXISTS
    FOR (n:Prop) ON (n.name);`,

	`CREATE INDEX function_filePath IF NOT EXISTS
    FOR (n:Function) ON (n.filePath);`,

	`CREATE INDEX class_filePath IF NOT EXISTS
    FOR (n:Class) ON (n.filePath);`,

	`CREATE INDEX component_filePath IF NOT EXISTS
    FOR (n:Component) ON (n.filePath);`,

	`CREATE INDEX developer_name IF NOT EXISTS
    FOR (n:Developer) ON (n.name);`,

	`CREATE INDEX commit_timestamp IF NOT EXISTS
    FOR (n:Commit) ON (n.timestamp);`,

	`CREATE INDEX function_file_name IF NOT EXISTS
    FOR (n:Function) ON (n.filePath, n.name);`,

	`CREATE INDEX component_file_name IF NOT EXISTS
    FOR (n:Component) ON (n.filePath, n.name);`,

	`CREATE INDEX class_file_name IF NOT EXISTS
    FOR (n:Class) ON (n.filePath, n.name);`,
];

export interface SchemaInitResult {
	/** num of statements executed successfully*/
	statementsRun: number;
	/** full initialization in ms */
	durationMs: number;
}

/**
 * Runs all Neo4j constraint and index creation statements.
 *
 * Call this once during application startup, before accepting any requests.
 * The function opens its own session and closes it when complete.
 *
 * @throws If any statement fails (other than "already exists", which Neo4j
 *   handles via `IF NOT EXISTS` and never throws for).
 *
 * @example
 * ```ts
 * import neo4j from "neo4j-driver";
 * import { initializeSchema } from "@codex/graph-client";
 *
 * const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(user, password));
 * await initializeSchema(driver);
 * ```
 */
export async function initializeSchema(
	driver: Driver,
): Promise<SchemaInitResult> {
	const start = Date.now();
	const session = driver.session();

	try {
		for (const statement of SCHEMA_STATEMENTS) {
			try {
				await session.run(statement);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Neo4j schema initialization failed \n` +
						`Statement:\n${statement.trim()}\n\n` +
						`Error: ${message}`,
				{ cause: error },
				);
			}
		}

		return {
			statementsRun: SCHEMA_STATEMENTS.length,
			durationMs: Date.now() - start,
		};
	} finally {
		await session.close();
	}
}

// Reminder for later on

/**
 * ## Re-ingestion Strategy
 *
 * nodeIds are deterministic (hash of label + location + name), so MERGE updates
 * nodes in place when a function's body changes but its identity doesn't.
 *
 * However, nothing automatically removes nodes for deleted or renamed entities —
 * those become ghosts in the graph. To avoid stale data, the default ingestion
 * mode wipes the database before re-ingesting:
 *
 *   `codex ingest ./repo`              → MATCH (n) DETACH DELETE n, then re-ingest
 *   `codex ingest ./repo --incremental` → N7 (Nice-to-Have, not implemented)
 *
 * This makes full re-ingestion the source of truth. For ≤50k LOC it takes
 * seconds, which is acceptable for the thesis prototype.
 *
 * Consequence for insertion queries: always use MERGE (not CREATE) as the
 * write primitive — it's idempotent within a single run and handles the case
 * where two files export an entity with the same name.
 *
 * this is the same limitation commercial tools like Sourcegraph face at small scale,
 *  and it's why they implement incremental
 *  indexing as a significant engineering effort separate from the core analysis.
 */
