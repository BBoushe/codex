/**
 * @fileoverview Cross-file reference linker (Pass 2).
 *
 * After all files have been visited (Pass 1), the linker resolves cross-file
 * references into concrete graph edges. This is the second half of the
 * two-pass parsing pipeline.
 *
 * ## Algorithm
 * 1. **Build export registry** — maps (filePath, exportedName) → nodeId
 *    for every exported entity across all files.
 * 2. **Resolve imports** — for each `UnresolvedImport`, resolve the module
 *    specifier to a file path using `ImportResolver`, then create
 *    `IMPORTS` edges between file nodes.
 * 3. **Build per-file import map** — maps local imported names to their
 *    resolved entity nodeIds. This enables call and render resolution.
 * 4. **Resolve calls** — for each `UnresolvedCall`, look up the callee name
 *    in the import map or same-file entities to create `CALLS` edges.
 * 5. **Resolve renders** — for each `UnresolvedRender`, look up the component
 *    name to create `RENDERS` and `PASSES_PROP` edges.
 *
 * ## Known Limitations
 * - **Re-exports / barrel files**: `export { X } from './bar'` is not yet
 *   extracted by the visitor. Barrel files that re-export won't be followed.
 *   This is the most impactful limitation and should be addressed next.
 * - **Namespace imports**: `import * as Foo from './bar'; Foo.baz()` — the
 *   member access `Foo.baz` is not resolved to the `baz` entity.
 * - **Dynamic imports**: `import('./foo')` is not resolved.
 */

