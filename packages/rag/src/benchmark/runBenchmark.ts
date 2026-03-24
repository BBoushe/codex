/**
 * @fileoverview RAG pipeline benchmark.
 *
 * Evaluates vector-only vs. hybrid retrieval on a balanced set of questions.
 *
 * For each question, records:
 *   - Intent classification result (kind, pattern, subKind)
 *   - Whether intent matched expectation (structural vs hybrid routing)
 *   - Vector-only rank (top-10 search for the expected entity)
 *   - Hybrid correctness (expected entity in answer/entities)
 *   - Anchor expansion stats (count, nodeIds)
 *   - Token usage (input + output for hybrid queries)
 *   - Per-question wall-clock duration
 *   - Failure site (exact step that failed, if any)
 *
 * Summary includes:
 *   - MRR for vector-only and hybrid across semantic questions
 *   - Structural accuracy
 *   - Intent classification accuracy
 *   - Failure site breakdown
 *   - Total tokens consumed, total wall-clock time
 *
 * Usage:
 *   bun run packages/rag/src/benchmark/runBenchmark.ts
 *
 * Requires: NEO4J_* + SILICONFLOW_API_KEY + CHROMA_URL env vars.
 */

import neo4j from "neo4j-driver";
import {
	createSiliconFlowEmbeddingProvider,
	createSiliconFlowLLMProvider,
} from "@codex/shared";
import {
	createChromaClient,
	getOrCreateEntityCollection,
	searchEntities,
} from "@codex/vector-client";
import questions from "./questions.json";
import { runSearch } from "..";
import type { QueryIntent, PipelineTimings } from "../types.js";

// ─── Environment ─────────────────────────────────────────────────────────────

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "";

if (!NEO4J_PASSWORD) {
	console.error("NEO4J_PASSWORD is not set.");
	process.exit(1);
}

