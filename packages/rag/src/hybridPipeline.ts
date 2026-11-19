/**
 * @fileoverview Hybrid RAG pipeline orchestrator.
 *
 * Coordinates the full flow:
 *   1. Intent classification (LLM-based)
 *   2a. Structural intent → direct Cypher query (no embedding, no LLM synthesis)
 *   2b. Social intent    → developer Cypher query (stub until Phase 3 git mining)
 *   2c. Hybrid intent    → vector search → graph expansion → context assembly → LLM synthesis
 *
 * Every SearchResult includes per-phase PipelineTimings for performance analysis.
 *
 * `runSearch()` is the unified entry point consumed by both the backend routes
 * and the CLI `query` command.
 */

import type { Driver } from "neo4j-driver";
import type { ChromaClient } from "chromadb";
import type { EmbeddingProvider, LLMProvider } from "@codex/shared";
import { tokenTracker } from "@codex/shared";
import {
	getOrCreateEntityCollection,
	getCollectionInfo,
	searchEntities,
	type VectorSearchResult,
} from "@codex/vector-client";
import {
	expandContext,
	executeStructuralSpec,
	executePropertyQuery,
	GRAPH_SCHEMA,
} from "@codex/graph-client";
import { classifyIntent } from "./intentClassifier.js";
import { assembleContext } from "./contextAssembler.js";
import { synthesize } from "./synthesizer.js";
import type {
	SearchResult,
	HybridSearchResult,
	SocialSearchResult,
	FileChurnInfo,
	QueryIntent,
	ExpansionOptions,
	ContextBudget,
	PipelineTimings,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline options
// ─────────────────────────────────────────────────────────────────────────────

export interface HybridPipelineOptions {
	/** Neo4j driver for graph queries and expansion. */
	driver: Driver;
	/** ChromaDB client for vector search. */
	chromaClient: ChromaClient;
	/** Embedding provider for query vectorization. */
	embeddingProvider: EmbeddingProvider;
	/** LLM provider for answer synthesis. */
	llmProvider: LLMProvider;
	/** Dedicated LLM provider for intent classification (low temperature). */
	classifierProvider: LLMProvider;
	/** Override auto-detected topK. If omitted, classifier determines K. */
	topK?: number;
	/** Context budget for assembled context (default: env RAG_CONTEXT_BUDGET or "standard"). */
	budget?: ContextBudget;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timing helper
// ─────────────────────────────────────────────────────────────────────────────

function emptyTimings(): PipelineTimings {
	return {
		classifierMs: 0,
		embeddingMs: 0,
		vectorSearchMs: 0,
		graphExpansionMs: 0,
		assemblyMs: 0,
		synthesisMs: 0,
		totalMs: 0,
	};
}

// Below from this comment until the one starting with ^ is focused on improving vector search relevance via a lightweight lexical reranking of the top ~20 candidates returned by ChromaDB, based on simple token overlap and label matching heuristics. This is intended to be a stopgap until we implement more robust relevance signals like LLM-based reranking or hybrid search in ChromaDB itself.

// This will work for the current testing phase but when seriously developing this into a serious produc we have to rethink this logic. For the purpose of the thesis it's enough but for something more, it simply isn't
const RERANK_STOP_WORDS = new Set([
	"the",
	"and",
	"from",
	"with",
	"that",
	"this",
	"what",
	"which",
	"where",
	"how",
	"does",
	"show",
	"list",
	"about",
	"into",
	"have",
	"has",
	"for",
	"who",
	"top",
	"most",
]);

function tokenizeForRerank(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((token) => token.length >= 3 && !RERANK_STOP_WORDS.has(token));
}

function inferPreferredLabels(query: string): Set<string> {
	const q = query.toLowerCase();
	const labels = new Set<string>();
	if (q.includes("function")) labels.add("function");
	if (q.includes("component")) labels.add("component");
	if (q.includes("hook")) labels.add("hook");
	if (q.includes("file")) labels.add("file");
	if (q.includes("class")) labels.add("class");
	return labels;
}

function rerankAnchors(
	query: string,
	candidates: VectorSearchResult[],
	topK: number,
): VectorSearchResult[] {
	if (candidates.length <= topK) return candidates;

	const queryTokens = tokenizeForRerank(query);
	const preferredLabels = inferPreferredLabels(query);

	const scored = candidates.map((anchor, idx) => {
		const haystack =
			`${anchor.name} ${anchor.qualifiedName} ${anchor.filePath}`.toLowerCase();
		const lexicalHits = queryTokens.reduce(
			(sum, token) => (haystack.includes(token) ? sum + 1 : sum),
			0,
		);
		const lexicalScore =
			queryTokens.length > 0 ? lexicalHits / queryTokens.length : 0;

		const vectorScore = 1 / (1 + Math.max(anchor.distance, 0));
		const labelBoost =
			preferredLabels.size > 0 &&
			preferredLabels.has(anchor.label.toLowerCase())
				? 0.12
				: 0;

		const score = vectorScore * 0.72 + lexicalScore * 0.28 + labelBoost;
		return { anchor, idx, score };
	});

	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (a.anchor.distance !== b.anchor.distance)
			return a.anchor.distance - b.anchor.distance;
		return a.idx - b.idx;
	});

	return scored.slice(0, topK).map((row) => row.anchor);
}

