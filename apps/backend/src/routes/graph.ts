/**
 * @fileoverview Graph data endpoints for the visualization layer.
 *
 * GET /browse/tree       — nested file tree from Neo4j File nodes
 * GET /graph/hierarchy   — hierarchical tree + dependency edges for the HEB visualization
 */

import { Elysia } from "elysia";
import type { Driver } from "neo4j-driver";
import { fetchSubgraph } from "@codex/graph-client";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types (mirrored in frontend src/types/graph.ts)
// ─────────────────────────────────────────────────────────────────────────────

type HierarchyNodeType =
	| "directory"
	| "file"
	| "function"
	| "class"
	| "component"
	| "hook"
	| "interface"
	| "decorator";

interface HierarchyNode {
	id: string;
	name: string;
	type: HierarchyNodeType;
	module: string;
	language?: string;
	churnRate?: number;
	doaScore?: number;
	children?: HierarchyNode[];
}

interface HierarchyEdge {
	source: string;
	target: string;
	type: string;
}

interface ChurnFailureBreakdown {
	missingChurnFiles: number;
	invalidChurnValues: number;
	zeroVariance: boolean;
}

interface ChurnDiagnostics {
	totalFiles: number;
	filesWithChurn: number;
	minChurnRate: number | null;
	maxChurnRate: number | null;
	failureBreakdown: ChurnFailureBreakdown;
}

interface DeveloperOwner {
	email: string;
	name: string;
	doaScore: number;
}

interface RiskOwnerSummary {
	email: string;
	name: string;
	ownedFiles: number;
	ownershipShare: number;
}

interface RiskFailureBreakdown {
	emptyExpertiseGraph: boolean;
	staleMiningRun: boolean;
	inconsistentDeveloperNodes: number;
	inconsistentExpertiseEdges: number;
}

interface RiskMetricsResponse {
	truckFactor: number;
	criticalDevelopers: RiskOwnerSummary[];
	ownership: RiskOwnerSummary[];
	diagnostics: {
		developerCount: number;
		fileCount: number;
		expertiseEdgeCount: number;
		orphanedFiles: number;
		failureBreakdown: RiskFailureBreakdown;
	};
}

