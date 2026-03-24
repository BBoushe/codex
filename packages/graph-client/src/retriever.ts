/**
 * @fileoverview Graph context retrieval for the hybrid RAG pipeline.
 *
 * Provides:
 *   - expandContext()    — full graph expansion around a single anchor node
 *   - structuralQuery()  — direct Cypher queries for structural patterns
 *   - findShortestPath() — multi-hop path finding (Week 8 scaffold)
 *
 * All queries are language-agnostic: React-specific edges (RENDERS, USES_HOOK)
 * return empty arrays for Python/Java nodes. The `label` and `file.language`
 * fields tell consumers what kind of entity they're dealing with.
 *
 * Types are defined here (not in @codex/rag) to avoid a circular dependency:
 *   packages/rag → packages/graph-client → packages/rag ✗
 */

import type { Driver } from "neo4j-driver";
import { GRAPH_SCHEMA } from "./schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types (exported so @codex/rag can import them)
// ─────────────────────────────────────────────────────────────────────────────

/** A related entity retrieved during graph context expansion. */
export interface RelatedEntity {
	nodeId: string;
	name: string;
	qualifiedName: string;
	filePath: string;
	label: string;
	sourceCode: string | null;
	callSiteLine?: number;
}

/** Developer expertise from HAS_EXPERTISE edges. */
export interface DeveloperExpertise {
	name: string;
	email: string;
	doaScore: number;
	isFirstAuthor: boolean;
	lastContribution: string | null;
}

/** Imported file reference. */
export interface ImportedFile {
	filePath: string;
	language: string;
}

/** Full graph expansion around a single anchor node. */
export interface ExpandedContext {
	target: {
		nodeId: string;
		name: string;
		qualifiedName: string;
		label: string;
		filePath: string;
		sourceCode: string | null;
		startLine: number;
		endLine: number;
	};
	file: { filePath: string; language: string } | null;
	callers: RelatedEntity[];
	callees: RelatedEntity[];
	renderedComponents: RelatedEntity[];
	hooksUsed: RelatedEntity[];
	importedFiles: ImportedFile[];
	developers: DeveloperExpertise[];
}

/**
 * Structural query patterns — language-agnostic across TS/JS, Python, Java.
 *
 * Week 8 patterns (implements, decorators, overrides) are scaffolded but
 * not yet wired to Cypher queries.
 */
export type StructuralPattern =
	// Universal (all languages)
	| "what_imports"
	| "imported_by"
	| "what_calls"
	| "called_by"
	| "defined_in"
	| "exports"
	// OOP (Java, Python, TS classes)
	| "inherits_from"
	| "inherited_by"
	| "implements" // Week 8 — depends on interface nodes in parser
	// React/component-specific
	| "renders"
	| "rendered_by"
	| "uses_hook"
	| "accepts_props"
	// Week 8 scaffolds
	| "decorators" // Week 8 — depends on decorator extraction in parser
	| "overrides"; // Week 8 — depends on method override detection in parser

/** Result from a structural (Cypher-direct) query. No LLM involved. */
export interface StructuralQueryResult {
	pattern: StructuralPattern;
	query: string;
	entities: Array<{
		nodeId: string;
		name: string;
		qualifiedName: string;
		filePath: string;
		label: string;
		startLine?: number;
		endLine?: number;
	}>;
}

