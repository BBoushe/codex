/**
 * @fileoverview Parser-internal types for the visitor infrastructure.
 *
 * These types are used within the parser package to shuttle data between
 * the per-file visitor (Pass 1) and the cross-file linker (Pass 2).
 *
 * The public contract with `graph-client` remains `FileParseResult`
 * from `@codex/shared` — these types extend it with unresolved reference
 * tracking that gets consumed and discarded during linking.
 */

import type { FileParseResult } from "@codex/shared";
import type { Tree } from "./languageService";
import type { SourceFile } from "./fileWalker";

// ─────────────────────────────────────────────────────────────────────────────
// Unresolved references (produced by Pass 1, consumed by Pass 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An import statement that we've parsed but can't fully resolve yet
 * because we don't know the target file's nodeId.
 *
 * Example: `import { fetchUser } from "./services/user"`
 * → sourceFileRelPath: "src/api/index.ts"
 * → specifier: "./services/user"
 * → importedNames: [{ name: "fetchUser", alias: undefined }]
 */
export interface UnresolvedImport {
	kind: "import";
	/** Relative path of the file containing the import statement. */
	sourceFileRelPath: string;
	/** The raw module specifier as written in source (e.g. "./services/user"). */
	specifier: string;
	/** Individual imported bindings. Empty array for side-effect imports (`import "./styles"`). */
	importedNames: ImportedName[];
	/** True if this is `import * as X from "..."` */
	isNamespaceImport: boolean;
	/** True if this is a default import (`import X from "..."`) */
	hasDefaultImport: boolean;
	/** The local name for namespace or default imports (e.g. "X" in `import X from "..."`) */
	defaultOrNamespaceName: string | null;
}

export interface ImportedName {
	/** The exported name from the source module (e.g. "fetchUser"). */
	name: string;
	/** The local alias, if renamed (e.g. "getUser" in `import { fetchUser as getUser }`). */
	alias: string | null;
}

/**
 * A function/method call where the callee might be defined in another file.
 *
 * We store the local name used at the call site. The linker resolves this
 * against the import map to determine the target nodeId.
 */
export interface UnresolvedCall {
	kind: "call";
	/** nodeId of the calling entity (Function/Component). */
	callerNodeId: string;
	/** The name as written at the call site (e.g. "fetchUser", "service.getUser"). */
	calleeName: string;
	/** Line number of the call expression (for CallsEdge.callSiteLine). */
	callSiteLine: number;
	/** File containing the call. */
	callSiteFile: string;
}

/**
 * A JSX element referencing a component that might be from another file.
 *
 * Example: `<UserCard name={user.name} />`
 * → rendererNodeId: nodeId of the parent component
 * → componentName: "UserCard"
 */
export interface UnresolvedRender {
	kind: "render";
	/** nodeId of the component that renders this JSX element. */
	rendererNodeId: string;
	/** The tag name as written in JSX (e.g. "UserCard"). */
	componentName: string;
	/** Props passed in this JSX usage (for PASSES_PROP edges). */
	passedProps: PassedPropInfo[];
}

export interface PassedPropInfo {
	/** Prop name (e.g. "userId"). */
	name: string;
	/** How the value is passed. */
	passKind: "literal" | "variable" | "spread" | "expression";
}

/** Union of all unresolved reference types. */
export type UnresolvedReference =
	| UnresolvedImport
	| UnresolvedCall
	| UnresolvedRender;

// ─────────────────────────────────────────────────────────────────────────────
// Re-export metadata (produced by Pass 1, consumed by Pass 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single re-export entry captured from `export { X } from './bar'`,
 * `export * from './bar'`, or `export { X as Y } from './bar'`.
 *
 * These are separate from `UnresolvedReference` because they don't produce
 * graph edges themselves — they inform the linker's `ExportRegistry` so it
 * can follow re-export chains when resolving imports.
 */
export interface ReExportEntry {
	/** The name exposed by this file. `"*"` for namespace re-exports. */
	exportedName: string;
	/** The original name in the source module. `"*"` for namespace re-exports. */
	originalName: string;
	/** The raw module specifier as written (e.g. `"./UserCard"`). */
	sourceSpecifier: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extended parse result (internal to the parser package)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The output of a single-file visitor (Pass 1).
 *
 * Extends `FileParseResult` with unresolved references and re-export metadata
 * that the linker will process in Pass 2. After linking, these fields are
 * consumed and the result is narrowed back to a plain `FileParseResult`.
 */
export interface VisitorFileResult extends FileParseResult {
	/** References that require cross-file resolution. */
	unresolvedReferences: UnresolvedReference[];
	/** Re-exports extracted from this file (e.g. `export { X } from './bar'`). */
	reExports: ReExportEntry[];
	/**
	 * The local name of the entity exported as the default, if any.
	 * Set when the visitor encounters `export default SomeLocalName`.
	 * Used by the linker to register the entity under the `"default"` key.
	 */
	defaultExportName: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visitor interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contract for a language-specific AST visitor.
 *
 * Each supported language implements this interface. The visitor receives
 * a Tree-sitter parse tree and the file metadata, and produces the full
 * set of entities, intra-file relationships, and unresolved cross-file
 * references for that single file.
 *
 * Visitors must be stateless across files — all per-file state lives
 * within the `visit()` call.
 */
export interface Visitor {
	/**
	 * Extract entities and relationships from a parsed file.
	 *
	 * @param tree       - The Tree-sitter parse tree for the file.
	 * @param sourceCode - The raw file contents (needed for sourceCode properties).
	 * @param file       - Metadata about the file (paths, extension).
	 */
	visit(tree: Tree, sourceCode: string, file: SourceFile): VisitorFileResult;
}
