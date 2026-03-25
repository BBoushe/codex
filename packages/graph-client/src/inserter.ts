/**
 * @fileoverview Neo4j batch insertion layer
 *
 * Consumes FileParseResult[] from the parser and writes all nodes + edges
 * to Neo4j using UNWIND-based batch upserts. Two-pass strategy:
 *   Pass 1 — nodes (grouped by label, chunked by BATCH_SIZE)
 *   Pass 2 — edges (grouped by type, chunked by BATCH_SIZE)
 *
 * Nodes must exist before edges — the linker resolves cross-file references
 * (CALLS, RENDERS, etc.) by nodeId, so an edge written before its endpoint
 * node exists will MATCH nothing and be silently dropped.
 *
 * Performance note: MERGE targets (nodeId per label) are all covered by the
 * uniqueness constraints in schema.cypher, which create implicit B-tree
 * indexes. initializeSchema() must be called before insertParseResults().
 */

import type { Driver, Session } from "neo4j-driver";
import type { FileParseResult, CodexNode, CodexEdge } from "@codex/shared";
import { nodeIdForDeveloper, nodeIdForCommit } from "@codex/shared";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Max rows per Bolt message. 500 is a safe default; raise to 1000 if Neo4j
 *  is not the bottleneck (profile first). */
const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InsertStats {
	filesInserted: number;
	nodesInserted: number;
	edgesInserted: number;
	durationMs: number;
	nodesByLabel: Record<string, number>;
	edgesByType: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Internal row shapes sent to Cypher via $batch
// ---------------------------------------------------------------------------

/** Flat property bag for a node upsert row. nodeId is required. */
type NodeRow = Record<string, unknown> & { nodeId: string };

/** Edge row: routing keys + property bag for the relationship itself. */
interface EdgeRow {
	fromId: string;
	toId: string;
	props: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cypher templates
// ---------------------------------------------------------------------------

/** MERGE by nodeId (covered by uniqueness constraint index), then overwrite
 *  all properties. Backtick-quoting the label handles any label string safely. */
function nodeUpsertCypher(label: string): string {
	return `
    UNWIND $batch AS n
    MERGE (node:\`${label}\` {nodeId: n.nodeId})
    SET node += n
  `;
}

/** MATCH both endpoints by nodeId — the uniqueness constraint indexes on each
 *  label make this fast without needing to specify a label on the MATCH.
 *  MERGE the relationship, then set any edge properties. */
function edgeUpsertCypher(type: string): string {
	return `
    UNWIND $batch AS r
    MATCH (a {nodeId: r.fromId})
    MATCH (b {nodeId: r.toId})
    MERGE (a)-[rel:\`${type}\`]->(b)
    SET rel += r.props
  `;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/**
 * Strip `undefined` values before sending to the Neo4j driver, which rejects
 * them (they are not a valid property type). `null` is preserved — it is a
 * valid Neo4j property and semantically distinct from "property absent".
 *
 * In a property graph, an absent property and `null` are equivalent in Cypher
 * (`n.prop IS NULL` matches both), so stripping `undefined` is the right
 * behaviour for optional schema fields — it keeps nodes clean rather than
 * storing `propType: null` on every Function that lacks a return annotation.
 *
 * Required fields (nodeId, filePath, etc.) should never be undefined; if they
 * are, that is a visitor bug and will surface as a downstream MERGE failure
 * rather than silently corrupting data.
 */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(obj).filter(([, v]) => v !== undefined),
	);
}

/**
 * Flatten a CodexNode (which has a strongly-typed shape) into a plain
 * property bag safe to send over Bolt. We cast through `unknown` because
 * TypeScript's index signature requirement is a compile-time constraint —
 * at runtime the object is already a plain property bag.
 */
function nodeToRow(node: CodexNode): NodeRow {
	const row = stripUndefined(node as unknown as Record<string, unknown>);
	if (!row["nodeId"]) {
		throw new Error(
			`[inserter] Node is missing required 'nodeId' field: ${JSON.stringify(node)}`,
		);
	}
	return row as NodeRow;
}

/**
 * Flatten a CodexEdge into an EdgeRow. The `type` discriminant is used for
 * bucket routing and then excluded from the props sent to Neo4j (the
 * relationship type is encoded structurally, not as a property).
 */
function edgeToRow(
	sourceId: string,
	targetId: string,
	edge: CodexEdge,
): EdgeRow {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { type, ...rest } = edge as Record<string, unknown>;
	return {
		fromId: sourceId,
		toId: targetId,
		props: stripUndefined(rest),
	};
}

// ---------------------------------------------------------------------------
// Session-level batch writers
// ---------------------------------------------------------------------------

async function writeNodeBatch(
	session: Session,
	label: string,
	rows: NodeRow[],
): Promise<void> {
	if (rows.length === 0) return;
	const cypher = nodeUpsertCypher(label);
	for (const batch of chunk(rows, BATCH_SIZE)) {
		await session.run(cypher, { batch });
	}
}

async function writeEdgeBatch(
	session: Session,
	type: string,
	rows: EdgeRow[],
): Promise<void> {
	if (rows.length === 0) return;
	const cypher = edgeUpsertCypher(type);
	for (const batch of chunk(rows, BATCH_SIZE)) {
		await session.run(cypher, { batch });
	}
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * insertParseResults — batch-write the full parser output into Neo4j.
 *
 * Accumulates nodes into per-label buckets and edges into per-type buckets,
 * then flushes nodes (Pass 1) followed by edges (Pass 2). Stats are
 * accumulated during the flush loops — no second pass needed.
 */
export async function insertParseResults(
	driver: Driver,
	results: FileParseResult[],
): Promise<InsertStats> {
	const t0 = Date.now();

	// ---- Bucket collection ---------------------------------------------------

	const nodesByLabel = new Map<string, NodeRow[]>();
	const edgesByType = new Map<string, EdgeRow[]>();

	const pushNode = (label: string, node: CodexNode) => {
		if (!nodesByLabel.has(label)) nodesByLabel.set(label, []);
		nodesByLabel.get(label)!.push(nodeToRow(node));
	};

	const pushEdge = (sourceId: string, targetId: string, edge: CodexEdge) => {
		const type = (edge as Record<string, unknown>)["type"] as string;
		if (!type) {
			console.warn(
				`[inserter] Edge missing 'type' — skipping: ${sourceId} → ${targetId}`,
			);
			return;
		}
		if (!edgesByType.has(type)) edgesByType.set(type, []);
		edgesByType.get(type)!.push(edgeToRow(sourceId, targetId, edge));
	};

	for (const result of results) {
		// File node (always present, directly on result)
		pushNode(result.file.label, result.file);

		// Entity nodes (unwrap the ParsedEntity wrapper)
		for (const { node } of result.entities) {
			pushNode(node.label, node);
		}

		// Relationships (sourceId / targetId / edge per schema)
		for (const { sourceId, targetId, edge } of result.relationships) {
			pushEdge(sourceId, targetId, edge);
		}
	}

	// ---- Pass 1: nodes — accumulate stats during flush ----------------------

	const nodesByLabelStats: Record<string, number> = {};
	let totalNodes = 0;

	const session: Session = driver.session();
	try {
		for (const [label, rows] of nodesByLabel) {
			await writeNodeBatch(session, label, rows);
			nodesByLabelStats[label] = rows.length;
			totalNodes += rows.length;
		}

		// ---- Pass 2: edges — accumulate stats during flush --------------------

		const edgesByTypeStats: Record<string, number> = {};
		let totalEdges = 0;

		for (const [type, rows] of edgesByType) {
			await writeEdgeBatch(session, type, rows);
			edgesByTypeStats[type] = rows.length;
			totalEdges += rows.length;
		}

		return {
			filesInserted: results.length,
			nodesInserted: totalNodes,
			edgesInserted: totalEdges,
			durationMs: Date.now() - t0,
			nodesByLabel: nodesByLabelStats,
			edgesByType: edgesByTypeStats,
		};
	} finally {
		await session.close();
	}
}

// ---------------------------------------------------------------------------
// Wipe helper — intentionally separate so the CLI can gate it behind --clean
// ---------------------------------------------------------------------------

/**
 * Wipe all mining data (Developer/Commit nodes + their edges, churn props on
 * File nodes) while leaving the structural graph intact.
 */
export async function clearMineData(driver: Driver): Promise<void> {
	const session = driver.session();
	try {
		await session.run("MATCH (d:Developer) DETACH DELETE d");
		await session.run("MATCH (c:Commit) DETACH DELETE c");
		await session.run(
			"MATCH (f:File) REMOVE f.totalCommits, f.totalAdded, f.totalDeleted, f.churnRate",
		);
	} finally {
		await session.close();
	}
}

/**
 * Drop all nodes and relationships. On large graphs this is slower than
 * dropping the database, but works without Community Edition admin privileges.
 */
export async function clearGraph(driver: Driver): Promise<void> {
	const session = driver.session();
	try {
		await session.run("MATCH (n) DETACH DELETE n");
	} finally {
		await session.close();
	}
}

// ---------------------------------------------------------------------------
// Mine result types (defined here to avoid circular dep with @codex/git-miner)
// ---------------------------------------------------------------------------

/** An entity node with its source line range. Returned by fetchEntityLineRanges(). */
export interface EntityLineRange {
	nodeId: string;
	filePath: string;
	startLine: number;
	endLine: number;
	label: string;
}

/** Stats returned by insertMineResults(). */
export interface MineInsertStats {
	developersInserted: number;
	commitsInserted: number;
	committedEdges: number;
	modifiedEdges: number;
	expertiseEdges: number;
	churnFilesUpdated: number;
	durationMs: number;
}

/**
 * Shape expected by insertMineResults(). Mirrors git-miner's MineResult
 * without a direct import to avoid circular package dependency.
 */
export interface MineInsertInput {
	developers: Array<{ email: string; name: string; totalCommits: number }>;
	commits: Array<{
		sha: string;
		message: string;
		timestamp: string;
		authorEmail: string;
		linesAdded: number;
		linesDeleted: number;
	}>;
	committedEdges: Array<{ developerEmail: string; commitSha: string }>;
	modifiedEdges: Array<{ commitSha: string; entityNodeId: string; linesAdded: number; linesDeleted: number }>;
	fileExpertise: Array<{
		developerEmail: string;
		fileNodeId: string;
		doaScore: number;
		isFirstAuthor: boolean;
		deliveries: number;
		acceptances: number;
		lastContribution: string;
	}>;
	churn: Array<{
		fileNodeId: string;
		totalCommits: number;
		totalAdded: number;
		totalDeleted: number;
		churnRate: number;
	}>;
}

// ---------------------------------------------------------------------------
// Mine insertion
// ---------------------------------------------------------------------------

/**
 * insertMineResults — batch-write git mining output into Neo4j.
 *
 * Three passes:
 *   Pass 1 — Developer + Commit nodes
 *   Pass 2 — COMMITTED, MODIFIED, HAS_EXPERTISE edges
 *   Pass 3 — File property updates (churn metrics)
 *
 * Depends on File/entity nodes from a prior insertParseResults() call.
 * MODIFIED edges whose target nodeId is absent will silently fail (MATCH miss);
 * this is expected for deleted files.
 */
export async function insertMineResults(
	driver: Driver,
	input: MineInsertInput,
): Promise<MineInsertStats> {
	const t0 = Date.now();
	const session: Session = driver.session();

	try {
		// ── Pass 1: Developer nodes ────────────────────────────────────────────
		const devRows = input.developers.map((d) =>
			stripUndefined({
				nodeId: nodeIdForDeveloper(d.email),
				name: d.name,
				email: d.email,
				qualifiedName: d.email,
				totalCommits: d.totalCommits,
				label: "Developer",
			}),
		);
		await writeNodeBatch(session, "Developer", devRows as NodeRow[]);

		// ── Pass 1: Commit nodes ───────────────────────────────────────────────
		const commitRows = input.commits.map((c) =>
			stripUndefined({
				nodeId: nodeIdForCommit(c.sha),
				name: c.sha.slice(0, 8),
				qualifiedName: c.sha.slice(0, 8),
				sha: c.sha,
				message: c.message.slice(0, 200), // cap length for storage
				timestamp: c.timestamp,
				linesAdded: c.linesAdded,
				linesDeleted: c.linesDeleted,
				label: "Commit",
			}),
		);
		await writeNodeBatch(session, "Commit", commitRows as NodeRow[]);

		// ── Pass 2: COMMITTED edges ────────────────────────────────────────────
		const committedRows: EdgeRow[] = input.committedEdges.map((e) => ({
			fromId: nodeIdForDeveloper(e.developerEmail),
			toId: nodeIdForCommit(e.commitSha),
			props: {},
		}));
		await writeEdgeBatch(session, "COMMITTED", committedRows);

		// ── Pass 2: MODIFIED edges ─────────────────────────────────────────────
		const modifiedRows: EdgeRow[] = input.modifiedEdges.map((e) => ({
			fromId: nodeIdForCommit(e.commitSha),
			toId: e.entityNodeId,
			props: stripUndefined({ linesAdded: e.linesAdded, linesDeleted: e.linesDeleted }),
		}));
		await writeEdgeBatch(session, "MODIFIED", modifiedRows);

		// ── Pass 2: HAS_EXPERTISE edges ────────────────────────────────────────
		const expertiseRows: EdgeRow[] = input.fileExpertise.map((e) => ({
			fromId: nodeIdForDeveloper(e.developerEmail),
			toId: e.fileNodeId,
			props: stripUndefined({
				doaScore: e.doaScore,
				isFirstAuthor: e.isFirstAuthor,
				deliveries: e.deliveries,
				acceptances: e.acceptances,
				lastContribution: e.lastContribution,
			}),
		}));
		await writeEdgeBatch(session, "HAS_EXPERTISE", expertiseRows);

		// ── Pass 3: File churn property updates ───────────────────────────────
		const churnRows = input.churn.map((c) =>
			stripUndefined({
				fileNodeId: c.fileNodeId,
				totalCommits: c.totalCommits,
				totalAdded: c.totalAdded,
				totalDeleted: c.totalDeleted,
				churnRate: c.churnRate,
			}),
		);

		if (churnRows.length > 0) {
			const churnCypher = `
        UNWIND $batch AS row
        MATCH (f:File {nodeId: row.fileNodeId})
        SET f.totalCommits = row.totalCommits,
            f.totalAdded   = row.totalAdded,
            f.totalDeleted = row.totalDeleted,
            f.churnRate    = row.churnRate
      `;
			for (const batch of chunk(churnRows, BATCH_SIZE)) {
				await session.run(churnCypher, { batch });
			}
		}

		return {
			developersInserted: devRows.length,
			commitsInserted: commitRows.length,
			committedEdges: committedRows.length,
			modifiedEdges: modifiedRows.length,
			expertiseEdges: expertiseRows.length,
			churnFilesUpdated: churnRows.length,
			durationMs: Date.now() - t0,
		};
	} finally {
		await session.close();
	}
}

// ---------------------------------------------------------------------------
// Entity line range reader (used by git-miner's blame mapper)
// ---------------------------------------------------------------------------

/**
 * Fetches entity nodes with source line ranges for a given file.
 * Called by the git-miner orchestrator to map blame data to graph entities.
 *
 * @param driver   - Neo4j driver (must have entities from a prior ingest run)
 * @param filePath - Relative file path (as stored on File nodes)
 */
export async function fetchEntityLineRanges(
	driver: Driver,
	filePath: string,
): Promise<EntityLineRange[]> {
	const session = driver.session();
	try {
		const result = await session.run(
			`
      MATCH (n)-[:DEFINED_IN]->(f:File {filePath: $filePath})
      WHERE n.startLine IS NOT NULL AND n.endLine IS NOT NULL
      RETURN n.nodeId AS nodeId,
             n.filePath AS filePath,
             n.startLine AS startLine,
             n.endLine AS endLine,
             labels(n)[0] AS label
      `,
			{ filePath },
		);

		return result.records.map((r) => ({
			nodeId: r.get("nodeId") as string,
			filePath: r.get("filePath") as string,
			startLine: (r.get("startLine") as number),
			endLine: (r.get("endLine") as number),
			label: r.get("label") as string,
		}));
	} finally {
		await session.close();
	}
}

/**
 * Returns the count of File nodes in the graph.
 * Used by the mine orchestrator to validate that ingest has been run first.
 */
export async function countFileNodes(driver: Driver): Promise<number> {
	const session = driver.session();
	try {
		const result = await session.run(
			"MATCH (f:File) RETURN count(f) AS cnt",
		);
		return (result.records[0]?.get("cnt") as number) ?? 0;
	} finally {
		await session.close();
	}
}

/**
 * Fetches all File nodeIds keyed by filePath.
 * Used by computeChurn() to map git file paths to graph nodeIds.
 */
export async function fetchFileNodeIds(
	driver: Driver,
): Promise<Map<string, string>> {
	const session = driver.session();
	try {
		const result = await session.run(
			"MATCH (f:File) RETURN f.filePath AS filePath, f.nodeId AS nodeId",
		);
		const map = new Map<string, string>();
		for (const record of result.records) {
			const fp = record.get("filePath") as string;
			const nodeId = record.get("nodeId") as string;
			if (fp && nodeId) map.set(fp, nodeId);
		}
		return map;
	} finally {
		await session.close();
	}
}