/** Multi-hop path result (Week 8). */
export interface PathQueryResult {
	path: Array<{
		nodeId: string;
		name: string;
		qualifiedName: string;
		label: string;
		filePath: string;
	}>;
	edgeTypes: string[];
	hops: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural query spec (schema-driven, replaces hardcoded patterns)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A structured query specification produced by the LLM intent classifier.
 *
 * The LLM reasons about the graph schema and outputs this spec. A deterministic
 * builder converts it to safe Cypher — no raw Cypher from the LLM.
 *
 * Covers single-hop traversals:
 *   "What calls fetchPosts?" → { from: {}, edge: "CALLS", direction: "incoming", to: { name: "fetchPosts" } }
 *   "What does App render?"  → { from: { label: "Component", name: "App" }, edge: "RENDERS", direction: "outgoing", to: {} }
 */
export interface StructuralQuerySpec {
	/** Constraints on the source node. Empty object = any node. */
	from: NodeFilter;
	/** The relationship type to traverse. */
	edge: string;
	/** "outgoing": from→to, "incoming": to→from. */
	direction: "outgoing" | "incoming";
	/** Constraints on the target node. Empty object = any node. */
	to: NodeFilter;
}

export interface NodeFilter {
	/** Optional label constraint (e.g. "Function", "Component"). */
	label?: string;
	/** Match by name or qualifiedName. */
	name?: string;
	/** Match by filePath (exact or CONTAINS). */
	filePath?: string;
}

/**
 * Executes a StructuralQuerySpec against Neo4j.
 *
 * Deterministically builds a safe Cypher query from the spec. If the edge type
 * is not in the graph schema, returns empty results (graceful degradation).
 */
export async function executeStructuralSpec(
	driver: Driver,
	spec: StructuralQuerySpec,
	originalQuery: string,
): Promise<StructuralQueryResult> {
	// Validate edge type against schema
	const knownEdge = GRAPH_SCHEMA.edges.find((e) => e.type === spec.edge);
	if (!knownEdge) {
		return {
			pattern: spec.edge as StructuralPattern,
			query: originalQuery,
			entities: [],
		};
	}

	const { cypher, params } = buildCypherFromSpec(spec);
	const session = driver.session({ database: "neo4j" });

	try {
		const result = await session.run(cypher, params);

		const entities = result.records.map((record) => ({
			nodeId: (record.get("nodeId") as string | null) ?? "",
			name: (record.get("name") as string | null) ?? "",
			qualifiedName: (record.get("qualifiedName") as string | null) ?? "",
			filePath: (record.get("filePath") as string | null) ?? "",
			label: (record.get("label") as string | null) ?? "",
			startLine: record.has("startLine")
				? toNumber(record.get("startLine"))
				: undefined,
			endLine: record.has("endLine")
				? toNumber(record.get("endLine"))
				: undefined,
		}));

		return {
			pattern: spec.edge as StructuralPattern,
			query: originalQuery,
			entities,
		};
	} finally {
		await session.close();
	}
}

/**
 * Deterministically builds a Cypher query from a StructuralQuerySpec.
 *
 * The "from" node is always the one the user is asking FROM (the subject),
 * and "to" is the result they want. Direction controls the arrow:
 *   outgoing: (from)-[:EDGE]->(to)   — "What does X call?"
 *   incoming: (from)<-[:EDGE]-(to)   — "What calls X?"
 *
 * In both cases, the RETURN is the "result" side — the unknown entity.
 */
function buildCypherFromSpec(spec: StructuralQuerySpec): {
	cypher: string;
	params: Record<string, string>;
} {
	const params: Record<string, string> = {};

	// Build node patterns
	const fromLabel = spec.from.label ? `:${spec.from.label}` : "";
	const toLabel = spec.to.label ? `:${spec.to.label}` : "";

	// Build WHERE clauses
	const whereClauses: string[] = [];
	let paramIdx = 0;

	if (spec.from.name) {
		const p = `p${paramIdx++}`;
		params[p] = spec.from.name;
		whereClauses.push(`(fromNode.name = $${p} OR fromNode.qualifiedName = $${p})`);
	}
	if (spec.from.filePath) {
		const p = `p${paramIdx++}`;
		params[p] = spec.from.filePath;
		whereClauses.push(`(fromNode.filePath CONTAINS $${p} OR fromNode.filePath = $${p})`);
	}
	if (spec.to.name) {
		const p = `p${paramIdx++}`;
		params[p] = spec.to.name;
		whereClauses.push(`(toNode.name = $${p} OR toNode.qualifiedName = $${p})`);
	}
	if (spec.to.filePath) {
		const p = `p${paramIdx++}`;
		params[p] = spec.to.filePath;
		whereClauses.push(`(toNode.filePath CONTAINS $${p} OR toNode.filePath = $${p})`);
	}

	const whereStr =
		whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

	// Build MATCH pattern based on direction.
	//
	// The graph always stores edges as (source)-[:EDGE]->(target).
	// The spec's `from` and `to` describe the user's perspective:
	//   "outgoing": from is the known node, to is the unknown result
	//     → MATCH (fromNode)-[:EDGE]->(toNode), RETURN toNode
	//   "incoming": to is the known node, from is the unknown result
	//     → MATCH (fromNode)-[:EDGE]->(toNode), RETURN fromNode
	//
	// Both directions use the same MATCH pattern — only the RETURN changes.
	const matchPattern = `MATCH (fromNode${fromLabel})-[:${spec.edge}]->(toNode${toLabel})`;

	// The "result" is the unknown side — the one WITHOUT the user's filter.
	const resultVar =
		spec.direction === "outgoing" ? "toNode" : "fromNode";

	const cypher = `
		${matchPattern}
		${whereStr}
		RETURN
			${resultVar}.nodeId AS nodeId,
			${resultVar}.name AS name,
			${resultVar}.qualifiedName AS qualifiedName,
			${resultVar}.filePath AS filePath,
			labels(${resultVar})[0] AS label,
			${resultVar}.startLine AS startLine,
			${resultVar}.endLine AS endLine
	`;

	return { cypher, params };
}

// ─────────────────────────────────────────────────────────────────────────────
// Context expansion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expands the graph context around a single anchor node.
 *
 * Fetches: target metadata, file info, callers, callees, rendered components,
 * hooks used, imported files (file-level), and developer expertise.
 *
 * Single Cypher query with OPTIONAL MATCHes — no cartesian product risk since
 * all branches are collected via collect(DISTINCT ...).
 */
export async function expandContext(
	driver: Driver,
	nodeId: string,
): Promise<ExpandedContext | null> {
	const session = driver.session({ database: "neo4j" });

	try {
		const result = await session.run(
			`
			MATCH (target {nodeId: $nodeId})
			OPTIONAL MATCH (target)-[:DEFINED_IN]->(file:File)
			OPTIONAL MATCH (caller)-[callsIn:CALLS]->(target)
			OPTIONAL MATCH (target)-[callsOut:CALLS]->(callee)
			OPTIONAL MATCH (target)-[:RENDERS]->(rendered:Component)
			OPTIONAL MATCH (target)-[:USES_HOOK]->(hook:Hook)
			OPTIONAL MATCH (file)-[:IMPORTS]->(importedFile:File)
			OPTIONAL MATCH (dev:Developer)-[exp:HAS_EXPERTISE]->(file)
			RETURN
			  target {
			    .nodeId, .name, .qualifiedName, .filePath, .sourceCode,
			    .startLine, .endLine,
			    label: labels(target)[0]
			  } AS target,
			  file { .filePath, .language } AS file,
			  collect(DISTINCT caller {
			    .nodeId, .name, .qualifiedName, .filePath,
			    label: labels(caller)[0], .sourceCode,
			    callSiteLine: callsIn.callSiteLine
			  }) AS callers,
			  collect(DISTINCT callee {
			    .nodeId, .name, .qualifiedName, .filePath,
			    label: labels(callee)[0], .sourceCode,
			    callSiteLine: callsOut.callSiteLine
			  }) AS callees,
			  collect(DISTINCT rendered {
			    .nodeId, .name, .qualifiedName, .filePath,
			    label: labels(rendered)[0], .sourceCode
			  }) AS renderedComponents,
			  collect(DISTINCT hook {
			    .nodeId, .name, .qualifiedName, .filePath,
			    label: labels(hook)[0], sourceCode: null
			  }) AS hooksUsed,
			  collect(DISTINCT importedFile {
			    .filePath, .language
			  }) AS importedFiles,
			  collect(DISTINCT {
			    name: dev.name, email: dev.email,
			    doaScore: exp.doaScore, isFirstAuthor: exp.isFirstAuthor,
			    lastContribution: exp.lastContribution
			  }) AS developers
			`,
			{ nodeId },
		);

		const record = result.records[0];
		if (!record) return null;

		const rawTarget = record.get("target") as Record<string, unknown>;
		if (!rawTarget?.["nodeId"]) return null;

		const rawFile = record.get("file") as Record<string, unknown> | null;

		const callers = (
			record.get("callers") as Array<Record<string, unknown>>
		).filter((c) => c["nodeId"] !== null) as unknown as RelatedEntity[];

		const callees = (
			record.get("callees") as Array<Record<string, unknown>>
		).filter((c) => c["nodeId"] !== null) as unknown as RelatedEntity[];

		const renderedComponents = (
			record.get("renderedComponents") as Array<Record<string, unknown>>
		).filter((c) => c["nodeId"] !== null) as unknown as RelatedEntity[];

		const hooksUsed = (
			record.get("hooksUsed") as Array<Record<string, unknown>>
		).filter((c) => c["nodeId"] !== null) as unknown as RelatedEntity[];

		const importedFiles = (
			record.get("importedFiles") as Array<Record<string, unknown>>
		).filter((c) => c["filePath"] !== null) as unknown as ImportedFile[];

		const developers = (
			record.get("developers") as Array<Record<string, unknown>>
		).filter((d) => d["name"] !== null) as unknown as DeveloperExpertise[];

		return {
			target: {
				nodeId: rawTarget["nodeId"] as string,
				name: rawTarget["name"] as string,
				qualifiedName: rawTarget["qualifiedName"] as string,
				label: rawTarget["label"] as string,
				filePath: rawTarget["filePath"] as string,
				sourceCode: (rawTarget["sourceCode"] as string | null) ?? null,
				startLine: toNumber(rawTarget["startLine"]),
				endLine: toNumber(rawTarget["endLine"]),
			},
			file:
				rawFile?.["filePath"] != null
					? {
							filePath: rawFile["filePath"] as string,
							language: (rawFile["language"] as string) ?? "Unknown",
						}
					: null,
			callers,
			callees,
			renderedComponents,
			hooksUsed,
			importedFiles,
			developers,
		};
	} finally {
		await session.close();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a direct Cypher query for a structural pattern.
 *
 * Returns a structured list of entities without LLM involvement.
 * Week 8 patterns (implements, decorators, overrides) return an empty list.
 */
export async function structuralQuery(
	driver: Driver,
	pattern: StructuralPattern,
	entityName: string,
): Promise<StructuralQueryResult> {
	const session = driver.session({ database: "neo4j" });

	try {
		const cypher = buildStructuralCypher(pattern);
		if (!cypher) {
			// Week 8 scaffold — pattern not yet implemented
			return { pattern, query: entityName, entities: [] };
		}

		const result = await session.run(cypher, { name: entityName });

		const entities = result.records.map((record) => ({
			nodeId: (record.get("nodeId") as string | null) ?? "",
			name: (record.get("name") as string | null) ?? "",
			qualifiedName: (record.get("qualifiedName") as string | null) ?? "",
			filePath: (record.get("filePath") as string | null) ?? "",
			label: (record.get("label") as string | null) ?? "",
			startLine: record.has("startLine")
				? toNumber(record.get("startLine"))
				: undefined,
			endLine: record.has("endLine")
				? toNumber(record.get("endLine"))
				: undefined,
		}));

		return { pattern, query: entityName, entities };
	} finally {
		await session.close();
	}
}

/** Returns the Cypher query string for a structural pattern, or null if not yet implemented. */
function buildStructuralCypher(pattern: StructuralPattern): string | null {
	switch (pattern) {
		case "what_imports":
			return `
				MATCH (f:File)-[:IMPORTS]->(t:File)
				WHERE f.filePath CONTAINS $name OR f.filePath = $name
				RETURN t.filePath AS filePath, t.language AS language,
				       '' AS nodeId, '' AS name, '' AS qualifiedName,
				       'File' AS label
			`;

		case "imported_by":
			return `
				MATCH (f:File)-[:IMPORTS]->(t:File)
				WHERE t.filePath CONTAINS $name OR t.filePath = $name
				RETURN f.filePath AS filePath, f.language AS language,
				       '' AS nodeId, '' AS name, '' AS qualifiedName,
				       'File' AS label
			`;

		case "what_calls":
			return `
				MATCH (a)-[:CALLS]->(b)
				WHERE a.name = $name OR a.qualifiedName = $name
				RETURN b.nodeId AS nodeId, b.name AS name,
				       b.qualifiedName AS qualifiedName, b.filePath AS filePath,
				       labels(b)[0] AS label, b.startLine AS startLine, b.endLine AS endLine
			`;

		case "called_by":
			return `
				MATCH (a)-[:CALLS]->(b)
				WHERE b.name = $name OR b.qualifiedName = $name
				RETURN a.nodeId AS nodeId, a.name AS name,
				       a.qualifiedName AS qualifiedName, a.filePath AS filePath,
				       labels(a)[0] AS label, a.startLine AS startLine, a.endLine AS endLine
			`;

		case "defined_in":
			return `
				MATCH (n)-[:DEFINED_IN]->(f:File)
				WHERE n.name = $name OR n.qualifiedName = $name
				RETURN f.filePath AS filePath, f.language AS language,
				       '' AS nodeId, n.name AS name, '' AS qualifiedName,
				       'File' AS label
			`;

		case "exports":
			return `
				MATCH (f:File)-[:EXPORTS]->(n)
				WHERE f.filePath CONTAINS $name OR f.filePath = $name
				RETURN n.nodeId AS nodeId, n.name AS name,
				       n.qualifiedName AS qualifiedName, n.filePath AS filePath,
				       labels(n)[0] AS label, n.startLine AS startLine, n.endLine AS endLine
			`;

		case "inherits_from":
			return `
				MATCH (c:Class)-[:INHERITS]->(parent:Class)
				WHERE c.name = $name OR c.qualifiedName = $name
				RETURN parent.nodeId AS nodeId, parent.name AS name,
				       parent.qualifiedName AS qualifiedName, parent.filePath AS filePath,
				       'Class' AS label, parent.startLine AS startLine, parent.endLine AS endLine
			`;

		case "inherited_by":
			return `
				MATCH (c:Class)-[:INHERITS]->(parent:Class)
				WHERE parent.name = $name OR parent.qualifiedName = $name
				RETURN c.nodeId AS nodeId, c.name AS name,
				       c.qualifiedName AS qualifiedName, c.filePath AS filePath,
				       'Class' AS label, c.startLine AS startLine, c.endLine AS endLine
			`;

		case "renders":
			return `
				MATCH (c:Component)-[:RENDERS]->(r:Component)
				WHERE c.name = $name OR c.qualifiedName = $name
				RETURN r.nodeId AS nodeId, r.name AS name,
				       r.qualifiedName AS qualifiedName, r.filePath AS filePath,
				       'Component' AS label, r.startLine AS startLine, r.endLine AS endLine
			`;

		case "rendered_by":
			return `
				MATCH (c:Component)-[:RENDERS]->(r:Component)
				WHERE r.name = $name OR r.qualifiedName = $name
				RETURN c.nodeId AS nodeId, c.name AS name,
				       c.qualifiedName AS qualifiedName, c.filePath AS filePath,
				       'Component' AS label, c.startLine AS startLine, c.endLine AS endLine
			`;

		case "uses_hook":
			return `
				MATCH (c:Component)-[:USES_HOOK]->(h:Hook)
				WHERE c.name = $name OR c.qualifiedName = $name
				RETURN h.nodeId AS nodeId, h.name AS name,
				       h.qualifiedName AS qualifiedName, h.filePath AS filePath,
				       labels(h)[0] AS label, h.startLine AS startLine, h.endLine AS endLine
			`;

		case "accepts_props":
			return `
				MATCH (c:Component)-[:ACCEPTS_PROP]->(p:Prop)
				WHERE c.name = $name OR c.qualifiedName = $name
				RETURN p.nodeId AS nodeId, p.name AS name,
				       '' AS qualifiedName, c.filePath AS filePath,
				       'Prop' AS label
			`;

		// TODO: Week 8 — depends on interface nodes in parser
		case "implements":
			return null;

		// TODO: Week 8 — depends on decorator extraction in parser
		case "decorators":
			return null;

		// TODO: Week 8 — depends on method override detection in parser
		case "overrides":
			return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Path finding (Week 8 scaffold)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds the shortest path between two nodes in the graph.
 *
 * TODO: Week 8 — wire to /search/path backend route.
 */
export async function findShortestPath(
	driver: Driver,
	fromNodeId: string,
	toNodeId: string,
	maxHops = 5,
): Promise<PathQueryResult | null> {
	const session = driver.session({ database: "neo4j" });

	try {
		const result = await session.run(
			`
			MATCH (a {nodeId: $fromId}), (b {nodeId: $toId}),
			      path = shortestPath((a)-[*..${maxHops}]->(b))
			RETURN
			  [n IN nodes(path) | {
			    nodeId: n.nodeId, name: n.name,
			    qualifiedName: n.qualifiedName,
			    label: labels(n)[0], filePath: n.filePath
			  }] AS pathNodes,
			  [r IN relationships(path) | type(r)] AS edgeTypes
			`,
			{ fromId: fromNodeId, toId: toNodeId },
		);

		const record = result.records[0];
		if (!record) return null;

		const pathNodes = record.get("pathNodes") as Array<{
			nodeId: string;
			name: string;
			qualifiedName: string;
			label: string;
			filePath: string;
		}>;
		const edgeTypes = record.get("edgeTypes") as string[];

		return {
			path: pathNodes,
			edgeTypes,
			hops: edgeTypes.length,
		};
	} finally {
		await session.close();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Safely converts Neo4j Integer objects to JS numbers. */
function toNumber(value: unknown): number {
	if (typeof value === "number") return value;
	if (value && typeof value === "object" && "toNumber" in value) {
		return (value as { toNumber: () => number }).toNumber();
	}
	return 0;
}
