/**
 * @fileoverview Java AST visitor.
 *
 * Handles `.java` files. Extracts: Classes, Interfaces, Methods (as Functions),
 * Enums (as Classes), Annotations (as Decorators), and their relationships
 * from a Tree-sitter parse tree.
 *
 * This is a **Pass 1** visitor — it produces fully resolved intra-file
 * relationships and unresolved cross-file references (imports, external calls).
 * A separate linker (Pass 2) resolves cross-file references after all files
 * have been visited.
 *
 * ## Scope
 * Only **top-level and class-level declarations** are extracted as graph
 * entities. Anonymous inner class methods and lambda bodies are part of their
 * parent's `sourceCode` but don't become separate nodes.
 *
 * ## Java Import Resolution
 * Java imports are package-qualified: `import com.example.models.Dog`.
 * These map to file paths: `com/example/models/Dog.java`.
 * JDK imports (e.g. `import java.util.List`) are treated as external/bare
 * and are skipped — similar to how the TS visitor skips npm packages.
 *
 * ## Known Limitations
 * - **Anonymous classes**: Methods declared inside anonymous class expressions
 *   are not extracted as separate entities.
 * - **Static imports**: `import static com.example.Utils.helper` — the static
 *   keyword is detected but import resolution treats these the same way.
 * - **Generic type parameters**: Not tracked on classes/interfaces.
 * - **Inner classes**: Nested class declarations inside class bodies are not
 *   currently extracted as separate top-level entities.
 * - **Overloaded methods**: Multiple methods with the same name in the same
 *   class will collide on nodeId. Only the last one wins.
 */

