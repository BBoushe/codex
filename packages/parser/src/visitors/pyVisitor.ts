/**
 * @fileoverview Python AST visitor.
 *
 * Handles `.py` files. Extracts: Functions, Classes, Methods, Decorators,
 * and their relationships from a Tree-sitter parse tree.
 *
 * This is a **Pass 1** visitor — it produces fully resolved intra-file
 * relationships and unresolved cross-file references (imports, external calls).
 * A separate linker (Pass 2) resolves cross-file references after all files
 * have been visited.
 *
 * ## Scope
 * Only **top-level declarations** are extracted as graph entities. Nested
 * functions (e.g. closures inside a function) are part of their parent's
 * `sourceCode` but don't become separate nodes. This keeps the graph
 * navigable without drowning in implementation-detail nodes.
 *
 * ## Export Detection
 * Python has no `export` keyword. Two heuristics are used:
 *   1. If the file defines `__all__ = [...]`, only listed names are exported.
 *   2. Otherwise, all names NOT starting with `_` are considered public/exported.
 *
 * ## __init__.py as Barrel Files
 * `__init__.py` files serve the same role as TypeScript barrel files (`index.ts`).
 * Relative imports in `__init__.py` are treated as re-exports (`ReExportEntry`).
 *
 * ## Known Limitations
 * - **Dynamic imports**: `importlib.import_module(...)` is not resolved.
 * - **Conditional imports**: `if TYPE_CHECKING: import ...` are treated the same
 *   as unconditional imports.
 * - **Wildcard imports**: `from module import *` — individual names are not resolved.
 * - **Complex __all__ mutations**: Only direct `__all__ = [...]` assignment is parsed;
 *   `__all__ += [...]` or `__all__.append(...)` are not tracked.
 * - **Metaclass detection**: Only direct `ABC` inheritance is detected for isAbstract.
 */

