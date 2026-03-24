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
 * - **Namespace import member access**: `import * as Foo from './bar'; Foo.baz()` —
 *   member accesses on namespace imports are not resolved to individual entities.
 * - **Dynamic imports**: `import('./foo')` is not resolved.
 * - **Cross-file type resolution**: prop interfaces imported from another file
 *   are not resolved for prop-type enrichment (only file-local types are used).
 * - **Complex HOC patterns**: `export default withAuth(MyComponent)` — the
 *   wrapping relationship is not tracked; requires type inference beyond static AST.
 * - **Nested components**: components defined inside other components are not
 *   extracted as separate graph nodes (intentional design choice).
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
	ReExportEntry,
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

/** A call that could not be resolved to a graph entity. */
export interface UnresolvedCallRecord {
	calleeName: string;
	callerNodeId: string;
	file: string;
	line: number;
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
	/** Number of times a re-export chain was followed to resolve an import. */
	reExportsFollowed: number;
	/** Every call that could not be resolved — for diagnostic/validation use. */
	unresolvedCalls: UnresolvedCallRecord[];
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
 * the default export. When a file only re-exports entities from other files
 * (barrel file), its own `exports` map will be empty, but `reExports` will
 * contain the forwarding entries that `getExport` will follow recursively.
 */
class ExportRegistry {
	/** filePath → (exportedName → nodeId) for directly-defined exports */
	private readonly exports = new Map<string, Map<string, string>>();
	/** filePath → re-export entries (barrel file support) */
	private readonly reExports = new Map<string, ReExportEntry[]>();
	/** filePath → (entityName → nodeId) — all entities including non-exported */
	private readonly fileEntities = new Map<string, Map<string, string>>();
	/** Mutable counter incremented when a re-export chain is followed. */
	reExportsFollowed = 0;

	/**
	 * Registers all exports and re-export entries from a single file's parse result.
	 *
	 * An entity is considered directly exported if there's an EXPORTS edge
	 * from the file node to that entity node.
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
				const entity = result.entities.find(
					(e) => e.node.nodeId === rel.targetId,
				);
				if (entity) {
					exports.set(entity.node.name, entity.node.nodeId);
				}
			}
		}

		// Register the default export under the "default" key if the visitor
		// identified one via `export default <localName>`.
		if (result.defaultExportName) {
			const defaultNodeId = allEntities.get(result.defaultExportName);
			if (defaultNodeId) {
				exports.set("default", defaultNodeId);
			}
		}

		this.exports.set(filePath, exports);
		this.fileEntities.set(filePath, allEntities);

		if (result.reExports.length > 0) {
			this.reExports.set(filePath, result.reExports);
		}
	}

	/**
	 * Looks up an exported name from a specific file, following re-export
	 * chains for barrel files.
	 *
	 * Returns the entity’s nodeId (or `null` for untracked types/interfaces)
	 * **and** the file where the name is actually defined (`definedIn`).
	 * For direct exports `definedIn === filePath`; for barrel re-exports it is
	 * the deepest file in the chain.
	 *
	 * Callers use `definedIn` when creating IMPORTS edges so those edges point
	 * to the real definition file rather than an intermediate barrel. The
	 * `nodeId` is only used when building the import map for CALLS/RENDERS
	 * resolution — callers should skip import-map entries where `nodeId` is null.
	 *
	 * @param filePath  - Absolute or relative path of the file to look in.
	 * @param name      - The exported name to look up (`"default"` for default exports).
	 * @param resolver  - Used to resolve specifiers in re-export entries.
	 * @param visited   - Cycle detection set (populated automatically).
	 * @returns `{ nodeId, definedIn }` where nodeId may be null for untracked types,
	 *          or `undefined` if the name cannot be traced to any file.
	 */
	getExport(
		filePath: string,
		name: string,
		resolver: ImportResolver,
		visited: Set<string> = new Set(),
	): { nodeId: string | null; definedIn: string } | undefined {
		// Direct hit — entity is defined and exported in this file
		const direct = this.exports.get(filePath)?.get(name);
		if (direct) return { nodeId: direct, definedIn: filePath };

		// Follow re-export chains (barrel files)
		const reExportList = this.reExports.get(filePath);
		if (!reExportList) return undefined;

		const cycleKey = `${filePath}::${name}`;
		if (visited.has(cycleKey)) return undefined;
		visited.add(cycleKey);

		for (const re of reExportList) {
			const resolvedPath = resolver.resolve(re.sourceSpecifier, filePath);
			if (!resolvedPath) continue;

			// Named re-export: `export { X } from './bar'` or `export { X as Y }`
			if (re.exportedName === name) {
				const result = this.getExport(resolvedPath, re.originalName, resolver, visited);
				this.reExportsFollowed++;
				if (result !== undefined) {
					return result; // definedIn already set to the deepest file
				}
				// Entity not tracked (e.g. interface/type), but the named re-export
				// entry tells us exactly which file defines this name.
				return { nodeId: null, definedIn: resolvedPath };
			}

			// Namespace re-export: `export * from './bar'`
			if (re.exportedName === "*") {
				const result = this.getExport(resolvedPath, name, resolver, visited);
				if (result !== undefined) {
					this.reExportsFollowed++;
					return result; // definedIn already set to the deepest file
				}
				// For namespace re-exports we cannot confirm the name exists in the
				// target without entity tracking — don't guess.
			}
		}

		return undefined;
	}