import type { Node } from "web-tree-sitter";
import {
	NodeLabel,
	EdgeType,
	type FileNode,
	type FunctionNode,
	type ClassNode,
	type InterfaceNode,
	type DecoratorNode,
	type CallsEdge,
	type ParsedEntity,
	type ParsedRelationship,
} from "@codex/shared";
import {
	nodeIdForFile,
	nodeIdForFunction,
	nodeIdForClass,
	nodeIdForInterface,
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
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JDK package prefixes. Imports starting with these are treated as external
 * (standard library) and are skipped — they don't correspond to user files.
 */
const JDK_PREFIXES = [
	"java.",
	"javax.",
	"sun.",
	"com.sun.",
	"jdk.",
	"org.w3c.",
	"org.xml.",
	"org.ietf.",
];

// ─────────────────────────────────────────────────────────────────────────────
// Pure helper functions
// ─────────────────────────────────────────────────────────────────────────────

/** Simple LOC: endRow - startRow + 1 (includes blanks and comments). */
function nodeLoc(node: Node): number {
	return node.endPosition.row - node.startPosition.row + 1;
}

/**
 * Checks whether a node has the `public` modifier.
 *
 * In tree-sitter-java, modifiers appear as a `modifiers` child node of the
 * declaration. The `modifiers` node contains keyword children like `public`,
 * `private`, `static`, `abstract`, etc.
 */
function hasModifier(node: Node, modifier: string): boolean {
	const modifiers = node.childForFieldName("modifiers") ??
		node.namedChildren.find((c) => c.type === "modifiers");
	if (!modifiers) return false;
	for (const child of modifiers.children) {
		if (child.text === modifier) return true;
	}
	return false;
}

/**
 * Checks if a Java import is a JDK/standard library import.
 * These are skipped because they don't correspond to user source files.
 */
function isJdkImport(qualifiedName: string): boolean {
	return JDK_PREFIXES.some((prefix) => qualifiedName.startsWith(prefix));
}

/**
 * Converts a fully qualified Java class name to a relative file path.
 * e.g. `com.example.models.Dog` → `com/example/models/Dog.java`
 */
function qualifiedNameToFilePath(qualifiedName: string): string {
	return qualifiedName.replace(/\./g, "/") + ".java";
}

/**
 * Extracts the simple (short) name from a fully qualified Java name.
 * e.g. `com.example.models.Dog` → `Dog`
 */
function simpleNameFromQualified(qualifiedName: string): string {
	const parts = qualifiedName.split(".");
	return parts[parts.length - 1] ?? qualifiedName;
}

/**
 * Extracts the text of a scoped_identifier or identifier node,
 * producing the full qualified name for an import.
 */
function extractQualifiedName(node: Node): string | null {
	if (node.type === "scoped_identifier" || node.type === "identifier") {
		return node.text;
	}
	// Walk into children looking for a scoped_identifier
	const scoped = node.namedChildren.find(
		(c) => c.type === "scoped_identifier" || c.type === "identifier",
	);
	return scoped?.text ?? null;
}

/**
 * Extracts human-readable parameter strings from `formal_parameters`.
 *
 * In tree-sitter-java, formal_parameters contains `formal_parameter` children:
 * ```
 * formal_parameters
 *   formal_parameter
 *     type_identifier "String"
 *     identifier "name"
 * ```
 */
function extractParameters(paramsNode: Node): string[] {
	const params: string[] = [];
	for (const child of paramsNode.namedChildren) {
		if (
			child.type === "formal_parameter" ||
			child.type === "spread_parameter"
		) {
			params.push(child.text);
		}
	}
	return params;
}

/**
 * Extracts the return type from a method_declaration.
 *
 * In tree-sitter-java, the return type is available via the `type` field
 * (e.g., `void`, `String`, `List<Dog>`). Constructors have no return type.
 */
function extractReturnType(methodNode: Node): string | null {
	// tree-sitter-java uses a `type` field for the return type
	const typeNode = methodNode.childForFieldName("type");
	if (typeNode) return typeNode.text;

	// Fallback: look for type nodes before the method name
	for (const child of methodNode.namedChildren) {
		if (
			child.type === "void_type" ||
			child.type === "type_identifier" ||
			child.type === "generic_type" ||
			child.type === "array_type" ||
			child.type === "integral_type" ||
			child.type === "floating_point_type" ||
			child.type === "boolean_type" ||
			child.type === "scoped_type_identifier"
		) {
			return child.text;
		}
		// Once we hit the method name or parameters, stop
		if (child.type === "identifier" || child.type === "formal_parameters") {
			break;
		}
	}
	return null;
}

/**
 * Extracts annotations from a method/class/interface declaration.
 *
 * In tree-sitter-java, annotations appear in the `modifiers` node or as
 * direct children before the declaration in certain contexts.
 */
function extractAnnotations(node: Node): Node[] {
	const annotations: Node[] = [];

	// Check modifiers node for annotations
	const modifiers = node.childForFieldName("modifiers") ??
		node.namedChildren.find((c) => c.type === "modifiers");
	if (modifiers) {
		for (const child of modifiers.namedChildren) {
			if (child.type === "marker_annotation" || child.type === "annotation") {
				annotations.push(child);
			}
		}
	}

	return annotations;
}

/**
 * Checks if a method has an @Override annotation.
 */
function hasOverrideAnnotation(node: Node): boolean {
	const annotations = extractAnnotations(node);
	for (const ann of annotations) {
		const nameNode = ann.childForFieldName("name") ??
			ann.namedChildren.find(
				(c) => c.type === "identifier" || c.type === "scoped_identifier",
			);
		if (nameNode && nameNode.text === "Override") return true;
	}
	return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visit context — accumulates results within a single file visit
// ─────────────────────────────────────────────────────────────────────────────

interface VisitContext {
	/** Relative file path (used for nodeId generation and graph storage). */
	filePath: string;
	/** nodeId of the current file's FileNode. */
	fileNodeId: string;
	/** Accumulated entity nodes. */
	entities: ParsedEntity[];
	/** Accumulated intra-file relationships. */
	relationships: ParsedRelationship[];
	/** Accumulated cross-file references for the linker. */
	unresolvedRefs: UnresolvedReference[];
	/**
	 * Set of locally defined method names (unqualified), used to distinguish
	 * intra-file calls from cross-file calls during call extraction.
	 */
	localMethodNames: Set<string>;
	/**
	 * Set of method names that have @Override annotation, used to create
	 * OVERRIDES edges in the linker.
	 */
	overrideMethods: Set<string>;
	/**
	 * Maps lowercase simple class name → actual class name for imported classes.
	 *
	 * Used by the call extractor to map field/variable names to their declared
	 * class type. E.g. `import com.example.UserService` adds `"userservice" → "UserService"`.
	 * When a call `userService.getUser()` is seen, the object "userService" is
	 * lowercased and looked up here to produce `"UserService.getUser"` instead
	 * of the opaque `"userService.getUser"`.
	 */
	importedClassNames: Map<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visitor implementation
// ─────────────────────────────────────────────────────────────────────────────

export class JavaVisitor implements Visitor {
	visit(tree: Tree, sourceCode: string, file: SourceFile): VisitorFileResult {
		const filePath = file.relativePath;
		const fileNodeId = nodeIdForFile(filePath);

		const ctx: VisitContext = {
			filePath,
			fileNodeId,
			entities: [],
			relationships: [],
			unresolvedRefs: [],
			localMethodNames: new Set(),
			overrideMethods: new Set(),
			importedClassNames: new Map(),
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

		// ── Pre-pass: collect local method names ────────────────────────
		// Done first so call extraction can distinguish local vs cross-file.
		this.collectLocalNames(tree.rootNode, ctx);

		// ── Walk top-level declarations ─────────────────────────────────
		for (const child of tree.rootNode.namedChildren) {
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
			reExports: [] as ReExportEntry[],
			defaultExportName: null,
		};
	}

	// ── Pre-pass: collect local names ──────────────────────────────────

	/**
	 * Walks the tree to collect all locally defined method and class names.
	 * This enables call extraction to distinguish local calls from cross-file calls.
	 */
	private collectLocalNames(rootNode: Node, ctx: VisitContext): void {
		for (const child of rootNode.namedChildren) {
			if (child.type === "class_declaration" || child.type === "enum_declaration") {
				const nameNode = child.childForFieldName("name");
				if (nameNode) ctx.localMethodNames.add(nameNode.text);

				const body = child.childForFieldName("body");
				if (body) {
					for (const member of body.namedChildren) {
						if (
							member.type === "method_declaration" ||
							member.type === "constructor_declaration"
						) {
							const methodName = member.childForFieldName("name");
							if (methodName) ctx.localMethodNames.add(methodName.text);
						}
					}
				}
			} else if (child.type === "interface_declaration") {
				const nameNode = child.childForFieldName("name");
				if (nameNode) ctx.localMethodNames.add(nameNode.text);

				const body = child.childForFieldName("body");
				if (body) {
					for (const member of body.namedChildren) {
						if (member.type === "method_declaration") {
							const methodName = member.childForFieldName("name");
							if (methodName) ctx.localMethodNames.add(methodName.text);
						}
					}
				}
			}
		}
	}

	// ── Top-level dispatch ──────────────────────────────────────────────

	private processTopLevel(node: Node, ctx: VisitContext): void {
		switch (node.type) {
			case "import_declaration":
				this.handleImportDeclaration(node, ctx);
				break;
			case "class_declaration":
				this.handleClassDeclaration(node, ctx);
				break;
			case "interface_declaration":
				this.handleInterfaceDeclaration(node, ctx);
				break;
			case "enum_declaration":
				this.handleEnumDeclaration(node, ctx);
				break;
			// package_declaration, module_declaration — intentionally skipped
		}
	}

	// ── Import declarations ─────────────────────────────────────────────

	/**
	 * Parses a Java import declaration into an `UnresolvedImport`.
	 *
	 * CST shape:
	 * ```
	 * import_declaration
	 *   scoped_identifier "com.example.models.Dog"
	 * ```
	 *
	 * Or for wildcard imports:
	 * ```
	 * import_declaration
	 *   scoped_identifier "com.example.models"
	 *   asterisk "*"
	 * ```
	 *
	 * Or for static imports:
	 * ```
	 * import_declaration
	 *   "static"
	 *   scoped_identifier "com.example.Utils.helper"
	 * ```
	 */
	private handleImportDeclaration(node: Node, ctx: VisitContext): void {
		const qualifiedNode = node.namedChildren.find(
			(c) => c.type === "scoped_identifier" || c.type === "identifier",
		);
		if (!qualifiedNode) return;

		const qualifiedName = qualifiedNode.text;

		// Skip JDK/standard library imports
		if (isJdkImport(qualifiedName)) return;

		// Check for wildcard import: `import com.example.models.*`
		const isWildcard = node.children.some(
			(c) => !c.isNamed && c.text === "*",
		);

		// For wildcard imports, the specifier is the package, not a specific class
		const specifier = isWildcard
			? qualifiedName + ".*"
			: qualifiedName;

		const simpleName = simpleNameFromQualified(qualifiedName);

		// Register imported class name for the call-site heuristic.
		// Maps lowercase simple name → PascalCase class name so that a
		// variable `userService` can be matched to imported class `UserService`.
		if (!isWildcard) {
			ctx.importedClassNames.set(simpleName.toLowerCase(), simpleName);
		}

		ctx.unresolvedRefs.push({
			kind: "import",
			sourceFileRelPath: ctx.filePath,
			specifier,
			importedNames: isWildcard
				? []
				: [{ name: simpleName, alias: null }],
			isNamespaceImport: isWildcard,
			hasDefaultImport: false,
			defaultOrNamespaceName: isWildcard ? simpleName : null,
		});
	}

	// ── Class declarations ──────────────────────────────────────────────

	/**
	 * Handles `class Foo extends Bar implements Baz { ... }`.
	 *
	 * CST shape (tree-sitter-java):
	 * ```
	 * class_declaration
	 *   modifiers: "public" "abstract"
	 *   name: identifier "Foo"
	 *   superclass: superclass "extends Bar"
	 *   interfaces: super_interfaces "implements Baz, Qux"
	 *   body: class_body
	 *     method_declaration
	 *       ...
	 *     constructor_declaration
	 *       ...
	 * ```
	 */
	private handleClassDeclaration(node: Node, ctx: VisitContext): void {
		const nameNode = node.childForFieldName("name");
		if (!nameNode) return;

		const name = nameNode.text;
		const nodeId = nodeIdForClass(ctx.filePath, name);
		const isExported = hasModifier(node, "public");
		const isAbstract = hasModifier(node, "abstract");

		// ── Parent class (extends) ──────────────────────────────────
		let parentClass: string | null = null;
		const superclassNode = node.childForFieldName("superclass");
		if (superclassNode) {
			// superclass node contains the extends keyword and a type reference
			const typeNode = superclassNode.namedChildren.find(
				(c) =>
					c.type === "type_identifier" ||
					c.type === "generic_type" ||
					c.type === "scoped_type_identifier",
			);
			parentClass = typeNode?.text ?? null;
		}

		// ── Interfaces (implements) ─────────────────────────────────
		const interfaces: string[] = [];
		const interfacesNode = node.childForFieldName("interfaces");
		if (interfacesNode) {
			for (const child of interfacesNode.namedChildren) {
				if (
					child.type === "type_identifier" ||
					child.type === "generic_type" ||
					child.type === "type_list"
				) {
					if (child.type === "type_list") {
						// type_list contains multiple type references
						for (const typeRef of child.namedChildren) {
							interfaces.push(typeRef.text);
						}
					} else {
						interfaces.push(child.text);
					}
				}
			}
		}

		// ── Methods and constructors ────────────────────────────────
		const methods: string[] = [];
		const body = node.childForFieldName("body");
		if (body) {
			for (const member of body.namedChildren) {
				if (member.type === "method_declaration") {
					const methodName = member.childForFieldName("name");
					if (methodName) methods.push(methodName.text);
				} else if (member.type === "constructor_declaration") {
					const ctorName = member.childForFieldName("name");
					if (ctorName) methods.push(ctorName.text);
				}
			}
		}

		// ── Annotations on the class ────────────────────────────────
		const annotations = extractAnnotations(node);
		for (const ann of annotations) {
			this.createDecorator(ann, nodeId, ctx);
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

		// EXPORTS: File → Class (if public)
		if (isExported) {
			ctx.relationships.push({
				sourceId: ctx.fileNodeId,
				targetId: nodeId,
				edge: { type: EdgeType.EXPORTS },
			});
		}

		// INHERITS: Class → Parent Class (unresolved — name only)
		if (parentClass) {
			// We record the parent class name; the linker resolves the target nodeId.
			// For now, emit a placeholder relationship using a synthetic nodeId.
			// The linker will resolve this in Pass 2 if the parent is in the codebase.
			ctx.unresolvedRefs.push({
				kind: "call",
				callerNodeId: nodeId,
				calleeName: `__inherits__${parentClass}`,
				callSiteLine: node.startPosition.row + 1,
				callSiteFile: ctx.filePath,
			});
		}

		// IMPLEMENTS: Class → Interface (for each interface)
		for (const iface of interfaces) {
			// Strip generic parameters for the interface name (e.g., "Comparable<Dog>" → "Comparable")
			const cleanName = iface.includes("<") ? iface.slice(0, iface.indexOf("<")) : iface;
			ctx.unresolvedRefs.push({
				kind: "call",
				callerNodeId: nodeId,
				calleeName: `__implements__${cleanName}`,
				callSiteLine: node.startPosition.row + 1,
				callSiteFile: ctx.filePath,
			});
		}

		// ── Extract methods as FunctionNodes ────────────────────────
		if (body) {
			this.extractMethods(body, name, nodeId, ctx);
		}
	}

	// ── Interface declarations ──────────────────────────────────────────

	/**
	 * Handles `interface Foo { ... }`.
	 *
	 * CST shape:
	 * ```
	 * interface_declaration
	 *   modifiers: "public"
	 *   name: identifier "Foo"
	 *   body: interface_body
	 *     method_declaration
	 *       ...
	 * ```
	 */
	private handleInterfaceDeclaration(node: Node, ctx: VisitContext): void {
		const nameNode = node.childForFieldName("name");
		if (!nameNode) return;

		const name = nameNode.text;
		const nodeId = nodeIdForInterface(ctx.filePath, name);
		const isExported = hasModifier(node, "public");

		// ── Methods ─────────────────────────────────────────────────
		const methods: string[] = [];
		const body = node.childForFieldName("body");
		if (body) {
			for (const member of body.namedChildren) {
				if (member.type === "method_declaration") {
					const methodName = member.childForFieldName("name");
					if (methodName) methods.push(methodName.text);
				}
			}
		}

		// ── Annotations on the interface ────────────────────────────
		const annotations = extractAnnotations(node);
		for (const ann of annotations) {
			this.createDecorator(ann, nodeId, ctx);
		}

		const interfaceNode: InterfaceNode = {
			label: NodeLabel.Interface,
			nodeId,
			name,
			qualifiedName: `${ctx.filePath}::${name}`,
			filePath: ctx.filePath,
			startLine: node.startPosition.row + 1,
			endLine: node.endPosition.row + 1,
			loc: nodeLoc(node),
			methods,
			isExported,
			sourceCode: node.text,
		};

		ctx.entities.push({ node: interfaceNode });

		// DEFINED_IN: Interface → File
		ctx.relationships.push({
			sourceId: nodeId,
			targetId: ctx.fileNodeId,
			edge: { type: EdgeType.DEFINED_IN },
		});

		// EXPORTS: File → Interface (if public)
		if (isExported) {
			ctx.relationships.push({
				sourceId: ctx.fileNodeId,
				targetId: nodeId,
				edge: { type: EdgeType.EXPORTS },
			});
		}

		// ── Extract interface method declarations as FunctionNodes ───
		if (body) {
			this.extractInterfaceMethods(body, name, nodeId, ctx);
		}
	}

	// ── Enum declarations ───────────────────────────────────────────────

	/**
	 * Handles `enum Foo { ... }` — extracted as a ClassNode variant.
	 *
	 * CST shape:
	 * ```
	 * enum_declaration
	 *   modifiers: "public"
	 *   name: identifier "Foo"
	 *   interfaces: super_interfaces "implements Bar"
	 *   body: enum_body
	 *     enum_constant
	 *       ...
	 *     method_declaration
	 *       ...
	 * ```
	 */
	private handleEnumDeclaration(node: Node, ctx: VisitContext): void {
		const nameNode = node.childForFieldName("name");
		if (!nameNode) return;

		const name = nameNode.text;
		const nodeId = nodeIdForClass(ctx.filePath, name);
		const isExported = hasModifier(node, "public");

		// ── Interfaces (implements) ─────────────────────────────────
		const interfaces: string[] = [];
		const interfacesNode = node.childForFieldName("interfaces");
		if (interfacesNode) {
			for (const child of interfacesNode.namedChildren) {
				if (
					child.type === "type_identifier" ||
					child.type === "generic_type" ||
					child.type === "type_list"
				) {
					if (child.type === "type_list") {
						for (const typeRef of child.namedChildren) {
							interfaces.push(typeRef.text);
						}
					} else {
						interfaces.push(child.text);
					}
				}
			}
		}

		// ── Methods ─────────────────────────────────────────────────
		const methods: string[] = [];
		const body = node.childForFieldName("body");
		if (body) {
			for (const member of body.namedChildren) {
				if (member.type === "method_declaration") {
					const methodName = member.childForFieldName("name");
					if (methodName) methods.push(methodName.text);
				} else if (member.type === "constructor_declaration") {
					const ctorName = member.childForFieldName("name");
					if (ctorName) methods.push(ctorName.text);
				}
			}
		}

		// ── Annotations on the enum ─────────────────────────────────
		const annotations = extractAnnotations(node);
		for (const ann of annotations) {
			this.createDecorator(ann, nodeId, ctx);
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
			isAbstract: false,
			parentClass: null,
			interfaces,
			sourceCode: node.text,
		};

		ctx.entities.push({ node: classNode });

		// DEFINED_IN: Enum(Class) → File
		ctx.relationships.push({
			sourceId: nodeId,
			targetId: ctx.fileNodeId,
			edge: { type: EdgeType.DEFINED_IN },
		});

		// EXPORTS: File → Enum(Class) (if public)
		if (isExported) {
			ctx.relationships.push({
				sourceId: ctx.fileNodeId,
				targetId: nodeId,
				edge: { type: EdgeType.EXPORTS },
			});
		}

		// ── Extract methods as FunctionNodes ────────────────────────
		if (body) {
			this.extractMethods(body, name, nodeId, ctx);
		}
	}

	// ── Method extraction (class body) ──────────────────────────────────

	/**
	 * Extracts method_declaration and constructor_declaration from a class_body
	 * as FunctionNode entities, with DEFINED_IN edges to the parent class and
	 * CALLS edges from method bodies.
	 *
	 * Only direct children of the class_body are extracted — methods inside
	 * anonymous inner classes are ignored.
	 */
	private extractMethods(
		classBody: Node,
		className: string,
		classNodeId: string,
		ctx: VisitContext,
	): void {
		for (const member of classBody.namedChildren) {
			if (
				member.type !== "method_declaration" &&
				member.type !== "constructor_declaration"
			) {
				continue;
			}

			try {
				const nameNode = member.childForFieldName("name");
				if (!nameNode) continue;

				const methodName = nameNode.text;
				const qualifiedMethodName = `${className}.${methodName}`;
				const methodNodeId = nodeIdForFunction(ctx.filePath, qualifiedMethodName);
				const isExported = hasModifier(member, "public");
				const paramsNode = member.childForFieldName("parameters");
				const returnType = member.type === "constructor_declaration"
					? null
					: extractReturnType(member);

				// ── Annotations on the method ───────────────────────
				const annotations = extractAnnotations(member);
				const isOverride = hasOverrideAnnotation(member);

				for (const ann of annotations) {
					this.createDecorator(ann, methodNodeId, ctx);
				}

				if (isOverride) {
					ctx.overrideMethods.add(qualifiedMethodName);
				}

				const funcNode: FunctionNode = {
					label: NodeLabel.Function,
					nodeId: methodNodeId,
					name: methodName,
					qualifiedName: `${ctx.filePath}::${qualifiedMethodName}`,
					filePath: ctx.filePath,
					startLine: member.startPosition.row + 1,
					endLine: member.endPosition.row + 1,
					loc: nodeLoc(member),
					parameters: paramsNode ? extractParameters(paramsNode) : [],
					returnType,
					isExported,
					isAsync: false,
					sourceCode: member.text,
				};

				ctx.entities.push({ node: funcNode });

				// DEFINED_IN: Method → File
				ctx.relationships.push({
					sourceId: methodNodeId,
					targetId: ctx.fileNodeId,
					edge: { type: EdgeType.DEFINED_IN },
				});

				// EXPORTS: File → Method (if public)
				if (isExported) {
					ctx.relationships.push({
						sourceId: ctx.fileNodeId,
						targetId: methodNodeId,
						edge: { type: EdgeType.EXPORTS },
					});
				}

				// ── Extract calls from method body ──────────────────
				const bodyNode = member.childForFieldName("body");
				if (bodyNode) {
					this.extractCalls(bodyNode, methodNodeId, ctx);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(
					`[parser] Skipped method at ${ctx.filePath}:${member.startPosition.row + 1} — ${msg}`,
				);
			}
		}
	}

	// ── Method extraction (interface body) ──────────────────────────────

	/**
	 * Extracts method_declaration from an interface_body as FunctionNode entities.
	 * Interface methods don't have bodies, so no call extraction is performed.
	 */
	private extractInterfaceMethods(
		interfaceBody: Node,
		interfaceName: string,
		interfaceNodeId: string,
		ctx: VisitContext,
	): void {
		for (const member of interfaceBody.namedChildren) {
			if (member.type !== "method_declaration") continue;

			try {
				const nameNode = member.childForFieldName("name");
				if (!nameNode) continue;

				const methodName = nameNode.text;
				const qualifiedMethodName = `${interfaceName}.${methodName}`;
				const methodNodeId = nodeIdForFunction(ctx.filePath, qualifiedMethodName);
				const paramsNode = member.childForFieldName("parameters");
				const returnType = extractReturnType(member);

				// ── Annotations on the method ───────────────────────
				const annotations = extractAnnotations(member);
				for (const ann of annotations) {
					this.createDecorator(ann, methodNodeId, ctx);
				}

				const funcNode: FunctionNode = {
					label: NodeLabel.Function,
					nodeId: methodNodeId,
					name: methodName,
					qualifiedName: `${ctx.filePath}::${qualifiedMethodName}`,
					filePath: ctx.filePath,
					startLine: member.startPosition.row + 1,
					endLine: member.endPosition.row + 1,
					loc: nodeLoc(member),
					parameters: paramsNode ? extractParameters(paramsNode) : [],
					returnType,
					isExported: true, // Interface methods are implicitly public
					isAsync: false,
					sourceCode: member.text,
				};

				ctx.entities.push({ node: funcNode });

				// DEFINED_IN: Method → File
				ctx.relationships.push({
					sourceId: methodNodeId,
					targetId: ctx.fileNodeId,
					edge: { type: EdgeType.DEFINED_IN },
				});

				// EXPORTS: File → Method (interface methods are always public)
				ctx.relationships.push({
					sourceId: ctx.fileNodeId,
					targetId: methodNodeId,
					edge: { type: EdgeType.EXPORTS },
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(
					`[parser] Skipped interface method at ${ctx.filePath}:${member.startPosition.row + 1} — ${msg}`,
				);
			}
		}
	}

	// ── Call extraction ─────────────────────────────────────────────────

	/**
	 * Extracts method invocations from a method body as `UnresolvedCall` references.
	 *
	 * Captures both simple calls (`doSomething()`) and method calls on objects
	 * (`service.getUser()`). For method calls, the callee name is recorded as
	 * `object.method` (e.g., "service.getUser").
	 *
	 * Uses `descendantsOfType("method_invocation")` for efficient traversal.
	 */
	private extractCalls(
		body: Node,
		callerNodeId: string,
		ctx: VisitContext,
	): void {
		const invocations = body.descendantsOfType("method_invocation");

		for (const invocation of invocations) {
			const nameNode = invocation.childForFieldName("name");
			if (!nameNode) continue;

			const methodName = nameNode.text;

			// Check if this is a method call on an object (e.g., `service.getUser()`)
			const objectNode = invocation.childForFieldName("object");
			let calleeName: string;
			if (objectNode) {
				// Heuristic: if the object name (lowercase) matches an imported class
				// name (e.g., `userService` → `UserService`), use the class name as
				// the qualifier so the linker can resolve `UserService.getUser`.
				const objectText = objectNode.text;
				const resolvedClass = ctx.importedClassNames.get(objectText.toLowerCase());
				calleeName = resolvedClass
					? `${resolvedClass}.${methodName}`
					: `${objectText}.${methodName}`;
			} else {
				calleeName = methodName;
			}

			ctx.unresolvedRefs.push({
				kind: "call",
				callerNodeId,
				calleeName,
				callSiteLine: invocation.startPosition.row + 1,
				callSiteFile: ctx.filePath,
			});
		}
	}

	// ── Decorator (annotation) creation ─────────────────────────────────

	/**
	 * Creates a DecoratorNode from a marker_annotation or annotation CST node.
	 *
	 * CST shapes:
	 * ```
	 * marker_annotation
	 *   name: identifier "Override"
	 *
	 * annotation
	 *   name: identifier "RequestMapping"
	 *   arguments: annotation_argument_list
	 *     element_value_pair
	 *       ...
	 * ```
	 */
	private createDecorator(
		annotationNode: Node,
		targetNodeId: string,
		ctx: VisitContext,
	): void {
		const nameNode = annotationNode.childForFieldName("name") ??
			annotationNode.namedChildren.find(
				(c) => c.type === "identifier" || c.type === "scoped_identifier",
			);
		if (!nameNode) return;

		const name = `@${nameNode.text}`;
		const targetLine = annotationNode.startPosition.row + 1;
		const decoratorNodeId = nodeIdForDecorator(ctx.filePath, name, targetLine);

		// Extract annotation arguments
		const args: string[] = [];
		const argsNode = annotationNode.childForFieldName("arguments") ??
			annotationNode.namedChildren.find(
				(c) => c.type === "annotation_argument_list",
			);
		if (argsNode) {
			for (const child of argsNode.namedChildren) {
				args.push(child.text);
			}
		}

		const decoratorNode: DecoratorNode = {
			label: NodeLabel.Decorator,
			nodeId: decoratorNodeId,
			name,
			qualifiedName: `${ctx.filePath}::${name}:L${targetLine}`,
			filePath: ctx.filePath,
			startLine: targetLine,
			decoratorKind: "annotation",
			arguments: args,
		};

		ctx.entities.push({ node: decoratorNode });

		// DECORATED_BY: Target Entity → Decorator
		ctx.relationships.push({
			sourceId: targetNodeId,
			targetId: decoratorNodeId,
			edge: { type: EdgeType.DECORATED_BY },
		});
	}
}
