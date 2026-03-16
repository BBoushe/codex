/**
 * @fileoverview TypeScript/JavaScript AST visitor.
 *
 * Handles `.ts`, `.tsx`, `.js`, `.jsx` files. Extracts: Functions, Components,
 * Classes, Hooks, Props, and their relationships from a Tree-sitter parse tree.
 *
 * This is a **Pass 1** visitor — it produces fully resolved intra-file
 * relationships and unresolved cross-file references (imports, external calls,
 * rendered components). A separate linker (Pass 2) resolves cross-file
 * references after all files have been visited.
 *
 * ## Scope
 * Only **top-level declarations** are extracted as graph entities. Nested
 * functions (e.g. event handlers inside a component) are part of their
 * parent's `sourceCode` but don't become separate nodes. This keeps the
 * graph navigable without drowning in implementation-detail nodes.
 *
 * ## Component Detection Heuristic
 * A function is classified as a `ComponentNode` when BOTH conditions hold:
 *   1. Its name is PascalCase (`/^[A-Z]/`)
 *   2. Its body contains JSX (`jsx_element`, `jsx_self_closing_element`, or `jsx_fragment`)
 *
 * This catches arrow components, function components, `React.memo()`, and
 * `React.forwardRef()`. The false-positive rate is negligible in practice.
 */

