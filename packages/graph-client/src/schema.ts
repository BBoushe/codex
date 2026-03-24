/**
 * @fileoverview Graph schema descriptor.
 *
 * Single source of truth for the CODEX graph schema. Consumed by:
 *   - The intent classifier (injected into the LLM prompt)
 *   - The structural query spec builder (validates specs against known edges)
 *   - Documentation generators
 *
 * When a new node label or edge type is added to the parser, add it here.
 * The LLM will immediately understand it without prompt changes.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Schema types
// ─────────────────────────────────────────────────────────────────────────────

export interface NodeSchema {
	label: string;
	description: string;
	/** Key properties useful for matching/filtering. */
	matchProperties: string[];
}

export interface EdgeSchema {
	type: string;
	description: string;
	fromLabels: string[];
	toLabels: string[];
	/** Edge properties available for filtering. */
	properties: string[];
}

export interface GraphSchema {
	nodes: NodeSchema[];
	edges: EdgeSchema[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema definition
// ─────────────────────────────────────────────────────────────────────────────

export const GRAPH_SCHEMA: GraphSchema = {
	nodes: [
		{
			label: "File",
			description: "Source code file",
			matchProperties: ["filePath", "language", "extension"],
		},
		{
			label: "Directory",
			description: "Filesystem directory",
			matchProperties: ["path"],
		},
		{
			label: "Function",
			description: "Function or method definition",
			matchProperties: ["name", "qualifiedName", "filePath", "isExported"],
		},
		{
			label: "Class",
			description: "Class definition (OOP)",
			matchProperties: ["name", "qualifiedName", "filePath", "isExported", "parentClass"],
		},
		{
			label: "Component",
			description: "React component (arrow, function, memo, forwardRef)",
			matchProperties: ["name", "qualifiedName", "filePath", "isExported", "componentKind"],
		},
		{
			label: "Hook",
			description: "React hook (useState, useEffect, custom, etc.)",
			matchProperties: ["name", "qualifiedName", "filePath", "hookType"],
		},
		{
			label: "Prop",
			description: "Component prop definition",
			matchProperties: ["name", "filePath", "propType", "isRequired"],
		},
		{
			label: "Interface",
			description: "Interface declaration (Java interfaces, Python ABCs)",
			matchProperties: ["name", "qualifiedName", "filePath", "isExported"],
		},
		{
			label: "Decorator",
			description: "Decorator or annotation (Python @decorator, Java @Annotation)",
			matchProperties: ["name", "filePath", "decoratorKind"],
		},
		{
			label: "Developer",
			description: "Git author with expertise data",
			matchProperties: ["name", "email"],
		},
		{
			label: "Commit",
			description: "Git commit",
			matchProperties: ["sha", "message", "timestamp"],
		},
	],
	edges: [
		{
			type: "CALLS",
			description: "Function/component invokes another function",
			fromLabels: ["Function", "Component", "Hook"],
			toLabels: ["Function", "Component", "Hook"],
			properties: ["callSiteLine", "callSiteFile"],
		},
		{
			type: "RENDERS",
			description: "Component renders another component in JSX",
			fromLabels: ["Component"],
			toLabels: ["Component"],
			properties: [],
		},
		{
			type: "IMPORTS",
			description: "File imports another file",
			fromLabels: ["File"],
			toLabels: ["File"],
			properties: [],
		},
		{
			type: "EXPORTS",
			description: "File exports a function, class, component, or interface",
			fromLabels: ["File"],
			toLabels: ["Function", "Class", "Component", "Interface"],
			properties: [],
		},
		{
			type: "DEFINED_IN",
			description: "Entity is defined in a file",
			fromLabels: ["Function", "Class", "Component", "Hook", "Interface", "Decorator"],
			toLabels: ["File"],
			properties: [],
		},
		{
			type: "INHERITS",
			description: "Class extends another class",
			fromLabels: ["Class"],
			toLabels: ["Class"],
			properties: [],
		},
		{
			type: "IMPLEMENTS",
			description: "Class implements an interface",
			fromLabels: ["Class"],
			toLabels: ["Interface"],
			properties: [],
		},
		{
			type: "DECORATED_BY",
			description: "Entity is decorated/annotated (Python @decorator, Java @Annotation)",
			fromLabels: ["Function", "Class", "Interface"],
			toLabels: ["Decorator"],
			properties: [],
		},
		{
			type: "OVERRIDES",
			description: "Method overrides a parent class method (Java @Override)",
			fromLabels: ["Function"],
			toLabels: ["Function"],
			properties: [],
		},
		{
			type: "USES_HOOK",
			description: "Component uses a React hook",
			fromLabels: ["Component"],
			toLabels: ["Hook"],
			properties: ["callSiteLine"],
		},
		{
			type: "ACCEPTS_PROP",
			description: "Component accepts a prop",
			fromLabels: ["Component"],
			toLabels: ["Prop"],
			properties: [],
		},
		{
			type: "PASSES_PROP",
			description: "Component passes a prop to another component",
			fromLabels: ["Component"],
			toLabels: ["Component"],
			properties: ["propName", "passKind"],
		},
		{
			type: "SETS_STATE",
			description: "Component or function calls a useState setter",
			fromLabels: ["Component", "Function"],
			toLabels: ["Hook"],
			properties: ["callSiteLine"],
		},
		{
			type: "CONTAINS",
			description: "Directory contains files or subdirectories",
			fromLabels: ["Directory", "File"],
			toLabels: ["File", "Directory", "Function", "Class"],
			properties: [],
		},
		{
			type: "HAS_EXPERTISE",
			description: "Developer has expertise on a file (from git history)",
			fromLabels: ["Developer"],
			toLabels: ["File"],
			properties: ["doaScore", "isFirstAuthor", "lastContribution"],
		},
		{
			type: "COMMITTED",
			description: "Developer authored a commit",
			fromLabels: ["Developer"],
			toLabels: ["Commit"],
			properties: [],
		},
		{
			type: "MODIFIED",
			description: "Commit modified an entity",
			fromLabels: ["Commit"],
			toLabels: ["Function", "Class", "Component", "File"],
			properties: ["linesAdded", "linesDeleted"],
		},
	],
};

// ─────────────────────────────────────────────────────────────────────────────
// Schema prompt renderer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renders the graph schema as a compact text block for LLM prompt injection.
 *
 * Format:
 *   Nodes: File (filePath, language), Function (name, qualifiedName, filePath), ...
 *   Edges: (Function)-[CALLS]->(Function), (Component)-[RENDERS]->(Component), ...
 */
export function getSchemaPrompt(): string {
	const nodeLines = GRAPH_SCHEMA.nodes.map(
		(n) => `  ${n.label}: ${n.description} [match by: ${n.matchProperties.join(", ")}]`,
	);

	const edgeLines = GRAPH_SCHEMA.edges.map((e) => {
		const from = e.fromLabels.join("|");
		const to = e.toLabels.join("|");
		const props = e.properties.length > 0 ? ` {${e.properties.join(", ")}}` : "";
		return `  (${from})-[:${e.type}${props}]->(${to}) — ${e.description}`;
	});

	return [
		"Node types:",
		...nodeLines,
		"",
		"Relationship types:",
		...edgeLines,
	].join("\n");
}