	/**
	 * Looks up any entity (exported or not) defined in the same file.
	 * Used for resolving intra-file calls where the callee isn't imported.
	 */
	getLocalEntity(filePath: string, name: string): string | undefined {
		return this.fileEntities.get(filePath)?.get(name);
	}

	/**
	 * Returns all directly-exported names from a file. Used for resolving
	 * default imports via the single-export fallback heuristic.
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
		reExportsFollowed: 0,
		unresolvedCalls: [],
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

		// Track which target files have already received an IMPORTS edge from
		// this file, so that `import X from "@/api"` and `import type { T }
		// from "@/api"` don't produce two duplicate edges to the same barrel.
		const importedFiles = new Set<string>();

		for (const imp of imports) {
			const resolvedPath = resolver.resolve(imp.specifier, filePath);

			if (!resolvedPath) {
				if (!resolver.isBareSpecifier(imp.specifier, filePath)) {
					// Only count as failure if it's not an external package
					stats.importsFailed++;
				}
				continue;
			}

			stats.importsResolved++;

			// Collect the actual definition files for each resolved named import.
			// For barrel imports, getExport() follows the re-export chain and returns
			// `definedIn` = the real source file (e.g. posts.ts, not index.ts).
			// IMPORTS edges point to those definition files so graph traversal is
			// meaningful; we fall back to `resolvedPath` only when nothing resolves
			// (side-effect imports, unresolved type-only imports, namespace imports).
			const definedInFiles = new Set<string>();

			// Build the import map for this file: localName → resolved entity
			for (const imported of imp.importedNames) {
				const localName = imported.alias ?? imported.name;
				const resolved = registry.getExport(resolvedPath, imported.name, resolver);
				if (resolved) {
					definedInFiles.add(resolved.definedIn);
					// Only add to the import map when the entity is tracked (nodeId != null).
					// Type-only exports (interfaces, type aliases) have nodeId: null and
					// cannot be used for CALLS/RENDERS edge resolution.
					if (resolved.nodeId !== null) {
						importMap.set(localName, {
							nodeId: resolved.nodeId,
							filePath: resolved.definedIn,
						});
					}
				}
			}

			// Handle default imports
			if (imp.hasDefaultImport && imp.defaultOrNamespaceName) {
				const resolved = registry.getExport(resolvedPath, "default", resolver);
				if (resolved) {
					definedInFiles.add(resolved.definedIn);
					if (resolved.nodeId !== null) {
						importMap.set(imp.defaultOrNamespaceName, {
							nodeId: resolved.nodeId,
							filePath: resolved.definedIn,
						});
					}
				} else {
					// Fallback: if file has exactly one export, treat it as the default
					const fileExports = registry.getFileExports(resolvedPath);
					if (fileExports && fileExports.size === 1) {
						const [, singleNodeId] = [...fileExports.entries()][0]!;
						importMap.set(imp.defaultOrNamespaceName, {
							nodeId: singleNodeId,
							filePath: resolvedPath,
						});
						definedInFiles.add(resolvedPath);
					}
				}
			}

			// Namespace imports (`import * as X from "..."`) are not resolved
			// to individual entities — that would require tracking member accesses.

			// Create IMPORTS edges — one per actual definition file (deduplicated).
			// Fall back to the barrel/specifier file if no entities were resolved.
			const edgeTargets = definedInFiles.size > 0 ? definedInFiles : [resolvedPath];
			for (const targetPath of edgeTargets) {
				if (!importedFiles.has(targetPath)) {
					importedFiles.add(targetPath);
					newEdges.push({
						sourceId: nodeIdForFile(filePath),
						targetId: nodeIdForFile(targetPath),
						edge: { type: EdgeType.IMPORTS },
					});
					stats.edgesCreated++;
				}
			}
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
			stats.unresolvedCalls.push({
				calleeName: call.calleeName,
				callerNodeId: call.callerNodeId,
				file: call.callSiteFile,
				line: call.callSiteLine,
			});
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

	stats.reExportsFollowed = registry.reExportsFollowed;
	return { results: linkedResults, stats };
}