import {
	EdgeType,
	type ParsedRelationship,
	type FileParseResult,
	type CallsEdge,
	type PassesPropEdge,
} from "@codex/shared";
import { nodeIdForFile } from "@codex/shared";
import { ImportResolver } from "./importResolver";
import type {
	VisitorFileResult,
	UnresolvedImport,
	UnresolvedCall,
	UnresolvedRender,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps an imported local name to the resolved entity nodeId and source file.
 *
 * Example: if file A does `import { fetchUser } from "./api/user"` and
 * file `src/api/user.ts` exports a FunctionNode with nodeId "abc123",
 * then file A's import map contains: `"fetchUser" → { nodeId: "abc123", filePath: "src/api/user.ts" }`
 */
interface ResolvedImport {
	nodeId: string;
	filePath: string;
}

/** Statistics from the linking process, useful for CLI reporting. */
export interface LinkStats {
	importsResolved: number;
	importsFailed: number;
	callsResolved: number;
	callsFailed: number;
	rendersResolved: number;
	rendersFailed: number;
	edgesCreated: number;
}

/** The output of the linker: resolved FileParseResults with all cross-file edges added. */
export interface LinkResult {
	/** The original results with cross-file relationships appended. */
	results: FileParseResult[];
	stats: LinkStats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registry of all exported names across the codebase.
 *
 * Structure: `filePath → Map<exportedName, entityNodeId>`
 *
 * A file can export multiple names. The special key `"default"` represents
 * the default export.
 */
class ExportRegistry {
	/** filePath → (exportedName → nodeId) */
	private readonly exports = new Map<string, Map<string, string>>();
	/** filePath → (entityNodeId set) — for same-file lookups */
	private readonly fileEntities = new Map<string, Map<string, string>>();

	/**
	 * Registers all exports from a single file's parse result.
	 *
	 * An entity is considered exported if there's an EXPORTS edge
	 * from the file to that entity.
	 */
	registerFile(result: VisitorFileResult): void {
		const filePath = result.file.filePath;
		const fileNodeId = result.file.nodeId;

		const exports = new Map<string, string>();
		const allEntities = new Map<string, string>();

		// Index all entities by name for same-file call resolution
		for (const entity of result.entities) {
			allEntities.set(entity.node.name, entity.node.nodeId);
		}

		// Find entities that have EXPORTS edges from the file
		for (const rel of result.relationships) {
			if (rel.edge.type === EdgeType.EXPORTS && rel.sourceId === fileNodeId) {
				// Find the entity by nodeId to get its name
				const entity = result.entities.find(
					(e) => e.node.nodeId === rel.targetId,
				);
				if (entity) {
					exports.set(entity.node.name, entity.node.nodeId);
				}
			}
		}

		// TODO: detect default exports and register under "default" key.
		// Currently the visitor doesn't distinguish default from named exports.
		// This works for named imports but not `import Foo from "./bar"`.

		this.exports.set(filePath, exports);
		this.fileEntities.set(filePath, allEntities);
	}

	/**
	 * Looks up an exported name from a specific file.
	 * @returns The entity's nodeId, or undefined if not found.
	 */
	getExport(filePath: string, name: string): string | undefined {
		return this.exports.get(filePath)?.get(name);
	}

	/**
	 * Looks up any entity (exported or not) defined in the same file.
	 * Used for resolving intra-file calls where the callee isn't imported.
	 */
	getLocalEntity(filePath: string, name: string): string | undefined {
		return this.fileEntities.get(filePath)?.get(name);
	}

	/**
	 * Returns all exported names from a file. Used for debugging and
	 * for resolving default imports.
	 */
	getFileExports(filePath: string): Map<string, string> | undefined {
		return this.exports.get(filePath);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Linker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves all cross-file references from Pass 1 into concrete graph edges.
 *
 * @param visitorResults - All per-file results from the visitor (Pass 1).
 * @param resolver       - The configured import resolver.
 * @returns The linked results with cross-file edges appended, plus stats.
 *
 * @example
 * ```ts
 * const visitorResults = files.map(f => visitor.visit(tree, source, f));
 * const resolver = new ImportResolver({ rootDir, knownFiles });
 * const { results, stats } = linkAll(visitorResults, resolver);
 * ```
 */
export function linkAll(
	visitorResults: VisitorFileResult[],
	resolver: ImportResolver,
): LinkResult {
	const stats: LinkStats = {
		importsResolved: 0,
		importsFailed: 0,
		callsResolved: 0,
		callsFailed: 0,
		rendersResolved: 0,
		rendersFailed: 0,
		edgesCreated: 0,
	};

	// ── Step 1: Build the export registry ─────────────────────────────
	const registry = new ExportRegistry();
	for (const result of visitorResults) {
		registry.registerFile(result);
	}

	// ── Step 2 & 3: Process each file's unresolved references ─────────
	const linkedResults: FileParseResult[] = [];

	for (const result of visitorResults) {
		const newEdges: ParsedRelationship[] = [];
		const importMap = new Map<string, ResolvedImport>();
		const filePath = result.file.filePath;

		// ── 2a: Resolve imports ─────────────────────────────────────────
		const imports = result.unresolvedReferences.filter(
			(r): r is UnresolvedImport => r.kind === "import",
		);

		for (const imp of imports) {
			const resolvedPath = resolver.resolve(imp.specifier, filePath);

			if (!resolvedPath) {
				if (!resolver.isBareSpecifier(imp.specifier)) {
					// Only count as failure if it's not an external package
					stats.importsFailed++;
				}
				continue;
			}

			stats.importsResolved++;

			// Create IMPORTS edge: sourceFile → targetFile
			const sourceFileId = nodeIdForFile(filePath);
			const targetFileId = nodeIdForFile(resolvedPath);

			newEdges.push({
				sourceId: sourceFileId,
				targetId: targetFileId,
				edge: { type: EdgeType.IMPORTS },
			});
			stats.edgesCreated++;

			// Build the import map for this file: localName → resolved entity
			for (const imported of imp.importedNames) {
				const localName = imported.alias ?? imported.name;
				const entityNodeId = registry.getExport(resolvedPath, imported.name);
				if (entityNodeId) {
					importMap.set(localName, {
						nodeId: entityNodeId,
						filePath: resolvedPath,
					});
				}
			}

			// Handle default imports
			if (imp.hasDefaultImport && imp.defaultOrNamespaceName) {
				const defaultEntity = registry.getExport(resolvedPath, "default");
				if (defaultEntity) {
					importMap.set(imp.defaultOrNamespaceName, {
						nodeId: defaultEntity,
						filePath: resolvedPath,
					});
				}
				// Fallback: if file has exactly one export, treat it as the default
				// This handles common patterns where files export a single entity
				if (!defaultEntity) {
					const fileExports = registry.getFileExports(resolvedPath);
					if (fileExports && fileExports.size === 1) {
						const [, singleNodeId] = [...fileExports.entries()][0]!;
						importMap.set(imp.defaultOrNamespaceName, {
							nodeId: singleNodeId,
							filePath: resolvedPath,
						});
					}
				}
			}

			// Namespace imports (`import * as X from "..."`) are not resolved
			// to individual entities — that would require tracking member accesses.
		}

		// ── 2b: Resolve calls ───────────────────────────────────────────
		const calls = result.unresolvedReferences.filter(
			(r): r is UnresolvedCall => r.kind === "call",
		);

		for (const call of calls) {
			// First, check if the callee was imported
			const imported = importMap.get(call.calleeName);
			if (imported) {
				const edge: CallsEdge = {
					type: EdgeType.CALLS,
					callSiteLine: call.callSiteLine,
					callSiteFile: call.callSiteFile,
				};
				newEdges.push({
					sourceId: call.callerNodeId,
					targetId: imported.nodeId,
					edge,
				});
				stats.callsResolved++;
				stats.edgesCreated++;
				continue;
			}

			// Second, check if the callee is defined in the same file
			const localEntity = registry.getLocalEntity(filePath, call.calleeName);
			if (localEntity && localEntity !== call.callerNodeId) {
				// Don't create self-referential CALLS edges
				const edge: CallsEdge = {
					type: EdgeType.CALLS,
					callSiteLine: call.callSiteLine,
					callSiteFile: call.callSiteFile,
				};
				newEdges.push({
					sourceId: call.callerNodeId,
					targetId: localEntity,
					edge,
				});
				stats.callsResolved++;
				stats.edgesCreated++;
				continue;
			}

			// Unresolved — could be a global (`setTimeout`, `fetch`), a callback
			// parameter, or a function we failed to extract. This is expected.
			stats.callsFailed++;
		}

		// ── 2c: Resolve renders ─────────────────────────────────────────
		const renders = result.unresolvedReferences.filter(
			(r): r is UnresolvedRender => r.kind === "render",
		);

		for (const render of renders) {
			// Check imports first (most components are imported)
			const imported = importMap.get(render.componentName);
			const targetNodeId =
				imported?.nodeId ??
				registry.getLocalEntity(filePath, render.componentName);

			if (!targetNodeId) {
				stats.rendersFailed++;
				continue;
			}

			// RENDERS: parentComponent → childComponent
			newEdges.push({
				sourceId: render.rendererNodeId,
				targetId: targetNodeId,
				edge: { type: EdgeType.RENDERS },
			});
			stats.rendersResolved++;
			stats.edgesCreated++;

			// PASSES_PROP: parentComponent → childComponent for each prop
			for (const prop of render.passedProps) {
				const edge: PassesPropEdge = {
					type: EdgeType.PASSES_PROP,
					propName: prop.name,
					passKind: prop.passKind,
				};
				newEdges.push({
					sourceId: render.rendererNodeId,
					targetId: targetNodeId,
					edge,
				});
				stats.edgesCreated++;
			}
		}

		// ── Combine original + new edges into a plain FileParseResult ────
		linkedResults.push({
			file: result.file,
			entities: result.entities,
			relationships: [...result.relationships, ...newEdges],
		});
	}

	return { results: linkedResults, stats };
}