import type { Node } from "web-tree-sitter";
import {
	NodeLabel,
	EdgeType,
	type FileNode,
	type FunctionNode,
	type ClassNode,
	type ComponentNode,
	type HookNode,
	type PropNode,
	type CallsEdge,
	type UsesHookEdge,
} from "@codex/shared";
import {
	nodeIdForFile,
	nodeIdForFunction,
	nodeIdForClass,
	nodeIdForComponent,
	nodeIdForHook,
	nodeIdForProp,
} from "@codex/shared";
import { languageFromExtension } from "../languageService";
import type { Tree } from "../languageService";
import type { SourceFile } from "../fileWalker";
import type {
	Visitor,
	VisitorFileResult,
	UnresolvedReference,
	ImportedName,
	PassedPropInfo,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Built-in React hook names mapped to the schema's hookType enum values. */
const KNOWN_HOOKS: Record<string, HookNode["hookType"]> = {
	useState: "useState",
	useEffect: "useEffect",
	useMemo: "useMemo",
	useCallback: "useCallback",
	useRef: "useRef",
	useContext: "useContext",
	useReducer: "useReducer",
};

/**
 * Standard HTML and SVG element names. Used to distinguish `<div>` (HTML)
 * from `<UserCard>` (component) in JSX.
 */
const HTML_TAGS = new Set([
	// HTML
	"a",
	"abbr",
	"address",
	"area",
	"article",
	"aside",
	"audio",
	"b",
	"base",
	"bdi",
	"bdo",
	"blockquote",
	"body",
	"br",
	"button",
	"canvas",
	"caption",
	"cite",
	"code",
	"col",
	"colgroup",
	"data",
	"datalist",
	"dd",
	"del",
	"details",
	"dfn",
	"dialog",
	"div",
	"dl",
	"dt",
	"em",
	"embed",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"header",
	"hgroup",
	"hr",
	"html",
	"i",
	"iframe",
	"img",
	"input",
	"ins",
	"kbd",
	"label",
	"legend",
	"li",
	"link",
	"main",
	"map",
	"mark",
	"menu",
	"meta",
	"meter",
	"nav",
	"noscript",
	"object",
	"ol",
	"optgroup",
	"option",
	"output",
	"p",
	"param",
	"picture",
	"pre",
	"progress",
	"q",
	"rp",
	"rt",
	"ruby",
	"s",
	"samp",
	"script",
	"section",
	"select",
	"slot",
	"small",
	"source",
	"span",
	"strong",
	"style",
	"sub",
	"summary",
	"sup",
	"table",
	"tbody",
	"td",
	"template",
	"textarea",
	"tfoot",
	"th",
	"thead",
	"time",
	"title",
	"tr",
	"track",
	"u",
	"ul",
	"var",
	"video",
	"wbr",
	// SVG
	"svg",
	"circle",
	"clipPath",
	"defs",
	"ellipse",
	"g",
	"image",
	"line",
	"linearGradient",
	"mask",
	"path",
	"pattern",
	"polygon",
	"polyline",
	"radialGradient",
	"rect",
	"stop",
	"text",
	"tspan",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Pure helper functions
// ─────────────────────────────────────────────────────────────────────────────

function isPascalCase(name: string): boolean {
	return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

function isHookName(name: string): boolean {
	return /^use[A-Z]/.test(name);
}

/**
 * Deep check for JSX descendants. Uses Tree-sitter's optimised
 * `descendantsOfType` rather than manual recursion.
 */
function containsJSX(node: Node): boolean {
	return (
		node.descendantsOfType([
			"jsx_element",
			"jsx_self_closing_element",
			"jsx_fragment",
		]).length > 0
	);
}

/** Simple LOC: endRow − startRow + 1 (includes blanks and comments). */
function nodeLoc(node: Node): number {
	return node.endPosition.row - node.startPosition.row + 1;
}

/**
 * Extracts human-readable parameter strings from `formal_parameters`.
 *
 * CST structure:
 * ```
 * formal_parameters
 *   required_parameter "first: string"
 *   optional_parameter "last?: string"
 * ```
 */
function extractParameters(paramsNode: Node): string[] {
	const params: string[] = [];
	for (const child of paramsNode.namedChildren) {
		if (
			child.type === "required_parameter" ||
			child.type === "optional_parameter"
		) {
			params.push(child.text);
		}
	}
	return params;
}

/**
 * Extracts the return type annotation string from a function node.
 *
 * For `function foo(): string { ... }`, walks siblings after
 * `formal_parameters` to find the `type_annotation` node.
 * Returns `null` for untyped functions.
 */
function extractReturnType(fnNode: Node): string | null {
	const params = fnNode.children.find((c) => c.type === "formal_parameters");
	if (!params) return null;

	let sibling = params.nextNamedSibling;
	while (sibling) {
		if (sibling.type === "type_annotation") {
			const text = sibling.text;
			return text.startsWith(":") ? text.slice(1).trim() : text;
		}
		// Once we hit the function body we've gone past the return type
		if (
			sibling.type === "statement_block" ||
			sibling.type === "jsx_element" ||
			sibling.type === "jsx_self_closing_element" ||
			sibling.type === "jsx_fragment"
		) {
			break;
		}
		sibling = sibling.nextNamedSibling;
	}
	return null;
}

/**
 * Checks whether a function/arrow-function node has the `async` keyword.
 *
 * In the Tree-sitter CST, `async` appears as an unnamed (anonymous) child
 * node before the `function` keyword or parameters.
 */
function isAsyncNode(node: Node): boolean {
	for (const child of node.children) {
		if (child.type === "async") return true;
		// Stop once we've passed the leading keywords
		if (child.isNamed) break;
	}
	return false;
}

/**
 * Returns the body node of a function — either a `statement_block`
 * or a direct expression (for concise arrow functions like `() => <div/>`).
 */
function getFunctionBody(node: Node): Node | null {
	if (node.type === "arrow_function") {
		// Arrow body is the last named child that isn't params or type_annotation
		const children = node.namedChildren;
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i]!;
			if (
				child.type !== "formal_parameters" &&
				child.type !== "type_annotation" &&
				child.type !== "type_parameters"
			) {
				return child;
			}
		}
		return null;
	}
	// function_declaration / function_expression: body is a statement_block
	return node.children.find((c) => c.type === "statement_block") ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visit context — accumulates results within a single file visit
// ─────────────────────────────────────────────────────────────────────────────

/** Prop metadata extracted from an interface or type alias declaration. */
interface TypePropInfo {
	isOptional: boolean;
	/** Type annotation text, e.g. "string", "(id: string) => void" */
	propType: string | null;
}

/**
 * Per-file map of type/interface names to their property definitions.
 * e.g. `"UserCardProps" → Map{ "userId" → { isOptional: false, propType: "string" } }`
 */
type TypeRegistry = Map<string, Map<string, TypePropInfo>>;

interface VisitContext {
	/** Relative file path (used for nodeId generation and graph storage). */
	filePath: string;
	/** nodeId of the current file's FileNode. */
	fileNodeId: string;
	/** Accumulated entity nodes. */
	entities: {
		node:
			| FileNode
			| FunctionNode
			| ClassNode
			| ComponentNode
			| HookNode
			| PropNode;
	}[];
	/** Accumulated intra-file relationships. */
	relationships: {
		sourceId: string;
		targetId: string;
		edge: { type: EdgeType } & Record<string, unknown>;
	}[];
	/** Accumulated cross-file references for the linker. */
	unresolvedRefs: UnresolvedReference[];
	/** Interface/type declarations found in this file, used to enrich prop metadata. */
	typeRegistry: TypeRegistry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visitor implementation
// ─────────────────────────────────────────────────────────────────────────────

export class TypeScriptVisitor implements Visitor {
	visit(tree: Tree, sourceCode: string, file: SourceFile): VisitorFileResult {
		const filePath = file.relativePath;
		const fileNodeId = nodeIdForFile(filePath);

		const ctx: VisitContext = {
			filePath,
			fileNodeId,
			entities: [],
			relationships: [],
			unresolvedRefs: [],
			typeRegistry: new Map(),
		};

		// ── FileNode ────────────────────────────────────────────────────
		const fileNode: FileNode = {
			label: NodeLabel.File,
			nodeId: fileNodeId,
			name: filePath.split("/").pop() ?? filePath,
			qualifiedName: filePath,
			filePath,
			language: languageFromExtension(file.extension),
			loc: tree.rootNode.endPosition.row + 1,
			extension: file.extension,
		};

		// ── Pre-pass: extract interface/type declarations ───────────────
		// Done first so they're available when processing components.
		for (const child of tree.rootNode.children) {
			try {
				this.extractTypeDeclaration(child, ctx);
			} catch {
				// Non-critical — skip silently
			}
		}

		// ── Walk top-level statements ───────────────────────────────────
		for (const child of tree.rootNode.children) {
			try {
				this.processTopLevel(child, ctx, false);
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
		};
	}

	// ── Top-level dispatch ──────────────────────────────────────────────

	private processTopLevel(
		node: Node,
		ctx: VisitContext,
		isExported: boolean,
	): void {
		switch (node.type) {
			case "export_statement":
				this.handleExportStatement(node, ctx);
				break;
			case "import_statement":
				this.handleImportStatement(node, ctx);
				break;
			case "function_declaration":
				this.handleFunctionDeclaration(node, ctx, isExported);
				break;
			case "lexical_declaration":
				this.handleLexicalDeclaration(node, ctx, isExported);
				break;
			case "class_declaration":
				this.handleClassDeclaration(node, ctx, isExported);
				break;
			// interface_declaration, type_alias_declaration, expression_statement
			// are intentionally skipped — they don't produce graph entities in v1.
		}
	}

	// ── Export statements ────────────────────────────────────────────────

	/**
	 * Unwraps `export [default] <declaration>` and delegates to the
	 * appropriate handler with `isExported = true`.
	 *
	 * CST shape:
	 * ```
	 * export_statement
	 *   function_declaration | class_declaration | lexical_declaration
	 * ```
	 */
	private handleExportStatement(node: Node, ctx: VisitContext): void {
		for (const child of node.namedChildren) {
			if (
				child.type === "function_declaration" ||
				child.type === "class_declaration" ||
				child.type === "lexical_declaration"
			) {
				this.processTopLevel(child, ctx, true);
				return;
			}
		}
		// Re-export statements (`export { X } from './bar'`) and bare
		// `export default <expr>` are skipped in v1.
	}

	// ── Type/Interface extraction ───────────────────────────────────────

	/**
	 * Extracts interface and type alias declarations into the type registry.
	 *
	 * Handles:
	 * - `interface Foo { ... }`
	 * - `type Foo = { ... }`
	 * - `export interface Foo { ... }` (unwraps export_statement)
	 *
	 * CST for interface:
	 * ```
	 * interface_declaration
	 *   type_identifier "UserCardProps"
	 *   interface_body
	 *     property_signature "userId: string"
	 *       property_identifier "userId"
	 *       type_annotation ": string"
	 *     property_signature "onSelect?: ..."
	 *       property_identifier "onSelect"
	 *       "?"                             ← unnamed node, marks optional
	 *       type_annotation ": ..."
	 * ```
	 *
	 * CST for type alias with object type:
	 * ```
	 * type_alias_declaration
	 *   type_identifier "ButtonProps"
	 *   object_type                         ← same structure as interface_body
	 *     property_signature ...
	 * ```
	 */
	private extractTypeDeclaration(node: Node, ctx: VisitContext): void {
		// Unwrap export statements
		if (node.type === "export_statement") {
			for (const child of node.namedChildren) {
				this.extractTypeDeclaration(child, ctx);
			}
			return;
		}

		if (node.type === "interface_declaration") {
			const nameNode = node.children.find((c) => c.type === "type_identifier");
			const body = node.children.find((c) => c.type === "interface_body");
			if (nameNode && body) {
				ctx.typeRegistry.set(
					nameNode.text,
					this.extractPropertySignatures(body),
				);
			}
			return;
		}

		if (node.type === "type_alias_declaration") {
			const nameNode = node.children.find((c) => c.type === "type_identifier");
			const objectType = node.children.find((c) => c.type === "object_type");
			if (nameNode && objectType) {
				ctx.typeRegistry.set(
					nameNode.text,
					this.extractPropertySignatures(objectType),
				);
			}
		}
	}

	/**
	 * Extracts property names, optionality, and types from an
	 * `interface_body` or `object_type` node.
	 *
	 * Optionality is detected by the presence of an unnamed `"?"` child
	 * node in the `property_signature`. The type is extracted from the
	 * `type_annotation` child (stripping the leading `:`).
	 */
	private extractPropertySignatures(bodyNode: Node): Map<string, TypePropInfo> {
		const props = new Map<string, TypePropInfo>();

		for (const member of bodyNode.namedChildren) {
			if (member.type !== "property_signature") continue;

			const nameNode = member.children.find(
				(c) => c.type === "property_identifier",
			);
			if (!nameNode) continue;

			// Check for `?` — it's an unnamed child node with type "?"
			const isOptional = member.children.some(
				(c) => !c.isNamed && c.type === "?",
			);

			// Extract type annotation text
			const typeAnnotation = member.children.find(
				(c) => c.type === "type_annotation",
			);
			let propType: string | null = null;
			if (typeAnnotation) {
				const text = typeAnnotation.text;
				// Strip leading ": " from ": string" → "string"
				propType = text.startsWith(":") ? text.slice(1).trim() : text;
			}

			props.set(nameNode.text, { isOptional, propType });
		}

		return props;
	}

	// ── Import statements ───────────────────────────────────────────────

	/**
	 * Parses an import statement into an `UnresolvedImport`.
	 *
	 * CST shape (combined example):
	 * ```
	 * import_statement
	 *   import_clause
	 *     identifier "React"                  ← default import
	 *     named_imports "{ useState }"        ← named imports
	 *       import_specifier
	 *         identifier "useState"
	 *   string "'react'"
	 *     string_fragment "react"
	 * ```
	 *
	 * Also handles namespace imports: `import * as Foo from "bar"`
	 */
	private handleImportStatement(node: Node, ctx: VisitContext): void {
		const importClause = node.children.find((c) => c.type === "import_clause");
		const sourceNode = node.children.find((c) => c.type === "string");
		if (!sourceNode) return;

		const specifier =
			sourceNode.children.find((c) => c.type === "string_fragment")?.text ??
			sourceNode.text.slice(1, -1);

		const importedNames: ImportedName[] = [];
		let isNamespaceImport = false;
		let hasDefaultImport = false;
		let defaultOrNamespaceName: string | null = null;

		if (importClause) {
			for (const child of importClause.namedChildren) {
				if (child.type === "identifier") {
					hasDefaultImport = true;
					defaultOrNamespaceName = child.text;
				} else if (child.type === "named_imports") {
					for (const spec of child.namedChildren) {
						if (spec.type !== "import_specifier") continue;
						const ids = spec.namedChildren.filter(
							(c) => c.type === "identifier",
						);
						const name = ids[0]?.text;
						// Two identifiers means `import { X as Y }` — second is alias
						const alias = ids.length > 1 ? (ids[1]?.text ?? null) : null;
						if (name) importedNames.push({ name, alias });
					}
				} else if (child.type === "namespace_import") {
					isNamespaceImport = true;
					const ident = child.namedChildren.find(
						(c) => c.type === "identifier",
					);
					defaultOrNamespaceName = ident?.text ?? null;
				}
			}
		}

		ctx.unresolvedRefs.push({
			kind: "import",
			sourceFileRelPath: ctx.filePath,
			specifier,
			importedNames,
			isNamespaceImport,
			hasDefaultImport,
			defaultOrNamespaceName,
		});
	}

	// ── Function declarations ───────────────────────────────────────────

	/**
	 * Handles `function Foo(...) { ... }`.
	 *
	 * If the function is PascalCase and contains JSX → ComponentNode.
	 * Otherwise → FunctionNode.
	 */
	private handleFunctionDeclaration(
		node: Node,
		ctx: VisitContext,
		isExported: boolean,
	): void {
		const nameNode = node.children.find((c) => c.type === "identifier");
		if (!nameNode) return;

		const name = nameNode.text;
		const params = node.children.find((c) => c.type === "formal_parameters");
		const body = getFunctionBody(node);
		const isComponent =
			isPascalCase(name) && body !== null && containsJSX(body);

		if (isComponent) {
			this.createComponent(
				node,
				name,
				"function",
				params ?? null,
				body!,
				ctx,
				isExported,
			);
		} else {
			this.createFunction(node, name, params ?? null, ctx, isExported);
		}
	}

	// ── Lexical declarations (arrow functions, React wrappers) ──────────

	/**
	 * Handles `const Foo = () => { ... }` and `const Foo = React.memo(...)`.
	 *
	 * CST shape:
	 * ```
	 * lexical_declaration
	 *   variable_declarator
	 *     identifier "Foo"
	 *     [type_annotation]
	 *     arrow_function | call_expression
	 * ```
	 */
	private handleLexicalDeclaration(
		node: Node,
		ctx: VisitContext,
		isExported: boolean,
	): void {
		for (const declarator of node.namedChildren) {
			if (declarator.type !== "variable_declarator") continue;

			const nameNode = declarator.children.find((c) => c.type === "identifier");
			if (!nameNode) continue;

			const name = nameNode.text;
			const initializer = this.getInitializer(declarator);
			if (!initializer) continue;

			// Try to extract props type from `React.FC<Props>` annotation
			const fcTypeName = this.resolvePropsTypeNameFromDeclarator(declarator);

			if (initializer.type === "arrow_function") {
				this.handleArrowFunction(
					initializer,
					name,
					ctx,
					isExported,
					fcTypeName,
				);
			} else if (initializer.type === "call_expression") {
				this.handlePossibleReactWrapper(
					initializer,
					name,
					ctx,
					isExported,
					fcTypeName,
				);
			}
		}
	}

	/**
	 * Processes an arrow function, determining if it's a component or function.
	 *
	 * The concise arrow body case (no statement_block):
	 * ```
	 * const Foo = ({ msg }) => <p>{msg}</p>;
	 * ```
	 * Here the body node IS the `jsx_element` directly.
	 */
	private handleArrowFunction(
		arrowNode: Node,
		name: string,
		ctx: VisitContext,
		isExported: boolean,
		propsTypeName?: string | null,
	): void {
		const params = arrowNode.children.find(
			(c) => c.type === "formal_parameters",
		);
		const body = getFunctionBody(arrowNode);
		const isComponent =
			isPascalCase(name) && body !== null && containsJSX(body);

		if (isComponent) {
			this.createComponent(
				arrowNode,
				name,
				"arrow",
				params ?? null,
				body!,
				ctx,
				isExported,
				propsTypeName,
			);
		} else {
			this.createFunction(arrowNode, name, params ?? null, ctx, isExported);
		}
	}

	/**
	 * Handles `React.memo(...)` and `React.forwardRef(...)` wrapper patterns.
	 *
	 * CST shape for `const X = React.memo((...) => { ... })`:
	 * ```
	 * call_expression
	 *   member_expression
	 *     identifier "React"
	 *     property_identifier "memo"
	 *   arguments
	 *     arrow_function   ← the actual component function
	 * ```
	 */
	private handlePossibleReactWrapper(
		callNode: Node,
		name: string,
		ctx: VisitContext,
		isExported: boolean,
		propsTypeName?: string | null,
	): void {
		const callee = callNode.children.find(
			(c) => c.type === "member_expression",
		);
		if (!callee) return;

		const obj = callee.children.find((c) => c.type === "identifier");
		const prop = callee.children.find((c) => c.type === "property_identifier");
		if (!obj || !prop || obj.text !== "React") return;

		const wrapperKind: ComponentNode["componentKind"] | null =
			prop.text === "memo"
				? "memo"
				: prop.text === "forwardRef"
					? "forwardRef"
					: null;
		if (!wrapperKind) return;

		const args = callNode.children.find((c) => c.type === "arguments");
		if (!args) return;

		const componentFn = args.namedChildren.find(
			(c) => c.type === "arrow_function" || c.type === "function_expression",
		);
		if (!componentFn) return;

		const params = componentFn.children.find(
			(c) => c.type === "formal_parameters",
		);
		const body = getFunctionBody(componentFn);

		if (body) {
			this.createComponent(
				componentFn,
				name,
				wrapperKind,
				params ?? null,
				body,
				ctx,
				isExported,
				propsTypeName,
			);
		}
	}

	// ── Class declarations ──────────────────────────────────────────────

	/**
	 * CST shape:
	 * ```
	 * class_declaration
	 *   type_identifier "UserService"
	 *   class_heritage                    ← optional
	 *     extends_clause
	 *       member_expression "React.Component"
	 *   class_body
	 *     method_definition
	 *       property_identifier "getUser"
	 *       formal_parameters
	 *       statement_block
	 *     public_field_definition         ← class fields
	 * ```
	 */
	private handleClassDeclaration(
		node: Node,
		ctx: VisitContext,
		isExported: boolean,
	): void {
		const nameNode = node.children.find((c) => c.type === "type_identifier");
		if (!nameNode) return;

		const name = nameNode.text;
		const nodeId = nodeIdForClass(ctx.filePath, name);

		// ── Parent class ────────────────────────────────────────────
		let parentClass: string | null = null;
		const heritage = node.children.find((c) => c.type === "class_heritage");
		if (heritage) {
			const extendsClause = heritage.children.find(
				(c) => c.type === "extends_clause",
			);
			if (extendsClause) {
				const target = extendsClause.namedChildren.find(
					(c) => c.type === "identifier" || c.type === "member_expression",
				);
				parentClass = target?.text ?? null;
			}
		}

		// ── Methods ─────────────────────────────────────────────────
		const classBody = node.children.find((c) => c.type === "class_body");
		const methods: string[] = [];
		if (classBody) {
			for (const member of classBody.namedChildren) {
				if (member.type === "method_definition") {
					const methodName = member.children.find(
						(c) => c.type === "property_identifier",
					);
					if (methodName) methods.push(methodName.text);
				}
			}
		}

		// ── Interfaces (implements clause) ──────────────────────────
		const interfaces: string[] = [];
		if (heritage) {
			const implClause = heritage.children.find(
				(c) => c.type === "implements_clause",
			);
			if (implClause) {
				for (const child of implClause.namedChildren) {
					if (
						child.type === "type_identifier" ||
						child.type === "generic_type"
					) {
						interfaces.push(child.text);
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
			isAbstract: node.children.some((c) => c.type === "abstract"),
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

		// Extract calls from all method bodies
		if (classBody) {
			for (const member of classBody.namedChildren) {
				if (member.type === "method_definition") {
					const body = member.children.find(
						(c) => c.type === "statement_block",
					);
					const methodParams = member.children.find(
						(c) => c.type === "formal_parameters",
					);
					const paramNames = methodParams
						? this.extractParameterNames(methodParams)
						: new Set<string>();
					if (body) this.extractCalls(body, nodeId, ctx, paramNames);
				}
			}
		}
	}

	// ── Entity creation helpers ─────────────────────────────────────────

	private createFunction(
		fnNode: Node,
		name: string,
		paramsNode: Node | null,
		ctx: VisitContext,
		isExported: boolean,
	): void {
		const nodeId = nodeIdForFunction(ctx.filePath, name);

		const funcNode: FunctionNode = {
			label: NodeLabel.Function,
			nodeId,
			name,
			qualifiedName: `${ctx.filePath}::${name}`,
			filePath: ctx.filePath,
			startLine: fnNode.startPosition.row + 1,
			endLine: fnNode.endPosition.row + 1,
			loc: nodeLoc(fnNode),
			parameters: paramsNode ? extractParameters(paramsNode) : [],
			returnType: extractReturnType(fnNode),
			isExported,
			isAsync: isAsyncNode(fnNode),
			sourceCode: fnNode.text,
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

		// Extract calls from function body, excluding parameter names
		const body = getFunctionBody(fnNode);
		if (body) {
			const paramNames = paramsNode
				? this.extractParameterNames(paramsNode)
				: new Set<string>();
			this.extractCalls(body, nodeId, ctx, paramNames);
		}
	}

	private createComponent(
		fnNode: Node,
		name: string,
		kind: ComponentNode["componentKind"],
		paramsNode: Node | null,
		body: Node,
		ctx: VisitContext,
		isExported: boolean,
		propsTypeName?: string | null,
	): void {
		const nodeId = nodeIdForComponent(ctx.filePath, name);
		const propNames = paramsNode ? this.extractPropNames(paramsNode) : [];

		const compNode: ComponentNode = {
			label: NodeLabel.Component,
			nodeId,
			name,
			qualifiedName: `${ctx.filePath}::${name}`,
			filePath: ctx.filePath,
			startLine: fnNode.startPosition.row + 1,
			endLine: fnNode.endPosition.row + 1,
			loc: nodeLoc(fnNode),
			isExported,
			componentKind: kind,
			props: propNames,
			sourceCode: fnNode.text,
		};

		ctx.entities.push({ node: compNode });

		// DEFINED_IN: Component → File
		ctx.relationships.push({
			sourceId: nodeId,
			targetId: ctx.fileNodeId,
			edge: { type: EdgeType.DEFINED_IN },
		});

		// EXPORTS: File → Component
		if (isExported) {
			ctx.relationships.push({
				sourceId: ctx.fileNodeId,
				targetId: nodeId,
				edge: { type: EdgeType.EXPORTS },
			});
		}

		// ── Component internals ─────────────────────────────────────
		this.extractHooks(body, name, nodeId, ctx);

		// Resolve the props type name for enriching PropNodes
		const resolvedTypeName =
			propsTypeName ?? this.resolvePropsTypeName(paramsNode);
		const typeInfo = resolvedTypeName
			? (ctx.typeRegistry.get(resolvedTypeName) ?? null)
			: null;

		this.extractProps(paramsNode, name, nodeId, ctx, typeInfo);
		this.extractJSXRenders(body, nodeId, ctx);
		const paramExcludes = paramsNode
			? this.extractParameterNames(paramsNode)
			: new Set<string>();
		this.extractCalls(body, nodeId, ctx, paramExcludes);
	}

	// ── Hook extraction ─────────────────────────────────────────────────

	/**
	 * Extracts React hook calls from a component's body.
	 *
	 * Only inspects **direct children** of the statement_block to respect
	 * React's rules of hooks (hooks must be at the top level of the function,
	 * not inside callbacks or conditionals).
	 */
	private extractHooks(
		body: Node,
		componentName: string,
		componentNodeId: string,
		ctx: VisitContext,
	): void {
		if (body.type !== "statement_block") return;

		for (const statement of body.namedChildren) {
			this.findHookInStatement(statement, componentName, componentNodeId, ctx);
		}
	}

	private findHookInStatement(
		statement: Node,
		componentName: string,
		componentNodeId: string,
		ctx: VisitContext,
	): void {
		// Pattern 1: `useEffect(() => { ... }, [dep]);`
		if (statement.type === "expression_statement") {
			const expr = statement.namedChildren[0];
			if (expr?.type === "call_expression") {
				this.tryExtractHook(expr, null, componentName, componentNodeId, ctx);
			}
			return;
		}

		// Pattern 2: `const [count, setCount] = useState(0);`
		//         or: `const memoized = useMemo(() => ..., []);`
		if (statement.type === "lexical_declaration") {
			for (const declarator of statement.namedChildren) {
				if (declarator.type !== "variable_declarator") continue;

				const init = this.getInitializer(declarator);
				if (init?.type !== "call_expression") continue;

				// Binding is an array_pattern or identifier before the initializer
				const bindingNode = declarator.children.find(
					(c) => c.type === "array_pattern" || c.type === "identifier",
				);

				this.tryExtractHook(
					init,
					bindingNode ?? null,
					componentName,
					componentNodeId,
					ctx,
				);
			}
		}
	}

	/**
	 * Checks if a `call_expression` is a hook call and, if so,
	 * creates a `HookNode` and a `USES_HOOK` edge.
	 */
	private tryExtractHook(
		callNode: Node,
		bindingNode: Node | null,
		componentName: string,
		componentNodeId: string,
		ctx: VisitContext,
	): void {
		const callee = callNode.children.find((c) => c.type === "identifier");
		if (!callee || !isHookName(callee.text)) return;

		const hookName = callee.text;
		const hookType: HookNode["hookType"] = KNOWN_HOOKS[hookName] ?? "custom";
		const callSiteLine = callNode.startPosition.row + 1;
		const nodeId = nodeIdForHook(ctx.filePath, componentName, callSiteLine);

		// ── Return bindings ─────────────────────────────────────────
		const returnBindings: string[] = [];
		if (bindingNode) {
			if (bindingNode.type === "array_pattern") {
				// const [x, y] = useHook(...)
				for (const child of bindingNode.namedChildren) {
					if (child.type === "identifier") {
						returnBindings.push(child.text);
					}
				}
			} else if (bindingNode.type === "identifier") {
				// const x = useHook(...)
				returnBindings.push(bindingNode.text);
			}
		}

		// ── Arguments as source text ────────────────────────────────
		const argsNode = callNode.children.find((c) => c.type === "arguments");
		const hookArguments: string[] = [];
		if (argsNode) {
			for (const arg of argsNode.namedChildren) {
				hookArguments.push(arg.text);
			}
		}

		// ── Dependencies (last array argument) ──────────────────────
		let dependencies: string[] | null = null;
		if (argsNode && argsNode.namedChildren.length >= 2) {
			const lastArg = argsNode.namedChildren[argsNode.namedChildren.length - 1];
			if (lastArg?.type === "array") {
				dependencies = lastArg.namedChildren.map((d) => d.text);
			}
		}

		const hookNode: HookNode = {
			label: NodeLabel.Hook,
			nodeId,
			name: hookName,
			qualifiedName: `${ctx.filePath}::${componentName}.${hookName}:L${callSiteLine}`,
			filePath: ctx.filePath,
			startLine: callSiteLine,
			hookType,
			dependencies,
			returnBindings,
			arguments: hookArguments,
		};

		ctx.entities.push({ node: hookNode });

		// USES_HOOK: Component → Hook
		const usesHookEdge: UsesHookEdge = {
			type: EdgeType.USES_HOOK,
			callSiteLine,
		};
		ctx.relationships.push({
			sourceId: componentNodeId,
			targetId: nodeId,
			edge: usesHookEdge,
		});
	}

	// ── Call extraction ─────────────────────────────────────────────────

	/**
	 * Extracts function calls from a body node as `UnresolvedCall` references.
	 *
	 * Only direct identifier calls (`fetchUser()`) are captured — member
	 * expression calls (`obj.method()`) are skipped because they can't be
	 * resolved to graph entities without type information.
	 *
	 * Hook calls are skipped here (handled by `extractHooks`).
	 *
	 * @param excludeNames - Parameter/prop names of the enclosing function.
	 *   These are callback invocations (e.g. `onSelect()` where `onSelect`
	 *   is a prop), not calls to standalone functions in the graph.
	 */
	private extractCalls(
		body: Node,
		callerNodeId: string,
		ctx: VisitContext,
		excludeNames?: Set<string>,
	): void {
		const callExprs = body.descendantsOfType("call_expression");

		for (const call of callExprs) {
			const callee = call.children[0];
			if (!callee || callee.type !== "identifier") continue;

			const name = callee.text;

			// Skip hook calls — they're extracted separately with richer data
			if (isHookName(name)) continue;
			// Skip module-system builtins
			if (name === "require" || name === "import") continue;
			// Skip callback parameters (props, function args)
			if (excludeNames?.has(name)) continue;

			ctx.unresolvedRefs.push({
				kind: "call",
				callerNodeId,
				calleeName: name,
				callSiteLine: call.startPosition.row + 1,
				callSiteFile: ctx.filePath,
			});
		}
	}

	// ── JSX render extraction ───────────────────────────────────────────

	/**
	 * Extracts RENDERS references from JSX in a component body.
	 *
	 * A JSX tag is treated as a component reference if its name is PascalCase
	 * and not in the HTML_TAGS set. Member expressions (`React.Fragment`,
	 * `ThemeContext.Provider`) are skipped — they don't map to simple
	 * component names in the graph.
	 *
	 * Produces one `UnresolvedRender` per unique component name, with
	 * `passedProps` aggregated across **all** JSX usages of that component
	 * in this parent. Props are deduplicated by name — if the same prop
	 * appears in multiple usages, the first occurrence's `passKind` is kept.
	 *
	 * This matters for reusable components rendered multiple times with
	 * different configurations:
	 * ```tsx
	 * <UserCard userId={selectedId} onSelect={handler} />
	 * <UserCard userId="2" />
	 * ```
	 * → passedProps: [userId (variable), onSelect (variable)]
	 *   (captures that onSelect IS passed, even though the second usage omits it)
	 */
	private extractJSXRenders(
		body: Node,
		rendererNodeId: string,
		ctx: VisitContext,
	): void {
		const jsxElements = [
			...body.descendantsOfType("jsx_opening_element"),
			...body.descendantsOfType("jsx_self_closing_element"),
		];

		// componentName → Map<propName, PassedPropInfo>
		const aggregated = new Map<string, Map<string, PassedPropInfo>>();

		for (const elem of jsxElements) {
			const tagNode = elem.children.find(
				(c) => c.type === "identifier" || c.type === "member_expression",
			);
			if (!tagNode) continue;

			const tagName = tagNode.text;

			// Skip HTML/SVG tags, member expressions, and non-PascalCase
			if (HTML_TAGS.has(tagName)) continue;
			if (tagName.includes(".")) continue;
			if (!isPascalCase(tagName)) continue;

			const passedProps = this.extractPassedProps(elem);

			let propMap = aggregated.get(tagName);
			if (!propMap) {
				propMap = new Map<string, PassedPropInfo>();
				aggregated.set(tagName, propMap);
			}

			for (const prop of passedProps) {
				// First occurrence of each prop name wins (keeps its passKind)
				if (!propMap.has(prop.name)) {
					propMap.set(prop.name, prop);
				}
			}
		}

		// Emit one UnresolvedRender per unique component with all aggregated props
		for (const [componentName, propMap] of aggregated) {
			ctx.unresolvedRefs.push({
				kind: "render",
				rendererNodeId,
				componentName,
				passedProps: [...propMap.values()],
			});
		}
	}

	/**
	 * Extracts prop information from JSX attributes on an element.
	 *
	 * CST shapes:
	 * ```
	 * jsx_attribute "title={value}"
	 *   property_identifier "title"
	 *   jsx_expression "{value}"
	 *     identifier "value"           ← passKind: "variable"
	 *
	 * jsx_attribute "name="literal""
	 *   property_identifier "name"
	 *   string ""literal""             ← passKind: "literal"
	 *
	 * jsx_expression "{...props}"      ← spread (direct child of element)
	 *   spread_element "...props"
	 * ```
	 */
	private extractPassedProps(jsxElement: Node): PassedPropInfo[] {
		const props: PassedPropInfo[] = [];

		for (const child of jsxElement.namedChildren) {
			if (child.type === "jsx_attribute") {
				const nameNode = child.children.find(
					(c) => c.type === "property_identifier",
				);
				if (!nameNode) continue;

				const valueNode = child.children.find(
					(c) => c.type === "string" || c.type === "jsx_expression",
				);

				let passKind: PassedPropInfo["passKind"] = "expression";
				if (!valueNode) {
					// Boolean shorthand: `<Foo disabled />`
					passKind = "literal";
				} else if (valueNode.type === "string") {
					passKind = "literal";
				} else if (valueNode.type === "jsx_expression") {
					const inner = valueNode.namedChildren[0];
					if (inner?.type === "identifier") {
						passKind = "variable";
					} else {
						passKind = "expression";
					}
				}

				props.push({ name: nameNode.text, passKind });
			} else if (child.type === "jsx_expression") {
				// Spread attributes: `{...props}`
				const spread = child.namedChildren.find(
					(c) => c.type === "spread_element",
				);
				if (spread) {
					props.push({ name: "...spread", passKind: "spread" });
				}
			}
		}

		return props;
	}

	// ── Prop extraction ─────────────────────────────────────────────────

	/**
	 * Creates `PropNode` entities from a component's destructured parameters.
	 *
	 * Optionality and type info are enriched from the interface/type
	 * declaration when available. The resolution priority is:
	 *   1. Interface/type declaration (`onSelect?:` → optional)
	 *   2. Destructuring default (`title = 'Default'` → optional)
	 *   3. Default: required, no type
	 */
	private extractProps(
		paramsNode: Node | null,
		componentName: string,
		componentNodeId: string,
		ctx: VisitContext,
		typeInfo: Map<string, TypePropInfo> | null,
	): void {
		if (!paramsNode) return;

		const propInfos = this.extractPropInfos(paramsNode);

		for (const info of propInfos) {
			const nodeId = nodeIdForProp(ctx.filePath, componentName, info.name);

			// Look up type declaration info for this prop
			const typeDecl = typeInfo?.get(info.name);

			const propNode: PropNode = {
				label: NodeLabel.Prop,
				nodeId,
				name: info.name,
				qualifiedName: `${ctx.filePath}::${componentName}.${info.name}`,
				filePath: ctx.filePath,
				propType: typeDecl?.propType ?? null,
				// Optional if EITHER the interface marks it `?` OR it has a default value
				isRequired: !(typeDecl?.isOptional || info.hasDefault),
				defaultValue: info.defaultValue,
			};

			ctx.entities.push({ node: propNode });

			// ACCEPTS_PROP: Component → Prop
			ctx.relationships.push({
				sourceId: componentNodeId,
				targetId: nodeId,
				edge: { type: EdgeType.ACCEPTS_PROP },
			});
		}
	}

	/**
	 * Extracts prop names from `formal_parameters`, handling nested
	 * `object_pattern` destructuring. Rest patterns (`...rest`) are excluded.
	 */
	private extractPropNames(paramsNode: Node): string[] {
		const names: string[] = [];

		for (const param of paramsNode.namedChildren) {
			if (
				param.type !== "required_parameter" &&
				param.type !== "optional_parameter"
			) {
				continue;
			}

			const pattern = param.children.find((c) => c.type === "object_pattern");
			if (!pattern) continue;

			for (const prop of pattern.namedChildren) {
				if (prop.type === "shorthand_property_identifier_pattern") {
					names.push(prop.text);
				} else if (prop.type === "object_assignment_pattern") {
					// Prop with default: `title = 'Default'`
					const ident = prop.children.find(
						(c) => c.type === "shorthand_property_identifier_pattern",
					);
					if (ident) names.push(ident.text);
				} else if (prop.type === "pair_pattern") {
					// Renamed destructuring: `{ original: renamed }`
					const key = prop.children.find(
						(c) => c.type === "property_identifier",
					);
					if (key) names.push(key.text);
				}
				// rest_pattern (...rest) intentionally excluded
			}
		}

		return names;
	}

	// ── Props type resolution ────────────────────────────────────────────

	/**
	 * Resolves the props type name from a component's formal parameters.
	 *
	 * For `function UserCard({ userId }: UserCardProps)`, the CST has:
	 * ```
	 * formal_parameters
	 *   required_parameter
	 *     object_pattern { userId }
	 *     type_annotation ": UserCardProps"
	 *       type_identifier "UserCardProps"
	 * ```
	 *
	 * @returns The type name string (e.g. "UserCardProps"), or null if
	 *   the parameter isn't typed or uses an inline type.
	 */
	private resolvePropsTypeName(paramsNode: Node | null): string | null {
		if (!paramsNode) return null;

		for (const param of paramsNode.namedChildren) {
			if (
				param.type !== "required_parameter" &&
				param.type !== "optional_parameter"
			) {
				continue;
			}

			// Only consider params with destructured objects (props pattern)
			const hasObjectPattern = param.children.some(
				(c) => c.type === "object_pattern",
			);
			if (!hasObjectPattern) continue;

			const typeAnnotation = param.children.find(
				(c) => c.type === "type_annotation",
			);
			if (!typeAnnotation) return null;

			// Direct type reference: `: UserCardProps`
			const typeId = typeAnnotation.children.find(
				(c) => c.type === "type_identifier",
			);
			if (typeId) return typeId.text;

			// Generic type reference: `: Partial<UserCardProps>` — not supported yet
			return null;
		}

		return null;
	}

	/**
	 * Extracts the props type name from a `React.FC<Props>` or
	 * `React.FunctionComponent<Props>` type annotation on a variable declarator.
	 *
	 * CST shape for `const Foo: React.FC<UserCardProps> = (...)`:
	 * ```
	 * variable_declarator
	 *   identifier "Foo"
	 *   type_annotation ": React.FC<UserCardProps>"
	 *     generic_type
	 *       nested_type_identifier "React.FC"
	 *       type_arguments "<UserCardProps>"
	 *         type_identifier "UserCardProps"
	 * ```
	 */
	private resolvePropsTypeNameFromDeclarator(declarator: Node): string | null {
		const typeAnnotation = declarator.children.find(
			(c) => c.type === "type_annotation",
		);
		if (!typeAnnotation) return null;

		const genericType = typeAnnotation.children.find(
			(c) => c.type === "generic_type",
		);
		if (!genericType) return null;

		// Check if this is React.FC or React.FunctionComponent
		const nestedType = genericType.children.find(
			(c) => c.type === "nested_type_identifier",
		);
		if (nestedType) {
			const text = nestedType.text;
			if (text === "React.FC" || text === "React.FunctionComponent") {
				const typeArgs = genericType.children.find(
					(c) => c.type === "type_arguments",
				);
				const typeId = typeArgs?.children.find(
					(c) => c.type === "type_identifier",
				);
				return typeId?.text ?? null;
			}
		}

		// Also handle bare `FC<Props>` (imported directly)
		const typeId = genericType.children.find(
			(c) => c.type === "type_identifier",
		);
		if (
			typeId &&
			(typeId.text === "FC" || typeId.text === "FunctionComponent")
		) {
			const typeArgs = genericType.children.find(
				(c) => c.type === "type_arguments",
			);
			const propsType = typeArgs?.children.find(
				(c) => c.type === "type_identifier",
			);
			return propsType?.text ?? null;
		}

		return null;
	}

	/**
	 * Extracts structured prop info from `formal_parameters`, including
	 * whether each prop has a default value and what that value is.
	 */
	private extractPropInfos(
		paramsNode: Node,
	): Array<{ name: string; hasDefault: boolean; defaultValue: string | null }> {
		const infos: Array<{
			name: string;
			hasDefault: boolean;
			defaultValue: string | null;
		}> = [];

		for (const param of paramsNode.namedChildren) {
			if (
				param.type !== "required_parameter" &&
				param.type !== "optional_parameter"
			) {
				continue;
			}

			const pattern = param.children.find((c) => c.type === "object_pattern");
			if (!pattern) continue;

			for (const prop of pattern.namedChildren) {
				if (prop.type === "shorthand_property_identifier_pattern") {
					infos.push({
						name: prop.text,
						hasDefault: false,
						defaultValue: null,
					});
				} else if (prop.type === "object_assignment_pattern") {
					// `title = 'Default Title'` — CST structure:
					//   object_assignment_pattern
					//     shorthand_property_identifier_pattern "title"
					//     string "'Default Title'"
					const ident = prop.children.find(
						(c) => c.type === "shorthand_property_identifier_pattern",
					);
					if (!ident) continue;
					// Default value is the named child that isn't the identifier node.
					// We compare by type (not identity) because tree-sitter may return
					// different Node objects from .children vs .namedChildren.
					const defaultNode = prop.namedChildren.find(
						(c) => c.type !== "shorthand_property_identifier_pattern",
					);
					infos.push({
						name: ident.text,
						hasDefault: true,
						defaultValue: defaultNode?.text ?? null,
					});
				} else if (prop.type === "pair_pattern") {
					const key = prop.children.find(
						(c) => c.type === "property_identifier",
					);
					if (key) {
						infos.push({
							name: key.text,
							hasDefault: false,
							defaultValue: null,
						});
					}
				}
				// rest_pattern intentionally excluded
			}
		}

		return infos;
	}

	/**
	 * Extracts all parameter names from `formal_parameters` as a flat set.
	 *
	 * Handles both simple parameters (`function foo(a, b)`) and destructured
	 * object parameters (`function foo({ x, y })`). Used to exclude callback
	 * parameter invocations from being recorded as function calls.
	 *
	 * For destructured objects, extracts the individual property names
	 * (e.g. `{ onSelect, userId }` → `Set{"onSelect", "userId"}`).
	 * For simple identifiers, extracts the name directly
	 * (e.g. `(callback)` → `Set{"callback"}`).
	 */
	private extractParameterNames(paramsNode: Node): Set<string> {
		const names = new Set<string>();

		for (const param of paramsNode.namedChildren) {
			if (
				param.type !== "required_parameter" &&
				param.type !== "optional_parameter"
			) {
				continue;
			}

			// Simple parameter: `function foo(callback) { callback() }`
			const ident = param.children.find((c) => c.type === "identifier");
			if (ident) {
				names.add(ident.text);
			}

			// Destructured object parameter: `({ onSelect, userId })`
			const pattern = param.children.find((c) => c.type === "object_pattern");
			if (pattern) {
				for (const prop of pattern.namedChildren) {
					if (prop.type === "shorthand_property_identifier_pattern") {
						names.add(prop.text);
					} else if (prop.type === "object_assignment_pattern") {
						const shorthand = prop.children.find(
							(c) => c.type === "shorthand_property_identifier_pattern",
						);
						if (shorthand) names.add(shorthand.text);
					} else if (prop.type === "pair_pattern") {
						// `{ original: renamed }` — exclude the local name (renamed)
						const value = prop.children.find((c) => c.type === "identifier");
						if (value) names.add(value.text);
					}
					// rest_pattern excluded — `...rest` is unlikely to be called directly
				}
			}
		}

		return names;
	}

	// ── Utilities ───────────────────────────────────────────────────────

	/**
	 * Returns the initializer expression of a `variable_declarator`,
	 * skipping the identifier name and any type annotation.
	 *
	 * For `const x: Type = value`, returns the `value` node.
	 */
	private getInitializer(declarator: Node): Node | null {
		const children = declarator.namedChildren;
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i]!;
			if (
				child.type !== "identifier" &&
				child.type !== "type_annotation" &&
				child.type !== "type_parameters"
			) {
				return child;
			}
		}
		return null;
	}
}
