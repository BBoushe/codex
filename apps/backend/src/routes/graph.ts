/**
 * @fileoverview Graph data endpoints for the visualization layer.
 *
 * GET /browse/tree       — nested file tree from Neo4j File nodes
 * GET /graph/hierarchy   — hierarchical tree + dependency edges for the HEB visualization
 */

import { Elysia } from "elysia";
import type { Driver } from "neo4j-driver";

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

interface FileTreeNode {
	name: string;
	path: string;
	type: "directory" | "file";
	language?: string;
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
					 RETURN f.filePath AS filePath, f.language AS language
					 ORDER BY f.filePath`,
				);

				if (result.records.length === 0) {
					set.status = 404;
					return { error: "No files found. Run codex ingest first." };
				}

				const filePaths = result.records.map((r) => ({
					filePath: r.get("filePath") as string,
					language: (r.get("language") as string | null) ?? undefined,
				}));

				return buildFileTree(filePaths);
			} finally {
				await session.close();
			}
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
					 WHERE type(r) IN ['CALLS', 'IMPORTS', 'RENDERS', 'USES_HOOK', 'INHERITS', 'IMPLEMENTS']
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
					language: (r.get("language") as string | null) ?? undefined,
					churnRate: toNumber(r.get("churnRate")),
					doaScore: toNumber(r.get("doaScore")),
					entities: (r.get("entities") as Array<Record<string, unknown>>).filter(
						(e) => e["id"] !== null,
					),
				}));

				const tree = buildHierarchyTree(fileRows);

				return { tree, edges };
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
	files: Array<{ filePath: string; language?: string }>,
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

