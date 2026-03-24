/**
 * @fileoverview LLM-based intent classifier for the hybrid RAG pipeline.
 *
 * Classifies a natural language query into one of three intents:
 *   - structural: Direct graph traversal → outputs a StructuralQuerySpec
 *   - social:     Developer/expertise query
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
import { getSchemaPrompt } from "@codex/graph-client";
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
   IMPORTANT: If the question DESCRIBES behavior without naming a specific entity, it is NOT structural. Examples:
   - "What function fetches blog posts?" → NOT structural (describes behavior, doesn't name a function)
   - "What component displays a list of posts?" → NOT structural (describes what it does)
   - "What validates email addresses?" → NOT structural (describes behavior)
   - "What custom hook manages user state?" → NOT structural (describes purpose)
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

2. **social** — The question is about people: who wrote code, who has expertise, who to ask about something.
   Output: { "kind": "social", "extractedName": "<module or entity name>" }

3. **hybrid** — The question describes behavior, asks about concepts, or requires understanding what code DOES.
   This is the default for any question that doesn't name a specific entity or ask about people.
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

		return parseClassification(response.content);
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