interface FileTreeNode {
	name: string;
	path: string;
	type: "directory" | "file";
	language?: string;
	nodeId?: string;
	children?: FileTreeNode[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Route factory
// ─────────────────────────────────────────────────────────────────────────────

interface GraphDeps {
	driver: Driver;
}

export function graphRoutes(deps: GraphDeps) {
	return new Elysia()
		.get("/browse/tree", async ({ set }) => {
			const session = deps.driver.session({ database: "neo4j" });
			try {
				const result = await session.run(
					`MATCH (f:File)
					 RETURN f.filePath AS filePath, f.language AS language, f.nodeId AS nodeId
					 ORDER BY f.filePath`,
				);

				if (result.records.length === 0) {
					set.status = 404;
					return { error: "No files found. Run codex ingest first." };
				}

				const filePaths = result.records.map((r) => ({
					filePath: r.get("filePath") as string,
					language: (r.get("language") as string | null) ?? undefined,
					nodeId: (r.get("nodeId") as string | null) ?? undefined,
				}));

				return buildFileTree(filePaths);
			} finally {
				await session.close();
			}
		})
		.get("/graph/subgraph", async ({ query, set }) => {
			const nodeId = query["nodeId"];
			if (!nodeId) {
				set.status = 400;
				return { error: "nodeId query parameter is required" };
			}
			const rawDepth = Number(query["depth"] ?? 2);
			const depth = Math.max(1, Math.min(3, isNaN(rawDepth) ? 2 : rawDepth));

			const result = await fetchSubgraph(deps.driver, nodeId, depth);
			if (result.nodes.length === 0) {
				set.status = 404;
				return { error: `Node not found: ${nodeId}` };
			}
			return result;
		})
		.get("/graph/hierarchy", async ({ set }) => {
			const session = deps.driver.session({ database: "neo4j" });
			try {
				// Query 1: files with their entity children and churn/DOA data
				const treeResult = await session.run(
					`MATCH (f:File)
					 OPTIONAL MATCH (f)<-[:DEFINED_IN]-(entity)
					 WHERE entity:Function OR entity:Class OR entity:Component
					    OR entity:Hook OR entity:Interface OR entity:Decorator
					 OPTIONAL MATCH (dev:Developer)-[exp:HAS_EXPERTISE]->(f)
					 WITH f,
					      collect(DISTINCT {
					        id: entity.nodeId,
					        name: entity.name,
					        label: labels(entity)[0],
					        churnRate: f.churnRate
					      }) AS entities,
					      max(exp.doaScore) AS maxDoa
					 RETURN
					   f.filePath AS filePath,
					   f.nodeId AS fileNodeId,
					   f.language AS language,
					   f.churnRate AS churnRate,
					   maxDoa AS doaScore,
					   entities`,
				);

				if (treeResult.records.length === 0) {
					set.status = 404;
					return { error: "No files found. Run codex ingest first." };
				}

				// Query 2: dependency edges
				const edgeResult = await session.run(
					`MATCH (a)-[r]->(b)
					 WHERE type(r) IN [
					   'CALLS', 'IMPORTS', 'RENDERS', 'USES_HOOK',
					   'INHERITS', 'IMPLEMENTS', 'EXPORTS',
					   'PASSES_PROP', 'SETS_STATE', 'DECORATED_BY', 'OVERRIDES'
					 ]
					   AND a.nodeId IS NOT NULL AND b.nodeId IS NOT NULL
					 RETURN a.nodeId AS source, b.nodeId AS target, type(r) AS edgeType`,
				);

				const edges: HierarchyEdge[] = edgeResult.records.map((r) => ({
					source: r.get("source") as string,
					target: r.get("target") as string,
					type: r.get("edgeType") as string,
				}));

				// Build tree from flat file list
				const fileRows = treeResult.records.map((r) => ({
					filePath: r.get("filePath") as string,
					fileNodeId: (r.get("fileNodeId") as string | null) ?? undefined,
					language: (r.get("language") as string | null) ?? undefined,
					churnRate: toNumber(r.get("churnRate")),
					doaScore: toNumber(r.get("doaScore")),
					entities: (
						r.get("entities") as Array<Record<string, unknown>>
					).filter((e) => e["id"] !== null),
				}));

				const tree = buildHierarchyTree(fileRows);
				const churnDiagnostics = buildChurnDiagnostics(fileRows);

				return { tree, edges, churnDiagnostics };
			} finally {
				await session.close();
			}
		})
		.get("/graph/risk", async () => {
			const session = deps.driver.session({ database: "neo4j" });
			try {
				const overview = await session.run(
					`OPTIONAL MATCH (d:Developer)
					 WITH count(d) AS developerCount
					 OPTIONAL MATCH ()-[exp:HAS_EXPERTISE]->(:File)
					 WITH developerCount, count(exp) AS expertiseEdgeCount
					 OPTIONAL MATCH (f:File)
					 RETURN developerCount, expertiseEdgeCount, count(f) AS fileCount`,
				);

				const overviewRow = overview.records[0];
				const developerCount =
					toNumber(overviewRow?.get("developerCount")) ?? 0;
				const expertiseEdgeCount =
					toNumber(overviewRow?.get("expertiseEdgeCount")) ?? 0;
				const fileCount = toNumber(overviewRow?.get("fileCount")) ?? 0;

				const inconsistency = await session.run(
					`OPTIONAL MATCH (d:Developer)
					 WHERE d.email IS NULL OR d.name IS NULL
					 WITH count(d) AS inconsistentDeveloperNodes
					 OPTIONAL MATCH ()-[exp:HAS_EXPERTISE]->(:File)
					 WHERE exp.doaScore IS NULL
					 RETURN inconsistentDeveloperNodes, count(exp) AS inconsistentExpertiseEdges`,
				);

				const inconsistencyRow = inconsistency.records[0];
				const inconsistentDeveloperNodes =
					toNumber(inconsistencyRow?.get("inconsistentDeveloperNodes")) ?? 0;
				const inconsistentExpertiseEdges =
					toNumber(inconsistencyRow?.get("inconsistentExpertiseEdges")) ?? 0;

				const ownersResult = await session.run(
					`MATCH (d:Developer)-[exp:HAS_EXPERTISE]->(f:File)
					 WITH f.filePath AS filePath,
					      collect({
					        email: d.email,
					        name: d.name,
					        doaScore: exp.doaScore
					      }) AS expertiseRows
					 RETURN filePath, expertiseRows`,
				);

				const expertiseByFile = new Map<string, DeveloperOwner[]>();
				for (const row of ownersResult.records) {
					const filePath = row.get("filePath") as string;
					const rawRows = row.get("expertiseRows") as Array<{
						email: string | null;
						name: string | null;
						doaScore: number | null;
					}>;

					const owners = rawRows
						.filter((raw) => raw.email && raw.name)
						.map((raw) => ({
							email: raw.email as string,
							name: raw.name as string,
							doaScore: raw.doaScore ?? 0,
						}))
						.sort((a, b) => b.doaScore - a.doaScore);

					if (owners.length > 0) {
						expertiseByFile.set(filePath, owners);
					}
				}

				const truckFactorResult = computeTruckFactorFromOwners(expertiseByFile);
				const ownership = buildOwnershipSummary(
					truckFactorResult.ownershipCounts,
					truckFactorResult.developerNames,
					expertiseByFile.size,
				);

				const criticalDevelopers = truckFactorResult.criticalDevelopers
					.map((email) => {
						const owner = ownership.find((entry) => entry.email === email);
						return owner ?? null;
					})
					.filter((entry): entry is RiskOwnerSummary => entry !== null);

				const orphanedFiles = Math.max(fileCount - expertiseByFile.size, 0);

				const failureBreakdown: RiskFailureBreakdown = {
					emptyExpertiseGraph: expertiseEdgeCount === 0,
					staleMiningRun: developerCount > 0 && expertiseEdgeCount === 0,
					inconsistentDeveloperNodes,
					inconsistentExpertiseEdges,
				};

				const payload: RiskMetricsResponse = {
					truckFactor: truckFactorResult.truckFactor,
					criticalDevelopers,
					ownership,
					diagnostics: {
						developerCount,
						fileCount,
						expertiseEdgeCount,
						orphanedFiles,
						failureBreakdown,
					},
				};

				return payload;
			} finally {
				await session.close();
			}
		});
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree builder helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FileRow {
	filePath: string;
	fileNodeId?: string;
	language?: string;
	churnRate?: number;
	doaScore?: number;
	entities: Array<Record<string, unknown>>;
}

/** Builds a nested HierarchyNode tree from a flat list of file rows. */
function buildHierarchyTree(rows: FileRow[]): HierarchyNode {
	const root: HierarchyNode = {
		id: "root",
		name: "root",
		type: "directory",
		module: "root",
		children: [],
	};

	for (const row of rows) {
		const segments = row.filePath.split("/");
		const module = segments[0] ?? "root";
		let current = root;

		// Navigate / create directory nodes
		for (let i = 0; i < segments.length - 1; i++) {
			const seg = segments[i]!;
			const existingDir = current.children?.find(
				(c) => c.type === "directory" && c.name === seg,
			);
			if (existingDir) {
				current = existingDir;
			} else {
				const dirNode: HierarchyNode = {
					id: segments.slice(0, i + 1).join("/"),
					name: seg,
					type: "directory",
					module,
					children: [],
				};
				current.children ??= [];
				current.children.push(dirNode);
				current = dirNode;
			}
		}

		// Add the file node
		const fileName = segments[segments.length - 1]!;
		const fileNode: HierarchyNode = {
			id: row.filePath,
			name: fileName,
			type: "file",
			module,
			language: row.language,
			churnRate: row.churnRate,
			doaScore: row.doaScore,
			children: [],
		};

		// Always add a self-leaf for the file using its Neo4j nodeId.
		// This makes IMPORTS edges (which reference File nodeIds) renderable in the HEB.
		if (row.fileNodeId) {
			fileNode.children!.push({
				id: row.fileNodeId,
				name: fileName,
				type: "file",
				module,
				language: row.language,
				churnRate: row.churnRate,
				doaScore: row.doaScore,
			});
		}

		// Attach entity children to the file node
		for (const entity of row.entities) {
			const labelRaw = entity["label"] as string | null;
			const entityType = labelToHierarchyType(labelRaw);
			if (!entityType) continue;

			fileNode.children!.push({
				id: entity["id"] as string,
				name: (entity["name"] as string) ?? "",
				type: entityType,
				module,
				churnRate: row.churnRate, // inherit file churn
			});
		}

		current.children ??= [];
		current.children.push(fileNode);
	}

	return root;
}

/** Builds a nested FileTreeNode structure for the browse endpoint. */
function buildFileTree(
	files: Array<{ filePath: string; language?: string; nodeId?: string }>,
): FileTreeNode[] {
	const root: FileTreeNode[] = [];

	for (const file of files) {
		const segments = file.filePath.split("/");
		let current = root;

		for (let i = 0; i < segments.length - 1; i++) {
			const seg = segments[i]!;
			let dir = current.find((n) => n.type === "directory" && n.name === seg);
			if (!dir) {
				dir = {
					name: seg,
					path: segments.slice(0, i + 1).join("/"),
					type: "directory",
					children: [],
				};
				current.push(dir);
			}
			current = dir.children!;
		}

		const fileName = segments[segments.length - 1]!;
		current.push({
			name: fileName,
			path: file.filePath,
			type: "file",
			language: file.language,
			nodeId: file.nodeId,
		});
	}

	return root;
}

function labelToHierarchyType(label: string | null): HierarchyNodeType | null {
	const map: Record<string, HierarchyNodeType> = {
		Function: "function",
		Class: "class",
		Component: "component",
		Hook: "hook",
		Interface: "interface",
		Decorator: "decorator",
	};
	return label ? (map[label] ?? null) : null;
}

function toNumber(value: unknown): number | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "number") return value;
	if (value && typeof value === "object" && "toNumber" in value) {
		return (value as { toNumber: () => number }).toNumber();
	}
	return undefined;
}

function buildChurnDiagnostics(rows: FileRow[]): ChurnDiagnostics {
	let filesWithChurn = 0;
	let missingChurnFiles = 0;
	let invalidChurnValues = 0;

	const churnValues: number[] = [];

	for (const row of rows) {
		if (row.churnRate === undefined) {
			missingChurnFiles++;
			continue;
		}
		if (!Number.isFinite(row.churnRate)) {
			invalidChurnValues++;
			continue;
		}
		filesWithChurn++;
		churnValues.push(row.churnRate);
	}

	const minChurnRate = churnValues.length > 0 ? Math.min(...churnValues) : null;
	const maxChurnRate = churnValues.length > 0 ? Math.max(...churnValues) : null;

	return {
		totalFiles: rows.length,
		filesWithChurn,
		minChurnRate,
		maxChurnRate,
		failureBreakdown: {
			missingChurnFiles,
			invalidChurnValues,
			zeroVariance:
				churnValues.length > 1 && minChurnRate !== null && maxChurnRate !== null
					? minChurnRate === maxChurnRate
					: false,
		},
	};
}

function computeTruckFactorFromOwners(
	expertiseByFile: Map<string, DeveloperOwner[]>,
): {
	truckFactor: number;
	criticalDevelopers: string[];
	ownershipCounts: Map<string, number>;
	developerNames: Map<string, string>;
} {
	if (expertiseByFile.size === 0) {
		return {
			truckFactor: 0,
			criticalDevelopers: [],
			ownershipCounts: new Map(),
			developerNames: new Map(),
		};
	}

	const fileOwners = new Map<string, DeveloperOwner>();
	const developerNames = new Map<string, string>();

	for (const [filePath, candidates] of expertiseByFile) {
		const owner = candidates[0];
		if (!owner) continue;
		fileOwners.set(filePath, owner);
		developerNames.set(owner.email, owner.name);
		for (const candidate of candidates) {
			developerNames.set(candidate.email, candidate.name);
		}
	}

	const ownershipCounts = new Map<string, number>();
	for (const owner of fileOwners.values()) {
		ownershipCounts.set(
			owner.email,
			(ownershipCounts.get(owner.email) ?? 0) + 1,
		);
	}

	const mutableOwners = new Map(fileOwners);
	const mutableCounts = new Map(ownershipCounts);
	const criticalDevelopers: string[] = [];

	const totalFiles = fileOwners.size;
	const orphanThreshold = Math.ceil(totalFiles * 0.5);
	let orphanedFiles = 0;

	while (orphanedFiles <= orphanThreshold && mutableCounts.size > 0) {
		const next = findTopOwner(mutableCounts);
		if (!next) break;

		criticalDevelopers.push(next.email);
		mutableCounts.delete(next.email);

		for (const [filePath, owner] of mutableOwners) {
			if (owner.email !== next.email) continue;

			const candidates =
				expertiseByFile
					.get(filePath)
					?.filter((candidate) => mutableCounts.has(candidate.email))
					.sort((a, b) => b.doaScore - a.doaScore) ?? [];

			const replacement = candidates[0];
			if (!replacement) {
				mutableOwners.delete(filePath);
				orphanedFiles++;
				continue;
			}

			mutableOwners.set(filePath, replacement);
			mutableCounts.set(
				replacement.email,
				(mutableCounts.get(replacement.email) ?? 0) + 1,
			);
		}

		if (orphanedFiles > orphanThreshold) break;
	}

	return {
		truckFactor: criticalDevelopers.length,
		criticalDevelopers,
		ownershipCounts,
		developerNames,
	};
}

function findTopOwner(
	counts: Map<string, number>,
): { email: string; ownedFiles: number } | null {
	let winner: { email: string; ownedFiles: number } | null = null;
	for (const [email, ownedFiles] of counts) {
		if (!winner || ownedFiles > winner.ownedFiles) {
			winner = { email, ownedFiles };
		}
	}
	return winner;
}

function buildOwnershipSummary(
	ownershipCounts: Map<string, number>,
	developerNames: Map<string, string>,
	totalOwnedFiles: number,
): RiskOwnerSummary[] {
	const rows = Array.from(ownershipCounts.entries())
		.map(([email, ownedFiles]) => ({
			email,
			name: developerNames.get(email) ?? email,
			ownedFiles,
			ownershipShare:
				totalOwnedFiles > 0
					? Math.round((ownedFiles / totalOwnedFiles) * 1000) / 1000
					: 0,
		}))
		.sort((a, b) => b.ownedFiles - a.ownedFiles);

	return rows;
}
