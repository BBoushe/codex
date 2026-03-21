/**
 * @fileoverview Unified Graph Schema
 *
 * The single source of truth for all node labels, edge types,
 * and their property shapes.
 *
 * Placement: packages/shared/src/schema.ts
 *
 * Design principles:
 *   1. A node exists if it's a plausible *query target* (something a user
 *      would search for, filter by, or inspect in the graph UI).
 *   2. Everything else lives as a property on the nearest relevant node.
 *   3. Edge types encode *semantic* relationships, not just structural
 *      containment — this is what makes the graph useful beyond a file tree.
 */

// -────────────────────────────────────────────────────────────────────────────
// Enums used in neo4j labels and types
// ─────────────────────────────────────────────────────────────────────────────

/** neo4j node labels */
export enum NodeLabel {
	// Structural
	Directory = "Directory",
	File = "File",
	Function = "Function",
	Class = "Class",

	// React specific
	Component = "Component",
	Hook = "Hook",
	Prop = "Prop",
	Context = "Context",
	Provider = "Provider",

	// Social
	Developer = "Developer",
	Commit = "Commit",
}

/** neo4j relationship types */
export enum EdgeType {
	// Structural
	CONTAINS = "CONTAINS", // Directory -> File, Directory -> Directory, File -> Function/Class
	DEFINED_IN = "DEFINED_IN", // Function/Class/Component -> File
	CALLS = "CALLS", // Function/Component -> Function
	IMPORTS = "IMPORTS", // File -> File
	EXPORTS = "EXPORTS", // File -> Function/Class/Component
	INHERITS = "INHERITS", // Class -> Class

	// React specific
	RENDERS = "RENDERS", // Component -> Component (JSX usage)
	USES_HOOK = "USES_HOOK", // Component -> Hook
	ACCEPTS_PROP = "ACCEPTS_PROP", // Component -> Prop (prop definition)
	PASSES_PROP = "PASSES_PROP", // Component -> Component (prop flow i.e. drilling)

	// React state
	SETS_STATE = "SETS_STATE", // Component/Function -> Hook(useState) — setter call

	// Social
	COMMITTED = "COMMITTED", // Developer -> Commit
	MODIFIED = "MODIFIED", // Commit -> Function/Class/Component/File
	HAS_EXPERTISE = "HAS_EXPERTISE", // Developer -> File (DOA weight)
}

// -────────────────────────────────────────────────────────────────────────────
// Supported languages
// ─────────────────────────────────────────────────────────────────────────────

export enum Language {
	TypeScript = "TypeScript",
	JavaScript = "JavaScript",
	Python = "Python",
	Java = "Java",
}

// -────────────────────────────────────────────────────────────────────────────
// Node Property interfaces
// ─────────────────────────────────────────────────────────────────────────────

/** Common properties for all nodes
 * `qualifiedName` is the primary human-readable identifier
 * `nodeId` is a deterministic hash used for cross-referencing with ChromaDB
 */
interface BaseNodeProperties {
	/** Deterministic cross-reference key. Generated via nodeId.ts factory functions. */
	nodeId: string;
	name: string; // short name
	qualifiedName: string; // unique scoped name e.g. "src/api/user.ts::fetchUser"
}

// Structural

export interface DirectoryNode extends BaseNodeProperties {
	label: NodeLabel.Directory;
	path: string; // relative to repo root (e.g. "src/components")
	depth: number; // nesting depth from repo root
}

export interface FileNode extends BaseNodeProperties {
	label: NodeLabel.File;
	filePath: string; // relative to repo root (e.g. "src/components/Button.tsx")
	language: Language;
	loc: number; // total lines of code (non-blank, non-comment)
	extension: string; // ".ts", ".tsx", ".py", ".java"
}

export interface FunctionNode extends BaseNodeProperties {
	label: NodeLabel.Function;
	filePath: string;
	startLine: number;
	endLine: number;
	loc: number;
	parameters: string[]; // ["userId: string", "options?: RequestOptions"]
	returnType: string | null; // "Promise<User>" or null if untyped
	isExported: boolean;
	isAsync: boolean;
	sourceCode: string; // raw text — used for embedding and display
}

export interface ClassNode extends BaseNodeProperties {
	label: NodeLabel.Class;
	filePath: string;
	startLine: number;
	endLine: number;
	loc: number;
	methods: string[]; // method names, for quick reference
	isExported: boolean;
	isAbstract: boolean;
	parentClass: string | null; // name of extended class, if any
	interfaces: string[]; // implemented interface names
	sourceCode: string;
}

// React-specific

export interface ComponentNode extends BaseNodeProperties {
	label: NodeLabel.Component;
	filePath: string;
	startLine: number;
	endLine: number;
	loc: number;
	isExported: boolean;
	/**
	 * How the component was defined. Matters for the parser because each
	 * pattern has a different CST shape in Tree-sitter.
	 *
	 *   "arrow"       → const Foo = () => <div/>
	 *   "function"    → function Foo() { return <div/> }
	 *   "memo"        → React.memo(() => <div/>)
	 *   "forwardRef"  → React.forwardRef((props, ref) => <div/>)
	 */
	componentKind: "arrow" | "function" | "memo" | "forwardRef";
	/** quick reference list (mirrors Prop nodes) */
	props: string[]; // ["userId", "onSummit", "className"]
	sourceCode: string;
}