// ^ the comment ends here

// ─────────────────────────────────────────────────────────────────────────────
// Unified entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the full search pipeline for a user query.
 *
 * Classifies intent, delegates to the appropriate handler, and returns a
 * discriminated SearchResult with per-phase timings.
 */
export async function runSearch(
	query: string,
	options: HybridPipelineOptions,
): Promise<SearchResult> {
	tokenTracker.resetCurrentQuery();
	const totalStart = Date.now();
	const timings = emptyTimings();

	const budget: ContextBudget =
		options.budget ??
		(process.env["RAG_CONTEXT_BUDGET"] as ContextBudget | undefined) ??
		"standard";

	// ── 1. Classify intent ───────────────────────────────────────────────
	const classifierStart = Date.now();
	const intent = await classifyIntent(query, options.classifierProvider);
	timings.classifierMs = Date.now() - classifierStart;

	// ── 2. Route to handler ──────────────────────────────────────────────
	if (intent.kind === "structural") {
		const neoStart = Date.now();
		const result = await executeStructuralSpec(
			options.driver,
			intent.spec,
			query,
		);
		timings.graphExpansionMs = Date.now() - neoStart;
		timings.totalMs = Date.now() - totalStart;
		return { kind: "structural", result, intent, timings };
	}

	if (intent.kind === "social") {
		const neoStart = Date.now();
		const result = await runSocialSearch(
			query,
			intent,
			options.driver,
			options.llmProvider,
		);
		timings.graphExpansionMs = Date.now() - neoStart;
		timings.totalMs = Date.now() - totalStart;
		return { kind: "social", result, intent, timings };
	}

	if (intent.kind === "property") {
		const neoStart = Date.now();
		const queryResult = await executePropertyQuery(
			options.driver,
			intent.label,
			intent.property,
			intent.order,
			intent.limit,
		);
		timings.graphExpansionMs = Date.now() - neoStart;

		// Resolve unit from schema
		const node = GRAPH_SCHEMA.nodes.find((n) => n.label === intent.label);
		const propSchema = node?.sortableProperties?.find(
			(p) => p.name === intent.property,
		);
		const unit = propSchema?.unit ?? "";

		// Build context — compact/standard get table only, full gets top entity expanded
		const contextLines = queryResult.entities.map(
			(e, i) =>
				`${i + 1}. ${e.name} (${e.filePath}) [${e.label}]: ${intent.property} = ${e.value} ${unit}`,
		);
		let contextText = `Results for "${query}" — ${intent.label} sorted by ${intent.property} (${intent.order}):\n${contextLines.join("\n")}`;

		if (budget === "full" && queryResult.entities[0]) {
			const expanded = await expandContext(
				options.driver,
				queryResult.entities[0].nodeId,
			);
			if (expanded) {
				const assembled = assembleContext(expanded, { budget: "compact" });
				contextText += `\n\n--- Top result details ---\n${assembled.text}`;
			}
		}

		const synthStart = Date.now();
		const synthesis = await synthesize(options.llmProvider, query, {
			text: contextText,
			referencedNodeIds: queryResult.entities.map((e) => e.nodeId),
			charCount: contextText.length,
			wasTruncated: false,
		});
		timings.synthesisMs = Date.now() - synthStart;
		timings.totalMs = Date.now() - totalStart;

		return {
			kind: "property",
			result: {
				query,
				property: intent.property,
				unit,
				entities: queryResult.entities,
				answer: synthesis.answer,
				model: synthesis.model,
				usage: synthesis.usage,
			},
			intent,
			timings,
		};
	}

	// ── 3. Hybrid pipeline ───────────────────────────────────────────────
	const topK = options.topK ?? intent.topK;
	const result = await runHybridSearch(query, topK, budget, options, timings);
	timings.totalMs = Date.now() - totalStart;
	return { kind: "hybrid", result, intent, timings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hybrid search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the hybrid RAG pipeline: embed → search → expand → assemble → synthesize.
 * Mutates the provided `timings` object with per-phase durations.
 */
export async function runHybridSearch(
	query: string,
	topK: number,
	budget: ContextBudget,
	options: HybridPipelineOptions,
	timings?: PipelineTimings,
): Promise<HybridSearchResult> {
	const startTime = Date.now();
	const t = timings ?? emptyTimings();

	// 1. Embed the query
	const embedStart = Date.now();
	const queryVector = await options.embeddingProvider.embedOne(query);
	t.embeddingMs = Date.now() - embedStart;

	// 2. Pre-flight: check collection has data
	const collectionInfo = await getCollectionInfo(options.chromaClient);
	if (collectionInfo.count === 0) {
		console.warn(
			"[RAG] ChromaDB collection is empty — no embeddings have been indexed.",
		);
		return {
			answer:
				"No code embeddings found in the vector index. Please run `codex embed` first to index the codebase.",
			model: "n/a",
			anchors: [],
			referencedNodeIds: [],
			usage: { inputTokens: 0, outputTokens: 0 },
			durationMs: Date.now() - startTime,
		};
	}

	// 3. Vector search
	const vecStart = Date.now();
	const collection = await getOrCreateEntityCollection(options.chromaClient);
	const candidateCount = Math.min(Math.max(topK * 4, 12), 48);
	const candidates = await searchEntities(
		collection,
		queryVector,
		candidateCount,
	);
	const anchors = rerankAnchors(query, candidates, topK);
	t.vectorSearchMs = Date.now() - vecStart;

	if (anchors.length === 0) {
		// No results despite non-empty collection — likely a dimension mismatch or query issue
		console.warn(
			`[RAG] Vector search returned 0 results. queryVector.length=${queryVector.length}, collection.count=${collectionInfo.count}. ` +
				`This may indicate an embedding dimension mismatch. Re-run 'codex embed' with the same embedding provider used at query time.`,
		);
		const emptyContext = {
			text: `(No matching code entities found. The collection has ${collectionInfo.count} embeddings but the query vector (${queryVector.length} dims) returned no matches. This may be a dimension mismatch — try re-running \`codex embed\`.)`,
			referencedNodeIds: [],
			charCount: 200,
			wasTruncated: false,
		};
		const synthStart = Date.now();
		const synthesis = await synthesize(
			options.llmProvider,
			query,
			emptyContext,
		);
		t.synthesisMs = Date.now() - synthStart;
		return {
			answer: synthesis.answer,
			model: synthesis.model,
			anchors: [],
			referencedNodeIds: [],
			usage: synthesis.usage,
			durationMs: Date.now() - startTime,
		};
	}

	// 3. Graph expansion for each anchor
	const perAnchorBudget: ContextBudget = topK === 1 ? budget : "compact";
	const expansionOptions: ExpansionOptions = { budget: perAnchorBudget };

	const contextParts: string[] = [];
	const allReferencedNodeIds: string[] = [];

	const expandStart = Date.now();
	for (let i = 0; i < anchors.length; i++) {
		const anchor = anchors[i];
		if (!anchor) continue;

		const expanded = await expandContext(options.driver, anchor.nodeId);
		if (!expanded) continue;

		const assembled = assembleContext(expanded, expansionOptions);
		allReferencedNodeIds.push(...assembled.referencedNodeIds);

		const header =
			anchors.length > 1
				? `--- Result ${i + 1} of ${anchors.length} ---\n`
				: "";
		contextParts.push(header + assembled.text);
	}
	t.graphExpansionMs = Date.now() - expandStart;

	const assemblyStart = Date.now();
	const combinedText = contextParts.join("\n\n");
	const combinedContext = {
		text: combinedText,
		referencedNodeIds: allReferencedNodeIds,
		charCount: combinedText.length,
		wasTruncated: false,
	};
	t.assemblyMs = Date.now() - assemblyStart;

	// 4. LLM synthesis
	const synthStart = Date.now();
	const synthesis = await synthesize(
		options.llmProvider,
		query,
		combinedContext,
	);
	t.synthesisMs = Date.now() - synthStart;

	return {
		answer: synthesis.answer,
		model: synthesis.model,
		anchors,
		referencedNodeIds: [...new Set(allReferencedNodeIds)],
		usage: synthesis.usage,
		durationMs: Date.now() - startTime,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Social search
// ─────────────────────────────────────────────────────────────────────────────

const SOCIAL_SYSTEM_PROMPT = `You are CODEX, a code analysis assistant. You answer questions about developers and their contributions to a codebase based on git mining data (Degree of Authorship scores, commit history, file ownership).

Rules:
- Answer clearly and concisely in plain English.
- DOA (Degree of Authorship) scores range 0–1; higher means more ownership.
- "First author" means this developer made the first commit to that file.
- If asked who to contact about a file or module, recommend the developer with the highest DOA score.
- Do NOT hallucinate contributions not present in the data.`;

async function runSocialSearch(
	query: string,
	intent: Extract<QueryIntent, { kind: "social" }>,
	driver: Driver,
	llmProvider: LLMProvider,
): Promise<SocialSearchResult> {
	const session = driver.session({ database: "neo4j" });

	try {
		const nameFilter = intent.extractedName.trim();

		// Determine if the extracted name looks like a file/path reference or a person
		const looksLikeFile =
			nameFilter !== "" &&
			(nameFilter.includes(".") || nameFilter.includes("/"));

		// ── Developer query ──────────────────────────────────────────────────
		// Two paths:
		//   1. Direct match on developer name/email or file path (existing).
		//   2. Entity name → DEFINED_IN → File → HAS_EXPERTISE → Developer
		//      (handles "who should I ask about useShallow?" where nameFilter is
		//      an entity identifier, not a file path or person name).
		const devResult = await session.run(
			`
			MATCH (dev:Developer)-[exp:HAS_EXPERTISE]->(f:File)
			WHERE $name = ''
			   OR toLower(dev.name) CONTAINS toLower($name)
			   OR toLower(dev.email) CONTAINS toLower($name)
			   OR toLower(f.filePath) CONTAINS toLower($name)
			RETURN dev.name AS name, dev.email AS email,
			       exp.doaScore AS doaScore, exp.isFirstAuthor AS isFirstAuthor,
			       exp.lastContribution AS lastContribution,
			       f.filePath AS filePath

			UNION

			MATCH (entity)-[:DEFINED_IN]->(f:File)<-[exp:HAS_EXPERTISE]-(dev:Developer)
			WHERE $name <> ''
			  AND toLower(entity.name) = toLower($name)
			RETURN dev.name AS name, dev.email AS email,
			       exp.doaScore AS doaScore, exp.isFirstAuthor AS isFirstAuthor,
			       exp.lastContribution AS lastContribution,
			       f.filePath AS filePath
			`,
			{ name: nameFilter },
		);

		// Group rows by developer (one row per developer×file)
		const devMap = new Map<
			string,
			{
				name: string;
				email: string;
				isFirstAuthor: boolean;
				lastContribution: string | null;
				files: Array<{ path: string; doa: number }>;
			}
		>();
		for (const record of devResult.records) {
			const email = record.get("email") as string;
			if (!email) continue;
			const filePath = record.get("filePath") as string;
			const doa = (record.get("doaScore") as number | null) ?? 0;
			const existing = devMap.get(email);
			if (existing) {
				existing.files.push({ path: filePath, doa });
			} else {
				devMap.set(email, {
					name: record.get("name") as string,
					email,
					isFirstAuthor:
						(record.get("isFirstAuthor") as boolean | null) ?? false,
					lastContribution: record.get("lastContribution") as string | null,
					files: [{ path: filePath, doa }],
				});
			}
		}

		const developers = Array.from(devMap.values())
			.map((dev) => {
				const sorted = dev.files.sort((a, b) => b.doa - a.doa);
				const avgDoa =
					sorted.reduce((s, f) => s + f.doa, 0) / (sorted.length || 1);
				return {
					name: dev.name,
					email: dev.email,
					doaScore: avgDoa,
					isFirstAuthor: dev.isFirstAuthor,
					lastContribution: dev.lastContribution,
					topFiles: sorted.slice(0, 5).map((f) => f.path),
				};
			})
			.sort((a, b) => b.doaScore - a.doaScore);

		// ── Churn query ──────────────────────────────────────────────────────
		// Run for: empty name (hotspot queries), or file-centric names.
		// Skip for: person-centric names (e.g. "Alice") — dev query handles those.
		const files: FileChurnInfo[] = [];
		const runChurnQuery = nameFilter === "" || looksLikeFile;
		if (runChurnQuery) {
			const churnCypher = looksLikeFile
				? `MATCH (f:File) WHERE toLower(f.filePath) CONTAINS toLower($name)
				   AND f.totalCommits IS NOT NULL
				   RETURN f.filePath AS filePath, f.totalCommits AS totalCommits,
				          f.totalAdded AS totalAdded, f.totalDeleted AS totalDeleted,
				          f.churnRate AS churnRate
				   ORDER BY f.totalCommits DESC LIMIT 10`
				: `MATCH (f:File) WHERE f.totalCommits IS NOT NULL
				   RETURN f.filePath AS filePath, f.totalCommits AS totalCommits,
				          f.totalAdded AS totalAdded, f.totalDeleted AS totalDeleted,
				          f.churnRate AS churnRate
				   ORDER BY f.totalCommits DESC LIMIT 20`;
			const churnResult = await session.run(churnCypher, { name: nameFilter });
			for (const record of churnResult.records) {
				files.push({
					path: record.get("filePath") as string,
					totalCommits: (record.get("totalCommits") as number | null) ?? 0,
					totalAdded: (record.get("totalAdded") as number | null) ?? 0,
					totalDeleted: (record.get("totalDeleted") as number | null) ?? 0,
					churnRate: (record.get("churnRate") as number | null) ?? 0,
				});
			}
		}

		if (developers.length === 0 && files.length === 0) {
			const synthesis = await llmProvider.generate(
				[
					{ role: "system", content: SOCIAL_SYSTEM_PROMPT },
					{
						role: "user",
						content: `--- QUESTION ---\n${query}\n\nNo developer or file data was found in the graph. The user should run \`codex mine\` first.`,
					},
				],
				{ maxTokens: 256, temperature: 0.2 },
			);
			tokenTracker.add({
				llmInput: synthesis.usage.inputTokens,
				llmOutput: synthesis.usage.outputTokens,
			});
			return {
				query,
				developers: [],
				files: [],
				answer: synthesis.content,
				model: synthesis.model,
				usage: synthesis.usage,
			};
		}

		// ── Build LLM context ────────────────────────────────────────────────
		const contextParts: string[] = [];

		if (developers.length > 0) {
			const devLines = developers.map((dev) => {
				const fa = dev.isFirstAuthor ? " (first author)" : "";
				const last = dev.lastContribution
					? `, last contributed ${dev.lastContribution}`
					: "";
				return `- ${dev.name} <${dev.email}>${fa}: DOA score ${dev.doaScore.toFixed(3)}${last}, top files: ${dev.topFiles.join(", ")}`;
			});
			contextParts.push(
				`Developer expertise data from git history:\n${devLines.join("\n")}`,
			);
		}

		if (files.length > 0) {
			const fileLines = files.map(
				(f) =>
					`- ${f.path}: ${f.totalCommits} commits, +${f.totalAdded}/-${f.totalDeleted} lines, churn rate ${f.churnRate.toFixed(1)}/month`,
			);
			contextParts.push(
				`File churn data from git history:\n${fileLines.join("\n")}`,
			);
		}

		const context = contextParts.join("\n\n");

		const synthesis = await llmProvider.generate(
			[
				{ role: "system", content: SOCIAL_SYSTEM_PROMPT },
				{
					role: "user",
					content: `--- DATA ---\n${context}\n\n--- QUESTION ---\n${query}`,
				},
			],
			{ maxTokens: 512, temperature: 0.2 },
		);
		tokenTracker.add({
			llmInput: synthesis.usage.inputTokens,
			llmOutput: synthesis.usage.outputTokens,
		});

		return {
			query,
			developers,
			files,
			answer: synthesis.content,
			model: synthesis.model,
			usage: synthesis.usage,
		};
	} finally {
		await session.close();
	}
}