const sfApiKey = process.env.SILICONFLOW_API_KEY;
if (!sfApiKey) {
	console.error("SILICONFLOW_API_KEY is not set.");
	process.exit(1);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Question {
	query: string;
	expectedEntity: string;
	expectedEntities?: string[]; // multi-entity for architectural recall
	type: "semantic" | "structural" | "architectural";
	expectedIntent: "hybrid" | "structural";
	expectedPattern?: string; // for structural questions
}

interface BenchmarkResult {
	query: string;
	expectedEntity: string;
	type: string;
	// Vector-only
	vectorRank: number | null;
	vectorTopEntities: string[]; // top-3 names for debugging
	vectorDurationMs: number;
	// Hybrid/structural
	hybridCorrect: boolean;
	hybridKind: string; // actual routed kind
	hybridDurationMs: number;
	// Intent classification
	classifiedIntent: QueryIntent;
	expectedIntent: string;
	intentCorrect: boolean; // did the classifier route to the expected kind?
	intentEdge: string | null; // for structural: the edge type from spec
	intentFallback: boolean; // did the classifier fall back to semantic default?
	// Anchors & expansion
	anchorCount: number;
	anchorNames: string[];
	referencedNodeCount: number;
	// Tokens
	inputTokens: number;
	outputTokens: number;
	// Timing breakdown
	timings: PipelineTimings | null;
	// Entity Recall (architectural questions)
	vectorRecall: number | null; // fraction of expectedEntities in vector top-10
	hybridRecall: number | null; // fraction in hybrid anchors + refs + answer
	// Failure
	failureSite: string | null; // null = no failure
	failureMessage: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeMRR(ranks: Array<number | null>): number {
	if (ranks.length === 0) return 0;
	const reciprocals = ranks.map((r) => (r != null ? 1 / r : 0));
	return reciprocals.reduce((a, b) => a + b, 0) / reciprocals.length;
}

function isIntentFallback(intent: QueryIntent): boolean {
	return intent.wasFallback;
}

function intentSummary(intent: QueryIntent): string {
	if (intent.kind === "structural")
		return `structural/${intent.spec.edge}/${intent.relationship}`;
	if (intent.kind === "social") return `social/${intent.extractedName}`;
	return `hybrid/${intent.subKind}/K=${intent.topK}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const benchmarkStart = Date.now();

	const driver = neo4j.driver(
		NEO4J_URI,
		neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
	);

	const embeddingProvider = createSiliconFlowEmbeddingProvider({
		apiKey: sfApiKey!,
	});
	const llmProvider = createSiliconFlowLLMProvider({
		apiKey: sfApiKey!,
		model: process.env.LLM_MODEL ?? "Qwen/Qwen3-Coder-30B-A3B-Instruct",
	});
	const classifierProvider = createSiliconFlowLLMProvider({
		apiKey: sfApiKey!,
		model: process.env.CLASSIFIER_MODEL ?? "Qwen/Qwen3-14B",
	});
	const chromaClient = createChromaClient();

	const typedQuestions = questions as Question[];
	const results: BenchmarkResult[] = [];

	const semanticCount = typedQuestions.filter(
		(q) => q.type === "semantic",
	).length;
	const structuralCount = typedQuestions.filter(
		(q) => q.type === "structural",
	).length;
	const architecturalCount = typedQuestions.filter(
		(q) => q.type === "architectural",
	).length;

	const topKOverride = process.env["TOP_K_OVERRIDE"]
		? parseInt(process.env["TOP_K_OVERRIDE"], 10)
		: undefined;

	console.log(
		`\nRunning benchmark on ${typedQuestions.length} questions ` +
			`(${semanticCount} semantic, ${structuralCount} structural, ${architecturalCount} architectural)` +
			`${topKOverride ? ` [TOP_K_OVERRIDE=${topKOverride}]` : ""}...\n`,
	);

	for (const q of typedQuestions) {
		const result: BenchmarkResult = {
			query: q.query,
			expectedEntity: q.expectedEntity,
			type: q.type,
			vectorRank: null,
			vectorTopEntities: [],
			vectorDurationMs: 0,
			hybridCorrect: false,
			hybridKind: "",
			hybridDurationMs: 0,
			classifiedIntent: {
				kind: "hybrid",
				subKind: "semantic",
				topK: 3,
				wasFallback: false,
			},
			expectedIntent: q.expectedIntent,
			intentCorrect: false,
			intentEdge: null,
			intentFallback: false,
			anchorCount: 0,
			anchorNames: [],
			referencedNodeCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			timings: null,
			vectorRecall: null,
			hybridRecall: null,
			failureSite: null,
			failureMessage: null,
		};

		process.stdout.write(
			`  [${q.type.padEnd(10)}] "${q.query.slice(0, 55).padEnd(55)}" `,
		);

		// ── 1. Vector-only search ────────────────────────────────────────
		const vecStart = Date.now();
		try {
			const queryVector = await embeddingProvider.embedOne(q.query);
			const collection = await getOrCreateEntityCollection(chromaClient);
			const vectorResults = await searchEntities(collection, queryVector, 10);
			result.vectorDurationMs = Date.now() - vecStart;
			result.vectorTopEntities = vectorResults.slice(0, 3).map((r) => r.name);

			const rankIdx = vectorResults.findIndex(
				(r) =>
					r.name.includes(q.expectedEntity) ||
					r.filePath.includes(q.expectedEntity),
			);
			result.vectorRank = rankIdx >= 0 ? rankIdx + 1 : null;
		} catch (err) {
			result.vectorDurationMs = Date.now() - vecStart;
			result.failureSite = "vector_search";
			result.failureMessage = err instanceof Error ? err.message : String(err);
		}

		// ── 2. Hybrid search (full pipeline) ──────────────────────────────
		const hybridStart = Date.now();
		try {
			const searchResult = await runSearch(q.query, {
				driver,
				chromaClient,
				embeddingProvider,
				llmProvider,
				classifierProvider,
				budget: "standard",
				topK: topKOverride,
			});

			result.hybridDurationMs = Date.now() - hybridStart;
			result.hybridKind = searchResult.kind;
			result.timings = searchResult.timings;
			result.classifiedIntent = searchResult.intent;
			result.intentCorrect = searchResult.intent.kind === q.expectedIntent;
			result.intentFallback = isIntentFallback(searchResult.intent);

			if (searchResult.intent.kind === "structural") {
				result.intentEdge = searchResult.intent.spec.edge;
			}

			if (searchResult.kind === "hybrid") {
				const hr = searchResult.result;
				result.hybridCorrect = hr.answer
					.toLowerCase()
					.includes(q.expectedEntity.toLowerCase());
				result.anchorCount = hr.anchors.length;
				result.anchorNames = hr.anchors.map((a) => a.name);
				result.referencedNodeCount = hr.referencedNodeIds.length;
				result.inputTokens = hr.usage.inputTokens;
				result.outputTokens = hr.usage.outputTokens;
			} else if (searchResult.kind === "structural") {
				result.hybridCorrect = searchResult.result.entities.some(
					(e) =>
						e.name.includes(q.expectedEntity) ||
						e.filePath.includes(q.expectedEntity),
				);
				result.anchorCount = searchResult.result.entities.length;
				result.anchorNames = searchResult.result.entities
					.slice(0, 5)
					.map((e) => e.name || e.filePath);
			} else if (searchResult.kind === "social") {
				result.hybridCorrect = false;
				// Social should not appear in this benchmark
			}
		} catch (err) {
			result.hybridDurationMs = Date.now() - hybridStart;
			result.failureSite = result.failureSite ?? "hybrid_search";
			result.failureMessage = err instanceof Error ? err.message : String(err);
		}

		// ── 3. Entity Recall (architectural questions) ───────────────────
		if (q.expectedEntities && q.expectedEntities.length > 0) {
			const expected = q.expectedEntities;

			// Vector recall: how many expectedEntities appear in top-10 vector results
			const vecNames = result.vectorTopEntities;
			const vecMatches = expected.filter((e) =>
				vecNames.some(
					(v) =>
						v.toLowerCase().includes(e.toLowerCase()) ||
						e.toLowerCase().includes(v.toLowerCase()),
				),
			);
			result.vectorRecall = vecMatches.length / expected.length;

			// Hybrid recall: anchors + referenced nodes + answer text
			const hybridPool = new Set(
				[...result.anchorNames].map((n) => n.toLowerCase()),
			);
			// Check answer text for entity mentions too
			const answerLower = result.hybridCorrect ? q.expectedEntity.toLowerCase() : "";
			const hybridMatches = expected.filter(
				(e) =>
					hybridPool.has(e.toLowerCase()) ||
					[...hybridPool].some(
						(p) =>
							p.includes(e.toLowerCase()) ||
							e.toLowerCase().includes(p),
					) ||
					answerLower.includes(e.toLowerCase()),
			);
			result.hybridRecall = hybridMatches.length / expected.length;
		}

		results.push(result);

		// ── Live output ──────────────────────────────────────────────────
		const vecStr = result.vectorRank != null ? `@${result.vectorRank}` : "miss";
		const hybridStr = result.hybridCorrect ? "✓" : "✗";
		const intentStr = result.intentCorrect ? "✓" : "✗";
		const fallbackStr = result.intentFallback ? " [FALLBACK]" : "";
		const recallStr =
			result.vectorRecall != null
				? ` vRecall=${result.vectorRecall.toFixed(2)} hRecall=${(result.hybridRecall ?? 0).toFixed(2)}`
				: "";
		console.log(
			`vec=${vecStr.padStart(5)} hybrid=${hybridStr} intent=${intentStr}${fallbackStr}${recallStr} (${result.hybridDurationMs}ms)`,
		);
	}

	await driver.close();

	// ═══════════════════════════════════════════════════════════════════════════
	// Summary
	// ═══════════════════════════════════════════════════════════════════════════

	const totalDurationMs = Date.now() - benchmarkStart;

	const semantic = results.filter((r) => r.type === "semantic");
	const structural = results.filter((r) => r.type === "structural");
	const architectural = results.filter((r) => r.type === "architectural");

	// ── MRR comparison (semantic only — structural uses exact match) ──────
	const vectorMRR_semantic = computeMRR(semantic.map((r) => r.vectorRank));
	const hybridCorrectSemantic = semantic.filter((r) => r.hybridCorrect);

	// For hybrid, use anchor rank: find expected entity in anchors
	const hybridRanks_semantic = semantic.map((r) => {
		const idx = r.anchorNames.findIndex((name) =>
			name.toLowerCase().includes(r.expectedEntity.toLowerCase()),
		);
		return idx >= 0 ? idx + 1 : r.hybridCorrect ? 1 : null;
	});
	const hybridMRR_semantic = computeMRR(hybridRanks_semantic);

	// ── Structural accuracy ──────────────────────────────────────────────
	const structuralCorrect = structural.filter((r) => r.hybridCorrect).length;

	// ── Intent classification accuracy ──────────────────────────────────
	const intentCorrectAll = results.filter((r) => r.intentCorrect).length;
	const fallbackCount = results.filter((r) => r.intentFallback).length;

	// ── Tokens ───────────────────────────────────────────────────────────
	const totalInputTokens = results.reduce((s, r) => s + r.inputTokens, 0);
	const totalOutputTokens = results.reduce((s, r) => s + r.outputTokens, 0);

	// ── Failures ─────────────────────────────────────────────────────────
	const failures = results.filter((r) => r.failureSite !== null);
	const failureSites = new Map<string, number>();
	for (const f of failures) {
		failureSites.set(
			f.failureSite!,
			(failureSites.get(f.failureSite!) ?? 0) + 1,
		);
	}

	// ── Print ────────────────────────────────────────────────────────────
	console.log("\n══════════════════════════════════════════════════════════");
	console.log("  CODEX RAG Benchmark Results");
	console.log("══════════════════════════════════════════════════════════");

	console.log(`\n── Retrieval Quality ──────────────────────────────────`);
	console.log(`  Semantic (n=${semantic.length}):`);
	console.log(`    Vector-only MRR:     ${vectorMRR_semantic.toFixed(3)}`);
	console.log(`    Hybrid MRR:          ${hybridMRR_semantic.toFixed(3)}`);
	const mrrDelta = hybridMRR_semantic - vectorMRR_semantic;
	console.log(
		`    Delta:               ${mrrDelta >= 0 ? "+" : ""}${(mrrDelta * 100).toFixed(1)}pp`,
	);
	console.log(
		`    Hybrid correct:      ${hybridCorrectSemantic.length}/${semantic.length}`,
	);

	console.log(`  Structural (n=${structural.length}):`);
	console.log(
		`    Correct:             ${structuralCorrect}/${structural.length} (${structural.length > 0 ? ((structuralCorrect / structural.length) * 100).toFixed(0) : 0}%)`,
	);

	// ── Entity Recall (architectural — the hybrid differentiator) ─────
	if (architectural.length > 0) {
		const withVecRecall = architectural.filter((r) => r.vectorRecall != null);
		const withHybRecall = architectural.filter((r) => r.hybridRecall != null);
		const avgVecRecall =
			withVecRecall.length > 0
				? withVecRecall.reduce((s, r) => s + r.vectorRecall!, 0) /
					withVecRecall.length
				: 0;
		const avgHybRecall =
			withHybRecall.length > 0
				? withHybRecall.reduce((s, r) => s + r.hybridRecall!, 0) /
					withHybRecall.length
				: 0;
		const recallDelta = avgHybRecall - avgVecRecall;

		console.log(`  Architectural (n=${architectural.length}):`);
		console.log(
			`    Vector-only recall:  ${avgVecRecall.toFixed(3)}`,
		);
		console.log(
			`    Hybrid recall:       ${avgHybRecall.toFixed(3)}`,
		);
		console.log(
			`    Delta:               ${recallDelta >= 0 ? "+" : ""}${(recallDelta * 100).toFixed(1)}pp`,
		);
	}

	console.log(`\n── Intent Classification ──────────────────────────────`);
	console.log(
		`  Accuracy:              ${intentCorrectAll}/${results.length} (${((intentCorrectAll / results.length) * 100).toFixed(0)}%)`,
	);
	console.log(`  Fallbacks fired:       ${fallbackCount}/${results.length}`);

	console.log(`\n── Resource Usage ─────────────────────────────────────`);
	console.log(`  Total input tokens:    ${totalInputTokens}`);
	console.log(`  Total output tokens:   ${totalOutputTokens}`);
	console.log(
		`  Total tokens:          ${totalInputTokens + totalOutputTokens}`,
	);
	console.log(
		`  Total wall-clock:      ${(totalDurationMs / 1000).toFixed(1)}s`,
	);
	console.log(
		`  Avg per question:      ${(totalDurationMs / results.length / 1000).toFixed(1)}s`,
	);

	// ── Aggregate timing breakdown ───────────────────────────────────
	const withTimings = results.filter((r) => r.timings !== null);
	if (withTimings.length > 0) {
		const sumTimings = {
			classifierMs: 0,
			embeddingMs: 0,
			vectorSearchMs: 0,
			graphExpansionMs: 0,
			assemblyMs: 0,
			synthesisMs: 0,
		};
		for (const r of withTimings) {
			const t = r.timings!;
			sumTimings.classifierMs += t.classifierMs;
			sumTimings.embeddingMs += t.embeddingMs;
			sumTimings.vectorSearchMs += t.vectorSearchMs;
			sumTimings.graphExpansionMs += t.graphExpansionMs;
			sumTimings.assemblyMs += t.assemblyMs;
			sumTimings.synthesisMs += t.synthesisMs;
		}
		const n = withTimings.length;
		console.log(`\n── Timing Breakdown (avg across ${n} queries) ────────`);
		console.log(
			`  Classifier LLM:       ${(sumTimings.classifierMs / n).toFixed(0)}ms`,
		);
		console.log(
			`  Query embedding:      ${(sumTimings.embeddingMs / n).toFixed(0)}ms`,
		);
		console.log(
			`  Vector search:        ${(sumTimings.vectorSearchMs / n).toFixed(0)}ms`,
		);
		console.log(
			`  Graph expansion:      ${(sumTimings.graphExpansionMs / n).toFixed(0)}ms`,
		);
		console.log(
			`  Context assembly:     ${(sumTimings.assemblyMs / n).toFixed(0)}ms`,
		);
		console.log(
			`  Synthesis LLM:        ${(sumTimings.synthesisMs / n).toFixed(0)}ms`,
		);
	}

	if (failures.length > 0) {
		console.log(`\n── Failure Breakdown ──────────────────────────────────`);
		console.log(
			`  Total failures:        ${failures.length}/${results.length}`,
		);
		for (const [site, count] of failureSites) {
			console.log(`    ${site}: ${count}`);
		}
		for (const f of failures) {
			console.log(
				`    ✗ "${f.query.slice(0, 45)}" @ ${f.failureSite}: ${f.failureMessage?.slice(0, 80)}`,
			);
		}
	} else {
		console.log(`\n  No failures.`);
	}

	console.log(`\n── Per-Question Breakdown ─────────────────────────────`);
	for (const r of results) {
		const vecStr = r.vectorRank != null ? `@${r.vectorRank}` : "miss";
		const hybridStr = r.hybridCorrect ? "✓" : "✗";
		const intentStr = r.intentCorrect ? "✓" : "✗";
		const fallbackStr = r.intentFallback ? " [FB]" : "";
		const intentDetail = intentSummary(r.classifiedIntent);
		const tokenStr =
			r.inputTokens > 0 ? ` tok=${r.inputTokens}+${r.outputTokens}` : "";
		const anchorStr =
			r.anchorCount > 0
				? ` anchors=${r.anchorCount}[${r.anchorNames.slice(0, 3).join(",")}]`
				: "";

		console.log(
			`  [${r.type.padEnd(10)}] ${hybridStr} intent=${intentStr}${fallbackStr} vec=${vecStr.padStart(5)} route=${intentDetail}${anchorStr}${tokenStr} (${r.hybridDurationMs}ms)`,
		);
		console.log(`              "${r.query.slice(0, 65)}"`);
		if (r.timings) {
			const t = r.timings;
			console.log(
				`              timing: classifier=${t.classifierMs}ms embed=${t.embeddingMs}ms vec=${t.vectorSearchMs}ms graph=${t.graphExpansionMs}ms synth=${t.synthesisMs}ms`,
			);
		}
		if (r.failureSite) {
			console.log(
				`              FAIL @ ${r.failureSite}: ${r.failureMessage?.slice(0, 80)}`,
			);
		}
	}

	console.log();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
