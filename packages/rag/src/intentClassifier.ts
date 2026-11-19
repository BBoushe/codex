/**
 * @fileoverview LLM-based intent classifier for the hybrid RAG pipeline.
 *
 * Classifies a natural language query into one of four intents:
 *   - structural: Direct graph traversal → outputs a StructuralQuerySpec
 *   - social:     Developer/expertise query
 *   - property:   Ranking/aggregation by numeric metric → deterministic Cypher
 *   - hybrid:     Semantic/architectural query needing vector search + LLM synthesis
 *
 * The graph schema is injected into the prompt automatically. When new node
 * labels or edge types are added to the parser, the LLM immediately
 * understands them without prompt maintenance.
 *
 * For structural intents, the LLM outputs a structured query spec (not raw
 * Cypher) which is deterministically converted to safe Cypher downstream.
 */

import type { LLMProvider } from "@codex/shared";
import { getSchemaPrompt, GRAPH_SCHEMA } from "@codex/graph-client";
import type { StructuralQuerySpec, NodeFilter } from "@codex/graph-client";
import type { QueryIntent, HybridSubKind } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// topK resolution
// ─────────────────────────────────────────────────────────────────────────────

const TOP_K_BY_SUB_KIND: Record<HybridSubKind, number> = {
	direct_lookup: 1,
	semantic: 3,
	architectural: 5,
};

function isArchitecturalChainQuery(query: string): boolean {
	const q = query.toLowerCase();
	if (q.includes("rendering chain") || q.includes("call chain")) {
		return true;
	}

	const hasFromTo = /\bfrom\b[\s\S]{0,120}\bto\b/.test(q);
	const hasArchitectureSignal =
		/\b(chain|flow|path|pipeline|interaction|interact|connect|connected|together)\b/.test(
			q,
		) ||
		q.includes("end-to-end") ||
		q.includes("end to end");

	return hasFromTo && hasArchitectureSignal;
}