export interface HookNode extends BaseNodeProperties {
	label: NodeLabel.Hook;
	filePath: string;
	startLine: number;
	/**
	 * Built-in hooks have known semantics; custom hooks are user-defined
	 * functions starting with "use".
	 */
	hookType:
		| "useState"
		| "useEffect"
		| "useMemo"
		| "useCallback"
		| "useRef"
		| "useContext"
		| "useReducer"
		| "custom";
	/** For useEffect/useMemo/useCallback: the dependency array identifiers. */
	dependencies: string[] | null; // null = no deps array, [] = empty deps
	/**
	 * The destructured names from the hook's return value.
	 * Captures what identifiers entered scope — essential for tracing state flow.
	 *
	 *   useState:    ["count", "setCount"]
	 *   useReducer:  ["state", "dispatch"]
	 *   useMemo:     ["memoizedValue"]   (single binding, not destructured)
	 *   useRef:      ["inputRef"]
	 *   useEffect:   []                  (no return binding)
	 *   custom:      varies
	 */
	returnBindings: string[];
	/**
	 * The arguments passed to the hook call (as source text).
	 * Captures the "configuration" of the hook instance.
	 *
	 *   useState(0)                     → ["0"]
	 *   useState<User>(null)            → ["null"]
	 *   useReducer(counterReducer, 0)   → ["counterReducer", "0"]
	 *   useContext(ThemeContext)         → ["ThemeContext"]
	 *   useRef(null)                    → ["null"]
	 */
	arguments: string[];
}

export interface PropNode extends BaseNodeProperties {
	label: NodeLabel.Prop;
	filePath: string; // file where the prop is *defined* (the component's file)
	propType: string | null; // "string", "() => void", null if untyped
	isRequired: boolean;
	defaultValue: string | null; // the literal default, if any
}

// Social / git-mined nodes

export interface DeveloperNode extends BaseNodeProperties {
	label: NodeLabel.Developer;
	email: string;
	/** Total commits across the analyzed repo. */
	totalCommits: number;
}

export interface CommitNode extends BaseNodeProperties {
	label: NodeLabel.Commit;
	sha: string;
	message: string;
	timestamp: string; // ISO 8601
	linesAdded: number;
	linesDeleted: number;
}

/** Union type of all possible node shapes in the graph. */
export type CodexNode =
	| DirectoryNode
	| FileNode
	| FunctionNode
	| ClassNode
	| ComponentNode
	| HookNode
	| PropNode
	| DeveloperNode
	| CommitNode;

// ─────────────────────────────────────────────────────────────
// Edge properties
// ─────────────────────────────────────────────────────────────

/**
 * Edges in Neo4j can carry properties. Most structural edges are "bare"
 * (no properties beyond the type), but some carry critical metadata.
 */

interface BaseEdgeProperties extends Record<string, unknown> {
	type: EdgeType;
}

/** CALLS: optionally track the call site for click-to-source in the UI. */
export interface CallsEdge extends BaseEdgeProperties {
	type: EdgeType.CALLS;
	callSiteLine: number; // line number of the call expression
	callSiteFile: string; // file containing the call
}

/** PASSES_PROP: which prop is being passed, and how. */
export interface PassesPropEdge extends BaseEdgeProperties {
	type: EdgeType.PASSES_PROP;
	propName: string; // "userId"
	/** Is the prop value a literal, a variable, or a spread? */
	passKind: "literal" | "variable" | "spread" | "expression";
}

/** USES_HOOK: link component -> hook instance with the hook name. */
export interface UsesHookEdge extends BaseEdgeProperties {
	type: EdgeType.USES_HOOK;
	callSiteLine: number;
}

/** SETS_STATE: a function/component calls a useState setter, mutating state. */
export interface SetsStateEdge extends BaseEdgeProperties {
	type: EdgeType.SETS_STATE;
	/** Line number of the setter call expression. */
	callSiteLine: number;
}

/** HAS_EXPERTISE: the DOA-weighted developer -> file expertise edge. */
export interface HasExpertiseEdge extends BaseEdgeProperties {
	type: EdgeType.HAS_EXPERTISE;
	doaScore: number; // 0.0 – 1.0 (normalized)
	isFirstAuthor: boolean;
	deliveries: number; // commit count to this file
	acceptances: number; // surviving lines ratio
	lastContribution: string; // ISO 8601 timestamp
}

/** MODIFIED: commit -> entity, with line-level detail. */
export interface ModifiedEdge extends BaseEdgeProperties {
	type: EdgeType.MODIFIED;
	linesAdded: number;
	linesDeleted: number;
}

export type CodexEdge =
	| BaseEdgeProperties
	| CallsEdge
	| PassesPropEdge
	| UsesHookEdge
	| SetsStateEdge
	| HasExpertiseEdge
	| ModifiedEdge;

// ─────────────────────────────────────────────────────────────
// Utility types for parser -> graph-client handoff
// ─────────────────────────────────────────────────────────────

/**
 * The parser produces `ParseResult` per file. The graph-client consumes
 * it and batch-inserts into Neo4j. This is the contract between the two
 * packages — change it carefully.
 */
export interface ParsedEntity {
	node: CodexNode;
}

export interface ParsedRelationship {
	sourceId: string; // nodeId of the source
	targetId: string; // nodeId of the target
	edge: CodexEdge;
}

export interface FileParseResult {
	file: FileNode;
	entities: ParsedEntity[];
	relationships: ParsedRelationship[];
}