import type { Node } from "web-tree-sitter";
import {
	NodeLabel,
	EdgeType,
	type FileNode,
	type FunctionNode,
	type ClassNode,
	type DecoratorNode,
} from "@codex/shared";
import {
	nodeIdForFile,
	nodeIdForFunction,
	nodeIdForClass,
	nodeIdForDecorator,
} from "@codex/shared";
import { languageFromExtension } from "../languageService";
import type { Tree } from "../languageService";
import type { SourceFile } from "../fileWalker";
import type {
	Visitor,
	VisitorFileResult,
	UnresolvedReference,
	ReExportEntry,
	ImportedName,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Top-level Python standard library modules that should be skipped
 * when recording imports (we only care about project-internal imports).
 *
 * This is intentionally a small set of the most common stdlib modules.
 * Bare imports (no dots) that aren't in this set will still be recorded —
 * the linker will discard them if they can't be resolved to a project file.
 */
const STDLIB_TOP_LEVEL = new Set([
	"abc",
	"argparse",
	"ast",
	"asyncio",
	"base64",
	"bisect",
	"builtins",
	"calendar",
	"cmath",
	"codecs",
	"collections",
	"concurrent",
	"configparser",
	"contextlib",
	"copy",
	"csv",
	"ctypes",
	"dataclasses",
	"datetime",
	"decimal",
	"difflib",
	"dis",
	"email",
	"enum",
	"errno",
	"fcntl",
	"fileinput",
	"fnmatch",
	"fractions",
	"functools",
	"gc",
	"getpass",
	"glob",
	"gzip",
	"hashlib",
	"heapq",
	"hmac",
	"html",
	"http",
	"importlib",
	"inspect",
	"io",
	"itertools",
	"json",
	"keyword",
	"linecache",
	"locale",
	"logging",
	"math",
	"mimetypes",
	"multiprocessing",
	"numbers",
	"operator",
	"os",
	"pathlib",
	"pdb",
	"pickle",
	"platform",
	"pprint",
	"profile",
	"pstats",
	"queue",
	"random",
	"re",
	"readline",
	"reprlib",
	"sched",
	"secrets",
	"select",
	"shelve",
	"shlex",
	"shutil",
	"signal",
	"site",
	"smtplib",
	"socket",
	"sqlite3",
	"ssl",
	"stat",
	"statistics",
	"string",
	"struct",
	"subprocess",
	"sys",
	"syslog",
	"tempfile",
	"textwrap",
	"threading",
	"time",
	"timeit",
	"tkinter",
	"token",
	"tokenize",
	"tomllib",
	"trace",
	"traceback",
	"tracemalloc",
	"turtle",
	"types",
	"typing",
	"typing_extensions",
	"unicodedata",
	"unittest",
	"urllib",
	"uuid",
	"venv",
	"warnings",
	"wave",
	"weakref",
	"webbrowser",
	"xml",
	"xmlrpc",
	"zipfile",
	"zipimport",
	"zlib",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Pure helper functions
// ─────────────────────────────────────────────────────────────────────────────

/** Simple LOC: endRow - startRow + 1 (includes blanks and comments). */
function nodeLoc(node: Node): number {
	return node.endPosition.row - node.startPosition.row + 1;
}

/**
 * Extracts human-readable parameter strings from a `parameters` node.
 *
 * Tree-sitter Python CST structure for `parameters`:
 * ```
 * parameters
 *   identifier "self"
 *   typed_parameter "name: str"
 *   default_parameter "age = 0"
 *   typed_default_parameter "city: str = 'NYC'"
 *   list_splat_pattern "*args"
 *   dictionary_splat_pattern "**kwargs"
 * ```
 */
function extractParameters(paramsNode: Node): string[] {
	const params: string[] = [];
	for (const child of paramsNode.namedChildren) {
		switch (child.type) {
			case "identifier":
				// Skip `self` and `cls` — they're implicit in Python
				if (child.text !== "self" && child.text !== "cls") {
					params.push(child.text);
				}
				break;
			case "typed_parameter":
				params.push(child.text);
				break;
			case "default_parameter":
				params.push(child.text);
				break;
			case "typed_default_parameter":
				params.push(child.text);
				break;
			case "list_splat_pattern":
				params.push(child.text);
				break;
			case "dictionary_splat_pattern":
				params.push(child.text);
				break;
		}
	}
	return params;
}

/**
 * Extracts the return type annotation string from a function node.
 *
 * In Python, the return type is the `type` field of a `function_definition`:
 * ```python
 * def foo(x: int) -> str:
 *     ...
 * ```
 * Tree-sitter field name: `return_type` (a `type` node).
 */
function extractReturnType(fnNode: Node): string | null {
	const returnType = fnNode.childForFieldName("return_type");
	if (!returnType) return null;
	// The return type node text includes the `-> ` prefix in some grammars;
	// strip it if present.
	const text = returnType.text;
	return text.startsWith("->") ? text.slice(2).trim() : text;
}

/**
 * Checks whether a function node is async.
 *
 * In Tree-sitter Python, `async def` is represented by the presence
 * of an unnamed `async` child before `def`.
 */
function isAsyncNode(node: Node): boolean {
	for (const child of node.children) {
		if (child.type === "async") return true;
		// Stop once we hit `def` keyword
		if (!child.isNamed && child.text === "def") break;
	}
	return false;
}

/**
 * Extracts parameter names as a flat set (for excluding callback invocations
 * from being recorded as function calls).
 */
function extractParameterNames(paramsNode: Node): Set<string> {
	const names = new Set<string>();
	for (const child of paramsNode.namedChildren) {
		switch (child.type) {
			case "identifier":
				if (child.text !== "self" && child.text !== "cls") {
					names.add(child.text);
				}
				break;
			case "typed_parameter": {
				const nameNode = child.namedChildren.find(
					(c) => c.type === "identifier",
				);
				if (nameNode) names.add(nameNode.text);
				break;
			}
			case "default_parameter": {
				const nameNode = child.namedChildren.find(
					(c) => c.type === "identifier",
				);
				if (nameNode) names.add(nameNode.text);
				break;
			}
			case "typed_default_parameter": {
				const nameNode = child.namedChildren.find(
					(c) => c.type === "identifier",
				);
				if (nameNode) names.add(nameNode.text);
				break;
			}
		}
	}
	return names;
}

/**
 * Resolves a Python relative import specifier to a project-relative path.
 *
 * Examples (assuming current file is `src/models/__init__.py`):
 *   - `from .animal import Animal`  → specifier=".animal", dots=1 → "src/models/animal"
 *   - `from ..util import helper`   → specifier="..util", dots=2 → "src/util"
 *   - `from . import animal`        → specifier=".", dots=1 → "src/models"
 *
 * @param currentFilePath - Relative path of the importing file (e.g. "src/models/__init__.py")
 * @param modulePart      - The dotted module name after the dots (e.g. "animal", "util.helper", or "")
 * @param dotCount        - Number of leading dots (1 = current package, 2 = parent, etc.)
 * @returns The resolved module specifier as a relative-ish path, or null if unresolvable.
 */
function resolveRelativeImport(
	currentFilePath: string,
	modulePart: string,
	dotCount: number,
): string | null {
	// Split the current file path into segments
	const segments = currentFilePath.split("/");
	// Remove the filename to get the directory
	segments.pop();

	// Each dot beyond the first goes up one more directory
	for (let i = 1; i < dotCount; i++) {
		if (segments.length === 0) return null; // Can't go above root
		segments.pop();
	}

	// Append the module part (dots → slashes)
	if (modulePart) {
		for (const part of modulePart.split(".")) {
			segments.push(part);
		}
	}

	return segments.join("/");
}

// ─────────────────────────────────────────────────────────────────────────────
// Visit context — accumulates results within a single file visit
// ─────────────────────────────────────────────────────────────────────────────

interface VisitContext {
	/** Relative file path (used for nodeId generation and graph storage). */
	filePath: string;
	/** nodeId of the current file's FileNode. */
	fileNodeId: string;
	/** Whether this file is an __init__.py (barrel file). */
	isInitFile: boolean;
	/** Accumulated entity nodes. */
	entities: {
		node: FileNode | FunctionNode | ClassNode | DecoratorNode;
	}[];
	/** Accumulated intra-file relationships. */
	relationships: {
		sourceId: string;
		targetId: string;
		edge: { type: EdgeType } & Record<string, unknown>;
	}[];
	/** Accumulated cross-file references for the linker. */
	unresolvedRefs: UnresolvedReference[];
	/** Re-export entries for barrel-file support (Pass 2 input). */
	reExports: ReExportEntry[];
	/**
	 * Names listed in `__all__`, if the file defines it.
	 * `null` means no `__all__` was found — use naming convention instead.
	 */
	allExports: Set<string> | null;
	/**
	 * Set of names defined at module level (functions, classes).
	 * Used to distinguish local calls from cross-file calls.
	 */
	localDefinitions: Set<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visitor implementation
// ─────────────────────────────────────────────────────────────────────────────

export class PythonVisitor implements Visitor {
	visit(tree: Tree, sourceCode: string, file: SourceFile): VisitorFileResult {
		const filePath = file.relativePath;
		const fileNodeId = nodeIdForFile(filePath);
		const fileName = filePath.split("/").pop() ?? filePath;
		const isInitFile = fileName === "__init__.py";

		const ctx: VisitContext = {
			filePath,
			fileNodeId,
			isInitFile,
			entities: [],
			relationships: [],
			unresolvedRefs: [],
			reExports: [],
			allExports: null,
			localDefinitions: new Set(),
		};

		// ── FileNode ────────────────────────────────────────────────────
		const fileNode: FileNode = {
			label: NodeLabel.File,
			nodeId: fileNodeId,
			name: fileName,
			qualifiedName: filePath,
			filePath,
			language: languageFromExtension(file.extension),
			loc: tree.rootNode.endPosition.row + 1,
			extension: file.extension,
		};

		// ── Pre-pass: extract __all__ ───────────────────────────────────
		// Done first so export status is known when processing declarations.
		for (const child of tree.rootNode.children) {
			try {
				this.extractDunderAll(child, ctx);
			} catch {
				// Non-critical — skip silently
			}
		}

		// ── Pre-pass: collect local definition names ────────────────────
		// Needed to distinguish local calls from cross-file calls.
		for (const child of tree.rootNode.children) {
			try {
				this.collectLocalDefinitionName(child, ctx);
			} catch {
				// Non-critical — skip silently
			}
		}

		// ── Walk top-level statements ───────────────────────────────────
		for (const child of tree.rootNode.children) {
			try {
				this.processTopLevel(child, ctx);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(
					`[parser] Skipped ${child.type} at ${filePath}:${child.startPosition.row + 1} — ${msg}`,
				);
			}
		}

		return {
			file: fileNode,
			entities: ctx.entities,
			relationships: ctx.relationships,
			unresolvedReferences: ctx.unresolvedRefs,
			reExports: ctx.reExports,
			defaultExportName: null, // Python has no default exports
		};
	}

	// ── __all__ extraction ──────────────────────────────────────────────

	/**
	 * Parses `__all__ = ['Name1', 'Name2']` assignment to determine
	 * explicitly exported names.
	 *
	 * CST shape:
	 * ```
	 * expression_statement
	 *   assignment
	 *     identifier "__all__"
	 *     list ["Name1", "Name2"]
	 *       string "'Name1'"
	 *       string "'Name2'"
	 * ```
	 */
	private extractDunderAll(node: Node, ctx: VisitContext): void {
		if (node.type !== "expression_statement") return;

		const assignment = node.namedChildren.find(
			(c) => c.type === "assignment",
		);
		if (!assignment) return;

		const left = assignment.childForFieldName("left");
		if (!left || left.type !== "identifier" || left.text !== "__all__") return;

		const right = assignment.childForFieldName("right");
		if (!right || right.type !== "list") return;

		const names = new Set<string>();
		for (const elem of right.namedChildren) {
			if (elem.type === "string") {
				const value = this.extractStringValue(elem);
				if (value) names.add(value);
			}
		}

		if (names.size > 0) {
			ctx.allExports = names;
		}
	}

	/**
	 * Collects the name of a top-level definition for the local definitions set.
	 */
	private collectLocalDefinitionName(node: Node, ctx: VisitContext): void {
		if (node.type === "function_definition") {
			const nameNode = node.childForFieldName("name");
			if (nameNode) ctx.localDefinitions.add(nameNode.text);
			return;
		}

		if (node.type === "class_definition") {
			const nameNode = node.childForFieldName("name");
			if (nameNode) ctx.localDefinitions.add(nameNode.text);
			return;
		}

		if (node.type === "decorated_definition") {
			// Look inside for the actual definition
			for (const child of node.namedChildren) {
				if (
					child.type === "function_definition" ||
					child.type === "class_definition"
				) {
					const nameNode = child.childForFieldName("name");
					if (nameNode) ctx.localDefinitions.add(nameNode.text);
				}
			}
		}
	}

	// ── Export detection ────────────────────────────────────────────────

	/**
	 * Determines if a name is exported based on `__all__` or naming convention.
	 *
	 * Rules:
	 *   1. If `__all__` is defined → name must be in `__all__`.
	 *   2. Otherwise → name must NOT start with `_`.
	 */
	private isExported(name: string, ctx: VisitContext): boolean {
		if (ctx.allExports !== null) {
			return ctx.allExports.has(name);
		}
		return !name.startsWith("_");
	}

	// ── Top-level dispatch ──────────────────────────────────────────────

	private processTopLevel(node: Node, ctx: VisitContext): void {
		switch (node.type) {
			case "import_statement":
				this.handleImportStatement(node, ctx);
				break;
			case "import_from_statement":
				this.handleImportFromStatement(node, ctx);
				break;
			case "function_definition":
				this.handleFunctionDefinition(node, ctx, []);
				break;
			case "class_definition":
				this.handleClassDefinition(node, ctx, []);
				break;
			case "decorated_definition":
				this.handleDecoratedDefinition(node, ctx);
				break;
			// expression_statement (assignments, calls), if_statement, etc.
			// are intentionally skipped — they don't produce graph entities in v1.
		}
	}

	// ── Import statements ───────────────────────────────────────────────

	/**
	 * Handles `import os`, `import os.path`, `import foo.bar as baz`.
	 *
	 * CST shape:
	 * ```
	 * import_statement
	 *   dotted_name "os.path"
	 * ```
	 * or with alias:
	 * ```
	 * import_statement
	 *   aliased_import
	 *     dotted_name "foo.bar"
	 *     identifier "baz"
	 * ```
	 *
	 * Bare imports (stdlib, third-party) are skipped — we only care about
	 * project-internal imports, and bare `import X` is almost always stdlib
	 * or third-party.
	 */
	private handleImportStatement(node: Node, ctx: VisitContext): void {
		for (const child of node.namedChildren) {
			let moduleName: string | null = null;
			let localName: string | null = null;

			if (child.type === "dotted_name") {
				moduleName = child.text;
				localName = child.text.split(".").pop() ?? null;
			} else if (child.type === "aliased_import") {
				const dottedName = child.namedChildren.find(
					(c) => c.type === "dotted_name",
				);
				const alias = child.namedChildren.find(
					(c) => c.type === "identifier",
				);
				moduleName = dottedName?.text ?? null;
				localName = alias?.text ?? dottedName?.text.split(".").pop() ?? null;
			}

			if (!moduleName) continue;

			// Skip known stdlib modules
			const topModule = moduleName.split(".")[0];
			if (topModule && STDLIB_TOP_LEVEL.has(topModule)) continue;

			ctx.unresolvedRefs.push({
				kind: "import",
				sourceFileRelPath: ctx.filePath,
				specifier: moduleName,
				importedNames: [],
				isNamespaceImport: true,
				hasDefaultImport: false,
				defaultOrNamespaceName: localName,
			});
		}
	}

	/**
	 * Handles `from X import Y` statements.
	 *
	 * CST shapes:
	 *
	 * Relative import:
	 * ```
	 * import_from_statement
	 *   relative_import
	 *     import_prefix "."
	 *     dotted_name "animal"
	 *   dotted_name "Animal"        ← imported name
	 * ```
	 *
	 * Absolute import:
	 * ```
	 * import_from_statement
	 *   dotted_name "typing"        ← module
	 *   dotted_name "List"          ← imported name
	 * ```
	 *
	 * With aliases:
	 * ```
	 * import_from_statement
	 *   dotted_name "module"
	 *   aliased_import
	 *     dotted_name "OrigName"
	 *     identifier "AliasName"
	 * ```
	 *
	 * Wildcard:
	 * ```
	 * import_from_statement
	 *   dotted_name "module"
	 *   wildcard_import "*"
	 * ```
	 */
	private handleImportFromStatement(node: Node, ctx: VisitContext): void {
		// ── Determine the module specifier ─────────────────────────────
		let specifier: string | null = null;
		let isRelative = false;
		let dotCount = 0;
		let modulePart = "";

		const relativeImport = node.namedChildren.find(
			(c) => c.type === "relative_import",
		);

		if (relativeImport) {
			isRelative = true;
			// Count dots from the import_prefix
			const prefix = relativeImport.namedChildren.find(
				(c) => c.type === "import_prefix",
			);
			dotCount = prefix ? prefix.text.length : 1;

			// Get the module name part after the dots
			const dottedName = relativeImport.namedChildren.find(
				(c) => c.type === "dotted_name",
			);
			modulePart = dottedName?.text ?? "";

			// Build the specifier: dots + module
			const dots = ".".repeat(dotCount);
			specifier = modulePart ? `${dots}${modulePart}` : dots;
		} else {
			// Absolute import — the first dotted_name is the module
			const moduleNode = node.namedChildren.find(
				(c) => c.type === "dotted_name",
			);
			if (!moduleNode) return;
			specifier = moduleNode.text;

			// Skip known stdlib imports
			const topModule = specifier.split(".")[0];
			if (topModule && STDLIB_TOP_LEVEL.has(topModule)) return;
		}

		if (!specifier) return;

		// ── Extract imported names ─────────────────────────────────────
		const importedNames: ImportedName[] = [];
		let isWildcard = false;

		// Skip the module specifier node(s) — imported names come after
		const moduleNodeTypes = new Set([
			"relative_import",
			"dotted_name",
		]);

		// The first dotted_name (or relative_import) is the module source.
		// Subsequent named children are the imported names.
		let pastModule = false;
		for (const child of node.namedChildren) {
			if (!pastModule) {
				if (moduleNodeTypes.has(child.type)) {
					// For absolute imports, the first dotted_name is the module.
					// For relative imports, the relative_import node is the module.
					if (isRelative && child.type === "relative_import") {
						pastModule = true;
					} else if (!isRelative && child.type === "dotted_name") {
						pastModule = true;
					}
					continue;
				}
				// If we hit a non-module node type, we're past the module
				pastModule = true;
			}

			if (child.type === "dotted_name" || child.type === "identifier") {
				importedNames.push({ name: child.text, alias: null });
			} else if (child.type === "aliased_import") {
				const nameNode = child.namedChildren.find(
					(c) => c.type === "dotted_name" || c.type === "identifier",
				);
				const aliasNode = child.namedChildren.find(
					(c) =>
						c.type === "identifier" &&
						c !== nameNode,
				);
				if (nameNode) {
					importedNames.push({
						name: nameNode.text,
						alias: aliasNode?.text ?? null,
					});
				}
			} else if (child.type === "wildcard_import") {
				isWildcard = true;
			}
		}

		// ── Record unresolved import ───────────────────────────────────
		ctx.unresolvedRefs.push({
			kind: "import",
			sourceFileRelPath: ctx.filePath,
			specifier,
			importedNames,
			isNamespaceImport: isWildcard,
			hasDefaultImport: false,
			defaultOrNamespaceName: null,
		});

		// ── Re-exports from __init__.py ────────────────────────────────
		// Relative imports in __init__.py are re-exports.
		if (ctx.isInitFile && isRelative) {
			// Resolve the relative import to a source specifier for the linker
			const resolvedPath = resolveRelativeImport(
				ctx.filePath,
				modulePart,
				dotCount,
			);

			if (resolvedPath !== null) {
				if (isWildcard) {
					ctx.reExports.push({
						exportedName: "*",
						originalName: "*",
						sourceSpecifier: specifier,
					});
				} else {
					for (const imported of importedNames) {
						ctx.reExports.push({
							exportedName: imported.alias ?? imported.name,
							originalName: imported.name,
							sourceSpecifier: specifier,
						});
					}
				}
			}
		}
	}

	// ── Decorated definitions ───────────────────────────────────────────

	/**
	 * Handles `decorated_definition` which wraps a function or class with
	 * one or more decorators.
	 *
	 * CST shape:
	 * ```
	 * decorated_definition
	 *   decorator "@app.route('/api')"
	 *     call
	 *       attribute "app.route"
	 *       argument_list "('/api')"
	 *   decorator "@login_required"
	 *     identifier "login_required"
	 *   function_definition
	 *     name: "handle_request"
	 *     ...
	 * ```
	 */
	private handleDecoratedDefinition(node: Node, ctx: VisitContext): void {
		// ── Extract decorators ──────────────────────────────────────────
		const decoratorNodes: Node[] = [];
		let innerDefinition: Node | null = null;

		for (const child of node.namedChildren) {
			if (child.type === "decorator") {
				decoratorNodes.push(child);
			} else if (
				child.type === "function_definition" ||
				child.type === "class_definition"
			) {
				innerDefinition = child;
			}
		}

		if (!innerDefinition) return;

		// ── Create decorator entities ───────────────────────────────────
		const decoratorInfos: { nodeId: string; name: string }[] = [];
		for (const decNode of decoratorNodes) {
			const decoratorInfo = this.extractDecorator(
				decNode,
				innerDefinition,
				ctx,
			);
			if (decoratorInfo) {
				decoratorInfos.push(decoratorInfo);
			}
		}

		// ── Process the inner definition ────────────────────────────────
		if (innerDefinition.type === "function_definition") {
			this.handleFunctionDefinition(innerDefinition, ctx, decoratorInfos);
		} else if (innerDefinition.type === "class_definition") {
			this.handleClassDefinition(innerDefinition, ctx, decoratorInfos);
		}
	}

	/**
	 * Extracts a single decorator into a `DecoratorNode` entity.
	 *
	 * Decorator CST variations:
	 *   - Simple: `@staticmethod` → identifier
	 *   - Attribute: `@app.route` → attribute (dotted)
	 *   - Call: `@app.route('/api')` → call > attribute + argument_list
	 *   - Simple call: `@pytest.mark.parametrize(...)` → call > attribute + argument_list
	 */
	private extractDecorator(
		decNode: Node,
		targetNode: Node,
		ctx: VisitContext,
	): { nodeId: string; name: string } | null {
		// The decorator's expression is inside the decorator node,
		// after the @ symbol. It can be an identifier, attribute, or call.
		let decoratorName: string | null = null;
		const decoratorArgs: string[] = [];

		// Find the main expression in the decorator
		for (const child of decNode.namedChildren) {
			if (child.type === "identifier") {
				decoratorName = child.text;
			} else if (child.type === "attribute") {
				decoratorName = child.text;
			} else if (child.type === "call") {
				// `@decorator(args)` — the function part is the name
				const fn = child.childForFieldName("function");
				if (fn) {
					decoratorName = fn.text;
				}
				// Extract arguments
				const args = child.childForFieldName("arguments");
				if (args) {
					for (const arg of args.namedChildren) {
						decoratorArgs.push(arg.text);
					}
				}
			}
		}

		if (!decoratorName) return null;

		const targetLine = targetNode.startPosition.row + 1;
		const nodeId = nodeIdForDecorator(ctx.filePath, decoratorName, targetLine);

		const decorator: DecoratorNode = {
			label: NodeLabel.Decorator,
			nodeId,
			name: decoratorName,
			qualifiedName: `${ctx.filePath}::@${decoratorName}:L${targetLine}`,
			filePath: ctx.filePath,
			startLine: decNode.startPosition.row + 1,
			decoratorKind: "decorator",
			arguments: decoratorArgs,
		};

		ctx.entities.push({ node: decorator });

		// DEFINED_IN: Decorator → File
		ctx.relationships.push({
			sourceId: nodeId,
			targetId: ctx.fileNodeId,
			edge: { type: EdgeType.DEFINED_IN },
		});

		return { nodeId, name: decoratorName };
	}

	// ── Function definitions ────────────────────────────────────────────

	/**
	 * Handles `def function_name(...): ...` at module level.
	 *
	 * CST shape:
	 * ```
	 * function_definition
	 *   name: identifier "function_name"
	 *   parameters: parameters "(self, arg1: int, arg2: str = 'default')"
	 *   return_type: type "-> str"
	 *   body: block
	 *     ...
	 * ```
	 */
	private handleFunctionDefinition(
		node: Node,
		ctx: VisitContext,
		decorators: { nodeId: string; name: string }[],
	): void {
		const nameNode = node.childForFieldName("name");
		if (!nameNode) return;

		const name = nameNode.text;
		const paramsNode = node.childForFieldName("parameters");
		const isExported = this.isExported(name, ctx);
		const nodeId = nodeIdForFunction(ctx.filePath, name);

		const funcNode: FunctionNode = {
			label: NodeLabel.Function,
			nodeId,
			name,
			qualifiedName: `${ctx.filePath}::${name}`,
			filePath: ctx.filePath,
			startLine: node.startPosition.row + 1,
			endLine: node.endPosition.row + 1,
			loc: nodeLoc(node),
			parameters: paramsNode ? extractParameters(paramsNode) : [],
			returnType: extractReturnType(node),
			isExported,
			isAsync: isAsyncNode(node),
			sourceCode: node.text,
		};

		ctx.entities.push({ node: funcNode });

		// DEFINED_IN: Function → File
		ctx.relationships.push({
			sourceId: nodeId,
			targetId: ctx.fileNodeId,
			edge: { type: EdgeType.DEFINED_IN },
		});

		// EXPORTS: File → Function
		if (isExported) {
			ctx.relationships.push({
				sourceId: ctx.fileNodeId,
				targetId: nodeId,
				edge: { type: EdgeType.EXPORTS },
			});
		}

		// DECORATED_BY: Function → Decorator
		for (const dec of decorators) {
			ctx.relationships.push({
				sourceId: nodeId,
				targetId: dec.nodeId,
				edge: { type: EdgeType.DECORATED_BY },
			});
		}

		// Extract calls from function body
		const body = node.childForFieldName("body");
		if (body) {
			const paramNames = paramsNode
				? extractParameterNames(paramsNode)
				: new Set<string>();
			this.extractCalls(body, nodeId, ctx, paramNames);
		}
	}

	// ── Class definitions ───────────────────────────────────────────────

	/**
	 * Handles `class ClassName(Base1, Base2): ...`
	 *
	 * CST shape:
	 * ```
	 * class_definition
	 *   name: identifier "ClassName"
	 *   superclasses: argument_list "(Base1, Base2)"
	 *     identifier "Base1"
	 *     identifier "Base2"
	 *   body: block
	 *     function_definition   ← method
	 *     decorated_definition  ← decorated method
	 *     ...
	 * ```
	 */
	private handleClassDefinition(
		node: Node,
		ctx: VisitContext,
		decorators: { nodeId: string; name: string }[],
	): void {
		const nameNode = node.childForFieldName("name");
		if (!nameNode) return;

		const name = nameNode.text;
		const nodeId = nodeIdForClass(ctx.filePath, name);
		const isExported = this.isExported(name, ctx);

		// ── Base classes ────────────────────────────────────────────
		let parentClass: string | null = null;
		const interfaces: string[] = [];
		let isAbstract = false;

		const superclasses = node.childForFieldName("superclasses");
		if (superclasses) {
			const bases: string[] = [];
			for (const child of superclasses.namedChildren) {
				if (
					child.type === "identifier" ||
					child.type === "attribute"
				) {
					bases.push(child.text);
				} else if (child.type === "keyword_argument") {
					// e.g. `metaclass=ABCMeta` — skip these
					continue;
				}
			}

			// Check for ABC (Abstract Base Class) inheritance
			for (const base of bases) {
				if (
					base === "ABC" ||
					base === "ABCMeta" ||
					base === "abc.ABC" ||
					base === "abc.ABCMeta"
				) {
					isAbstract = true;
				}
			}

			// First non-ABC base is the parent class; others could be mixins
			// (Python supports multiple inheritance, but for the graph we
			// record the primary parent and treat others as interfaces/mixins)
			for (const base of bases) {
				if (
					base === "ABC" ||
					base === "ABCMeta" ||
					base === "abc.ABC" ||
					base === "abc.ABCMeta"
				) {
					continue;
				}
				if (parentClass === null) {
					parentClass = base;
				} else {
					interfaces.push(base);
				}
			}
		}

		// ── Also check for abstract methods (alternative ABC detection) ─
		// A class is abstract if it has methods decorated with @abstractmethod
		const classBody = node.childForFieldName("body");
		if (classBody && !isAbstract) {
			for (const member of classBody.namedChildren) {
				if (member.type === "decorated_definition") {
					for (const child of member.namedChildren) {
						if (child.type === "decorator") {
							for (const decChild of child.namedChildren) {
								if (
									decChild.type === "identifier" &&
									decChild.text === "abstractmethod"
								) {
									isAbstract = true;
								}
							}
						}
					}
				}
				if (isAbstract) break;
			}
		}

		// ── Methods ─────────────────────────────────────────────────
		const methods: string[] = [];
		if (classBody) {
			for (const member of classBody.namedChildren) {
				if (member.type === "function_definition") {
					const methodName = member.childForFieldName("name");
					if (methodName) methods.push(methodName.text);
				} else if (member.type === "decorated_definition") {
					// Look inside decorated definition for the method
					for (const child of member.namedChildren) {
						if (child.type === "function_definition") {
							const methodName = child.childForFieldName("name");
							if (methodName) methods.push(methodName.text);
						}
					}
				}
			}
		}

		const classNode: ClassNode = {
			label: NodeLabel.Class,
			nodeId,
			name,
			qualifiedName: `${ctx.filePath}::${name}`,
			filePath: ctx.filePath,
			startLine: node.startPosition.row + 1,
			endLine: node.endPosition.row + 1,
			loc: nodeLoc(node),
			methods,
			isExported,
			isAbstract,
			parentClass,
			interfaces,
			sourceCode: node.text,
		};

		ctx.entities.push({ node: classNode });

		// DEFINED_IN: Class → File
		ctx.relationships.push({
			sourceId: nodeId,
			targetId: ctx.fileNodeId,
			edge: { type: EdgeType.DEFINED_IN },
		});

		// EXPORTS: File → Class
		if (isExported) {
			ctx.relationships.push({
				sourceId: ctx.fileNodeId,
				targetId: nodeId,
				edge: { type: EdgeType.EXPORTS },
			});
		}

		// DECORATED_BY: Class → Decorator
		for (const dec of decorators) {
			ctx.relationships.push({
				sourceId: nodeId,
				targetId: dec.nodeId,
				edge: { type: EdgeType.DECORATED_BY },
			});
		}

		// INHERITS: Class → Parent Class (unresolved — recorded as call-like ref
		// for the linker, but also stored as INHERITS if local)
		if (parentClass) {
			ctx.unresolvedRefs.push({
				kind: "call",
				callerNodeId: nodeId,
				calleeName: parentClass,
				callSiteLine: node.startPosition.row + 1,
				callSiteFile: ctx.filePath,
			});
		}

		// ── Process methods ─────────────────────────────────────────
		if (classBody) {
			this.processClassBody(classBody, name, nodeId, ctx);
		}
	}

	/**
	 * Processes the body of a class, extracting methods and their decorators.
	 */
	private processClassBody(
		classBody: Node,
		className: string,
		classNodeId: string,
		ctx: VisitContext,
	): void {
		for (const member of classBody.namedChildren) {
			try {
				if (member.type === "function_definition") {
					this.handleMethodDefinition(
						member,
						className,
						classNodeId,
						ctx,
						[],
					);
				} else if (member.type === "decorated_definition") {
					// Extract decorators and inner method
					const decoratorNodes: Node[] = [];
					let innerFn: Node | null = null;

					for (const child of member.namedChildren) {
						if (child.type === "decorator") {
							decoratorNodes.push(child);
						} else if (child.type === "function_definition") {
							innerFn = child;
						}
					}

					if (innerFn) {
						// Create decorator entities for the method
						const decoratorInfos: { nodeId: string; name: string }[] = [];
						for (const decNode of decoratorNodes) {
							const info = this.extractDecorator(decNode, innerFn, ctx);
							if (info) decoratorInfos.push(info);
						}

						this.handleMethodDefinition(
							innerFn,
							className,
							classNodeId,
							ctx,
							decoratorInfos,
						);
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(
					`[parser] Skipped class member at ${ctx.filePath}:${member.startPosition.row + 1} — ${msg}`,
				);
			}
		}
	}

	/**
	 * Handles a method definition inside a class body.
	 *
	 * Methods are stored as `FunctionNode` entities with a qualified name
	 * scoped to the class: `"file.py::ClassName.method_name"`.
	 */
	private handleMethodDefinition(
		node: Node,
		className: string,
		classNodeId: string,
		ctx: VisitContext,
		decorators: { nodeId: string; name: string }[],
	): void {
		const nameNode = node.childForFieldName("name");
		if (!nameNode) return;

		const methodName = nameNode.text;
		const qualifiedMethodName = `${className}.${methodName}`;
		const nodeId = nodeIdForFunction(ctx.filePath, qualifiedMethodName);
		const paramsNode = node.childForFieldName("parameters");

		const funcNode: FunctionNode = {
			label: NodeLabel.Function,
			nodeId,
			name: methodName,
			qualifiedName: `${ctx.filePath}::${qualifiedMethodName}`,
			filePath: ctx.filePath,
			startLine: node.startPosition.row + 1,
			endLine: node.endPosition.row + 1,
			loc: nodeLoc(node),
			parameters: paramsNode ? extractParameters(paramsNode) : [],
			returnType: extractReturnType(node),
			isExported: false, // Methods are not directly exported
			isAsync: isAsyncNode(node),
			sourceCode: node.text,
		};

		ctx.entities.push({ node: funcNode });

		// DEFINED_IN: Method → File
		ctx.relationships.push({
			sourceId: nodeId,
			targetId: ctx.fileNodeId,
			edge: { type: EdgeType.DEFINED_IN },
		});

		// CONTAINS: Class → Method (the class "contains" the method)
		ctx.relationships.push({
			sourceId: classNodeId,
			targetId: nodeId,
			edge: { type: EdgeType.CONTAINS },
		});

		// DECORATED_BY: Method → Decorator
		for (const dec of decorators) {
			ctx.relationships.push({
				sourceId: nodeId,
				targetId: dec.nodeId,
				edge: { type: EdgeType.DECORATED_BY },
			});
		}

		// Extract calls from method body
		const body = node.childForFieldName("body");
		if (body) {
			const paramNames = paramsNode
				? extractParameterNames(paramsNode)
				: new Set<string>();
			this.extractCalls(body, nodeId, ctx, paramNames);
		}
	}

	// ── Call extraction ─────────────────────────────────────────────────

	/**
	 * Extracts function calls from a body node as `UnresolvedCall` references.
	 *
	 * Only direct identifier calls (`fetch_user()`) are captured — attribute
	 * calls (`obj.method()`) are skipped because they can't be resolved
	 * to graph entities without type information.
	 *
	 * @param excludeNames - Parameter names of the enclosing function.
	 *   These are callback invocations, not calls to standalone functions.
	 */
	private extractCalls(
		body: Node,
		callerNodeId: string,
		ctx: VisitContext,
		excludeNames?: Set<string>,
	): void {
		const callExprs = body.descendantsOfType("call");

		for (const call of callExprs) {
			const callee = call.childForFieldName("function");
			if (!callee || callee.type !== "identifier") continue;

			const name = callee.text;

			// Skip builtins and common stdlib functions
			if (this.isBuiltinName(name)) continue;
			// Skip callback parameters
			if (excludeNames?.has(name)) continue;
			// Skip `self` and `cls`
			if (name === "self" || name === "cls") continue;

			ctx.unresolvedRefs.push({
				kind: "call",
				callerNodeId,
				calleeName: name,
				callSiteLine: call.startPosition.row + 1,
				callSiteFile: ctx.filePath,
			});
		}
	}

	// ── Utilities ───────────────────────────────────────────────────────

	/**
	 * Extracts the string value from a Python string node, stripping quotes.
	 *
	 * Handles single-quoted, double-quoted, and their triple-quoted variants.
	 */
	private extractStringValue(node: Node): string {
		// Tree-sitter Python wraps string content in string_content children
		const content = node.namedChildren.find(
			(c) => c.type === "string_content",
		);
		if (content) return content.text;

		// Fallback: strip quotes manually
		const text = node.text;
		if (
			(text.startsWith("'") && text.endsWith("'")) ||
			(text.startsWith('"') && text.endsWith('"'))
		) {
			return text.slice(1, -1);
		}
		if (
			(text.startsWith("'''") && text.endsWith("'''")) ||
			(text.startsWith('"""') && text.endsWith('"""'))
		) {
			return text.slice(3, -3);
		}
		return text;
	}

	/**
	 * Checks if a name is a Python built-in function or common global.
	 */
	private isBuiltinName(name: string): boolean {
		return PYTHON_BUILTINS.has(name);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Python built-in names (excluded from call extraction)
// ─────────────────────────────────────────────────────────────────────────────

const PYTHON_BUILTINS = new Set([
	// Built-in functions
	"abs",
	"aiter",
	"all",
	"anext",
	"any",
	"ascii",
	"bin",
	"bool",
	"breakpoint",
	"bytearray",
	"bytes",
	"callable",
	"chr",
	"classmethod",
	"compile",
	"complex",
	"delattr",
	"dict",
	"dir",
	"divmod",
	"enumerate",
	"eval",
	"exec",
	"filter",
	"float",
	"format",
	"frozenset",
	"getattr",
	"globals",
	"hasattr",
	"hash",
	"help",
	"hex",
	"id",
	"input",
	"int",
	"isinstance",
	"issubclass",
	"iter",
	"len",
	"list",
	"locals",
	"map",
	"max",
	"memoryview",
	"min",
	"next",
	"object",
	"oct",
	"open",
	"ord",
	"pow",
	"print",
	"property",
	"range",
	"repr",
	"reversed",
	"round",
	"set",
	"setattr",
	"slice",
	"sorted",
	"staticmethod",
	"str",
	"sum",
	"super",
	"tuple",
	"type",
	"vars",
	"zip",
	// Common typing-related calls
	"Optional",
	"Union",
	"List",
	"Dict",
	"Tuple",
	"Set",
	"FrozenSet",
	"Callable",
	"Type",
	"Any",
	"TypeVar",
	"Generic",
	"Protocol",
	"NamedTuple",
	"TypedDict",
	"Final",
	"Literal",
	"ClassVar",
	"Annotated",
	// Exception types (commonly instantiated, not function calls)
	"Exception",
	"ValueError",
	"TypeError",
	"KeyError",
	"IndexError",
	"AttributeError",
	"RuntimeError",
	"NotImplementedError",
	"StopIteration",
	"OSError",
	"IOError",
	"FileNotFoundError",
	"ImportError",
	"ModuleNotFoundError",
	"PermissionError",
	"AssertionError",
]);