function applyIntentGuards(query: string, intent: QueryIntent): QueryIntent {
	if (intent.kind === "structural" && isArchitecturalChainQuery(query)) {
		return {
			kind: "hybrid",
			subKind: "architectural",
			topK: TOP_K_BY_SUB_KIND.architectural,
			wasFallback: false,
		};
	}

	// "Where is X used?" is ambiguous — DEFINED_IN only shows where X is defined,
	// not where it is called/imported/rendered. Reroute to hybrid so vector search
	// can surface all usage patterns across CALLS, IMPORTS, RENDERS, etc.
	if (
		intent.kind === "structural" &&
		intent.spec.edge === "DEFINED_IN" &&
		/\bused?\b/i.test(query)
	) {
		return {
			kind: "hybrid",
			subKind: "semantic",
			topK: TOP_K_BY_SUB_KIND.semantic,
			wasFallback: false,
		};
	}

	return intent;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification prompt (schema injected at runtime)
// ─────────────────────────────────────────────────────────────────────────────

function buildClassificationPrompt(query: string): string {
	const schema = getSchemaPrompt();

	return `You are the intent router for CODEX, a code intelligence tool that helps developers understand codebases by querying a Code Property Graph (CPG).

CODEX's graph has the following schema:

${schema}

Your job: given a developer's question, decide HOW CODEX should answer it.

There are three routing options:

1. **structural** — The question names a SPECIFIC entity (by exact identifier) and asks about its graph relationships.
   The entity name must appear literally in the question. Examples:
   - "What calls fetchPosts?" → structural (fetchPosts is named)
   - "What does App render?" → structural (App is named)
   - "Where is formatDate defined?" → structural (formatDate is named)
   - "What files import utils.ts?" → structural (utils.ts is named)
   - "What uses useShallow?" → structural: CALLS incoming to useShallow (code entities that call it)
   IMPORTANT: If the question DESCRIBES behavior without naming a specific entity, it is NOT structural. Examples:
   - "What function fetches blog posts?" → NOT structural (describes behavior, doesn't name a function)
   - "What component displays a list of posts?" → NOT structural (describes what it does)
   - "What validates email addresses?" → NOT structural (describes behavior)
   - "What custom hook manages user state?" → NOT structural (describes purpose)
   IMPORTANT: "Where is X used?" is ambiguous — it could mean calls, imports, or renders. Use hybrid/semantic instead:
   - "Where is useShallow used?" → hybrid/semantic (use vector search to find all usage patterns)
   - "Where is fetchPosts used?" → hybrid/semantic (not just one edge type covers all usages)
   These belong in hybrid/semantic because CODEX needs to search for matching entities by meaning.
   Output a query spec describing which edge to traverse:
   {
     "kind": "structural",
     "relationship": "<natural language description of what's being asked>",
     "spec": {
       "from": { "label": "<optional node type>", "name": "<optional name>", "filePath": "<optional path>" },
       "edge": "<relationship type from the schema above>",
       "direction": "outgoing" or "incoming",
       "to": { "label": "<optional node type>", "name": "<optional name>", "filePath": "<optional path>" }
     }
   }
   Direction rules:
   - "outgoing" means from→to: "What does X call?" → from={name:"X"}, edge="CALLS", direction="outgoing", to={}
   - "incoming" means to→from: "What calls X?" → from={}, edge="CALLS", direction="incoming", to={name:"X"}
   The "from" side is the unknown result when direction is "incoming". The "to" side is the unknown result when direction is "outgoing".
   Omit fields you don't need (e.g. if no label constraint, omit "label"). Use the edge types from the schema above.

2. **social** — The question is specifically about PEOPLE: developers, authors, contributors.
   Use social ONLY when the question asks about a human person: who wrote something, who has expertise, who to contact, who contributed.

	IMPORTANT: "who/what calls X?", "who imports X?", "who uses X?" are asking about CODE ENTITIES (functions, files), NOT people → classify as structural, not social.

   Examples of social:
   - "Who wrote fetchPosts?" → social (asking about the developer/author)
   - "Who has expertise in utils.ts?" → social (asking about developer knowledge)
   - "Who is the main contributor?" → social (asking about a person)
   - "Who should I ask about the auth module?" → social (asking about a person)
   NOT social (these are about CODE, not PEOPLE):
   - "Who calls fetchPosts?" → structural (asking which code calls it)
   - "What is the smallest file?" → hybrid (asking about code properties)
   - "Which file has the most functions?" → hybrid (asking about code structure)
   - "What is the largest component?" → property (ranking by code size)
   - "Which files change the most?" → property (ranking by churn metric)
   - "What are the hotspots?" → property (ranking by churn metric)
   Output: { "kind": "social", "extractedName": "<developer name or file/module name if mentioned, otherwise empty string>" }

3. **property** — The question asks to RANK or FIND EXTREMES of code entities by a numeric metric.
   Signal words: "smallest", "largest", "biggest", "most", "fewest", "least", "top", "bottom", "how many lines", "highest churn".
   The schema above lists available sortable properties per node type (see "sort by" fields).
   Examples:
   - "What is the smallest file?" → property (File, loc, asc, 1)
   - "Which functions have the most lines?" → property (Function, loc, desc, 5)
   - "Top 10 files by churn" → property (File, churnRate, desc, 10)
   - "Which files have the most commits?" → property (File, totalCommits, desc, 5)
   - "What are the hotspots?" → property (File, churnRate, desc, 5)
   NOT property:
   - "What does the smallest function do?" → hybrid (asks about behavior, not just ranking)
   - "Who works on the most-churned files?" → social (asks about people)
   Output: { "kind": "property", "label": "<node label>", "property": "<sortable property name>", "order": "asc"|"desc", "limit": <number, infer from query: "smallest" → 1, "top 10" → 10, default 5> }

4. **hybrid** — EVERYTHING ELSE. This is the default.
   Any question about code behavior, concepts, or anything that is NOT about a named graph relationship (structural), NOT about a human person (social), and NOT about ranking by a numeric metric (property).
   Sub-classify by scope:
   - "direct_lookup": mentions a specific named entity and asks what it does ("What does fetchPosts do?") → topK=1
   - "semantic": describes a behavior or concept ("What handles authentication?", "What function fetches posts?") → topK=3
   - "architectural": asks about multi-module interactions or data flow ("How does data flow from API to UI?") → topK=5
   Output: { "kind": "hybrid", "subKind": "<direct_lookup|semantic|architectural>", "topK": <1|3|5> }

Query: "${query}"

Respond with ONLY the JSON object.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies a user query into a QueryIntent.
 *
 * On any parse failure, falls back to semantic hybrid search (K=3).
 */
export async function classifyIntent(
	query: string,
	classifierProvider: LLMProvider,
): Promise<QueryIntent> {
	const prompt = buildClassificationPrompt(query);

	try {
		const response = await classifierProvider.generate(
			[{ role: "user", content: prompt }],
			{ temperature: 0.15, maxTokens: 512 },
		);

		return applyIntentGuards(query, parseClassification(response.content));
	} catch {
		return semanticFallback();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing — trust the LLM's reasoning, validate JSON shape only
// ─────────────────────────────────────────────────────────────────────────────

function parseClassification(raw: string): QueryIntent {
	const cleaned = raw
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/, "")
		.trim();

	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		return semanticFallback();
	}

	if (!parsed || typeof parsed !== "object") return semanticFallback();

	const obj = parsed as Record<string, unknown>;

	if (obj["kind"] === "structural") {
		const spec = parseQuerySpec(obj["spec"]);
		if (!spec) return semanticFallback();
		const relationship =
			typeof obj["relationship"] === "string"
				? obj["relationship"]
				: "structural query";
		return { kind: "structural", spec, relationship, wasFallback: false };
	}

	if (obj["kind"] === "social") {
		return {
			kind: "social",
			extractedName: (obj["extractedName"] as string | undefined) ?? "",
			wasFallback: false,
		};
	}

	if (obj["kind"] === "property") {
		const label = obj["label"] as string | undefined;
		const property = obj["property"] as string | undefined;
		if (!label || !property) return semanticFallback();
		// Validate label and property against the graph schema
		const node = GRAPH_SCHEMA.nodes.find((n) => n.label === label);
		const validProp = node?.sortableProperties?.some(
			(p) => p.name === property,
		);
		if (!node || !validProp) return semanticFallback();
		const order = obj["order"] === "asc" ? ("asc" as const) : ("desc" as const);
		const rawLimit = typeof obj["limit"] === "number" ? obj["limit"] : 5;
		return {
			kind: "property",
			label,
			property,
			order,
			limit: Math.max(1, Math.min(rawLimit, 20)),
			wasFallback: false,
		};
	}

	if (obj["kind"] === "hybrid") {
		const subKind = obj["subKind"] as string | undefined;
		if (
			subKind === "direct_lookup" ||
			subKind === "semantic" ||
			subKind === "architectural"
		) {
			return {
				kind: "hybrid",
				subKind,
				topK: TOP_K_BY_SUB_KIND[subKind],
				wasFallback: false,
			};
		}
		return semanticFallback();
	}

	return semanticFallback();
}

function parseQuerySpec(raw: unknown): StructuralQuerySpec | null {
	if (!raw || typeof raw !== "object") return null;

	const obj = raw as Record<string, unknown>;
	const edge = obj["edge"];
	const direction = obj["direction"];

	if (typeof edge !== "string" || !edge) return null;
	if (direction !== "outgoing" && direction !== "incoming") return null;

	return {
		from: parseNodeFilter(obj["from"]),
		edge,
		direction,
		to: parseNodeFilter(obj["to"]),
	};
}

function parseNodeFilter(raw: unknown): NodeFilter {
	if (!raw || typeof raw !== "object") return {};
	const obj = raw as Record<string, unknown>;
	const filter: NodeFilter = {};
	if (typeof obj["label"] === "string" && obj["label"])
		filter.label = obj["label"];
	if (typeof obj["name"] === "string" && obj["name"]) filter.name = obj["name"];
	if (typeof obj["filePath"] === "string" && obj["filePath"])
		filter.filePath = obj["filePath"];
	return filter;
}

function semanticFallback(): QueryIntent {
	return { kind: "hybrid", subKind: "semantic", topK: 3, wasFallback: true };
}
