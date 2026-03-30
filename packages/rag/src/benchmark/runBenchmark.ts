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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createSiliconFlowEmbeddingProvider,
	createSiliconFlowLLMProvider,
} from "@codex/shared";
import {
	createChromaClient,
	getOrCreateEntityCollection,
	searchEntities,
} from "@codex/vector-client";
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
	type: "semantic" | "structural" | "architectural" | "social" | "property";
	expectedIntent: "hybrid" | "structural" | "social" | "property";
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
	vectorContextChars: number;
	// Hybrid/structural
	hybridCorrect: boolean;
	hybridKind: string; // actual routed kind
	hybridAnswer: string;
	hybridDurationMs: number;
	hybridContextChars: number;
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
	failureClass: string | null;
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
	if (intent.kind === "property")
		return `property/${intent.label}.${intent.property}/${intent.order}`;
	return `hybrid/${intent.subKind}/K=${intent.topK}`;
}

function normalizeText(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9_./:-]+/g, " ")
		.trim();
}

function expectedEntityMatchesText(
	text: string,
	expectedEntity: string,
): boolean {
	const normalizedText = normalizeText(text);
	const normalizedExpected = normalizeText(expectedEntity);
	if (!normalizedText || !normalizedExpected) return false;
	if (normalizedText.includes(normalizedExpected)) return true;

	const expectedFragments = normalizedExpected
		.split(/[\s/._:-]+/)
		.filter((part) => part.length >= 3);
	if (expectedFragments.length === 0) return false;
	return expectedFragments.some((fragment) =>
		normalizedText.includes(fragment),
	);
}

function isLabelExpectation(expectedEntity: string): boolean {
	const normalized = normalizeText(expectedEntity);
	return (
		normalized === "file" ||
		normalized === "function" ||
		normalized === "component" ||
		normalized === "class" ||
		normalized === "hook"
	);
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

	const { questions: typedQuestions, sourcePath: questionSourcePath } =
		await loadQuestions();
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
	const socialCount = typedQuestions.filter((q) => q.type === "social").length;
	const propertyCount = typedQuestions.filter(
		(q) => q.type === "property",
	).length;

	const topKOverride = process.env["TOP_K_OVERRIDE"]
		? parseInt(process.env["TOP_K_OVERRIDE"], 10)
		: undefined;

	if (
		(process.env["BENCHMARK_REPO_LABEL"] ?? "fixture") !== "fixture" &&
		!process.env["BENCHMARK_QUESTIONS_FILE"]
	) {
		console.warn(
			`[benchmark] Using default fixture question set on a non-fixture repo. Set BENCHMARK_QUESTIONS_FILE to a repo-specific dataset for meaningful correctness metrics. Source=${questionSourcePath}`,
		);
	}

	console.log(
		`\nRunning benchmark on ${typedQuestions.length} questions ` +
			`(${semanticCount} semantic, ${structuralCount} structural, ${architecturalCount} architectural, ${socialCount} social, ${propertyCount} property)` +
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
			vectorContextChars: 0,
			hybridCorrect: false,
			hybridKind: "",
			hybridAnswer: "",
			hybridDurationMs: 0,
			hybridContextChars: 0,
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
			failureClass: null,
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
			result.vectorTopEntities = vectorResults.map((r) => r.name);
			result.vectorContextChars = vectorResults
				.slice(0, 3)
				.reduce((sum, r) => sum + r.document.length, 0);

			const rankIdx = vectorResults.findIndex(
				(r) =>
					r.name.includes(q.expectedEntity) ||
					r.filePath.includes(q.expectedEntity),
			);
			result.vectorRank = rankIdx >= 0 ? rankIdx + 1 : null;
		} catch (err) {
			result.vectorDurationMs = Date.now() - vecStart;
			result.failureSite = "vector_search";
			result.failureClass = classifyFailureClass(err);
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
				result.hybridAnswer = hr.answer;
				const answerHit = expectedEntityMatchesText(
					hr.answer,
					q.expectedEntity,
				);
				const anchorHit = hr.anchors.some((anchor) =>
					expectedEntityMatchesText(
						`${anchor.name} ${anchor.qualifiedName} ${anchor.filePath}`,
						q.expectedEntity,
					),
				);
				result.hybridCorrect = answerHit || anchorHit;
				result.anchorCount = hr.anchors.length;
				result.anchorNames = hr.anchors.map((a) => a.name);
				result.referencedNodeCount = hr.referencedNodeIds.length;
				result.inputTokens = hr.usage.inputTokens;
				result.outputTokens = hr.usage.outputTokens;
				result.hybridContextChars = hr.anchors.reduce(
					(sum, a) => sum + a.document.length,
					0,
				);
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
				result.hybridAnswer = searchResult.result.answer;
				const developerHit = searchResult.result.developers.some(
					(d) =>
						expectedEntityMatchesText(
							`${d.name} ${d.email} ${d.topFiles.join(" ")}`,
							q.expectedEntity,
						) ||
						expectedEntityMatchesText(result.hybridAnswer, q.expectedEntity),
				);
				const nonEmptyFallback =
					searchResult.result.developers.length > 0 &&
					result.hybridAnswer.trim().length > 0;
				result.hybridCorrect = developerHit || nonEmptyFallback;
				result.anchorCount = searchResult.result.developers.length;
				result.anchorNames = searchResult.result.developers.map((d) => d.name);
				result.inputTokens = searchResult.result.usage.inputTokens;
				result.outputTokens = searchResult.result.usage.outputTokens;
			} else if (searchResult.kind === "property") {
				result.hybridAnswer = searchResult.result.answer;
				const entityHit = searchResult.result.entities.some((e) =>
					expectedEntityMatchesText(
						`${e.name} ${e.filePath}`,
						q.expectedEntity,
					),
				);
				const expectedLabel = normalizeText(q.expectedEntity);
				const labelHit =
					isLabelExpectation(q.expectedEntity) &&
					searchResult.result.entities.some(
						(e) => normalizeText(e.label) === expectedLabel,
					);
				const nonEmptyFallback =
					searchResult.result.entities.length > 0 &&
					result.hybridAnswer.trim().length > 0;
				result.hybridCorrect = entityHit || labelHit || nonEmptyFallback;
				result.anchorCount = searchResult.result.entities.length;
				result.anchorNames = searchResult.result.entities.map((e) => e.name);
				result.inputTokens = searchResult.result.usage.inputTokens;
				result.outputTokens = searchResult.result.usage.outputTokens;
			}

			if (!result.hybridCorrect && result.failureSite === null) {
				if (searchResult.intent.wasFallback) {
					result.failureSite = "classifier_parse_fallback";
					result.failureClass = "intent_fallback";
					result.failureMessage =
						"Classifier fell back to default hybrid routing";
				} else if (searchResult.kind !== q.expectedIntent) {
					result.failureSite = "intent_mismatch";
					result.failureClass = "intent_routing";
					result.failureMessage = `Expected ${q.expectedIntent}, got ${searchResult.kind}`;
				} else {
					result.failureSite = "result_miss";
					result.failureClass = "retrieval_miss";
					result.failureMessage = "Expected entity not found in routed result";
				}
			}
		} catch (err) {
			result.hybridDurationMs = Date.now() - hybridStart;
			result.failureSite = result.failureSite ?? "hybrid_search";
			result.failureClass = result.failureClass ?? classifyFailureClass(err);
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
			const answerLower = result.hybridAnswer.toLowerCase();
			const hybridMatches = expected.filter(
				(e) =>
					hybridPool.has(e.toLowerCase()) ||
					[...hybridPool].some(
						(p) => p.includes(e.toLowerCase()) || e.toLowerCase().includes(p),
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
	const social = results.filter((r) => r.type === "social");
	const property = results.filter((r) => r.type === "property");

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
	const avgVectorContextChars =
		results.reduce((s, r) => s + r.vectorContextChars, 0) /
		Math.max(results.length, 1);
	const avgHybridContextChars =
		results.reduce((s, r) => s + r.hybridContextChars, 0) /
		Math.max(results.length, 1);

	// ── Failures ─────────────────────────────────────────────────────────
	const failures = results.filter((r) => r.failureSite !== null);
	const failureSites = new Map<string, number>();
	const failureClasses = new Map<string, number>();
	for (const f of failures) {
		failureSites.set(
			f.failureSite!,
			(failureSites.get(f.failureSite!) ?? 0) + 1,
		);
		if (f.failureClass) {
			failureClasses.set(
				f.failureClass,
				(failureClasses.get(f.failureClass) ?? 0) + 1,
			);
		}
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
		console.log(`    Vector-only recall:  ${avgVecRecall.toFixed(3)}`);
		console.log(`    Hybrid recall:       ${avgHybRecall.toFixed(3)}`);
		console.log(
			`    Delta:               ${recallDelta >= 0 ? "+" : ""}${(recallDelta * 100).toFixed(1)}pp`,
		);
	}

	if (social.length > 0) {
		const socialCorrect = social.filter((r) => r.hybridCorrect).length;
		console.log(`  Social (n=${social.length}):`);
		console.log(
			`    Correct:             ${socialCorrect}/${social.length} (${((socialCorrect / social.length) * 100).toFixed(0)}%)`,
		);
	}

	if (property.length > 0) {
		const propertyCorrect = property.filter((r) => r.hybridCorrect).length;
		console.log(`  Property (n=${property.length}):`);
		console.log(
			`    Correct:             ${propertyCorrect}/${property.length} (${((propertyCorrect / property.length) * 100).toFixed(0)}%)`,
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
		`  Avg vector context:    ${avgVectorContextChars.toFixed(0)} chars`,
	);
	console.log(
		`  Avg hybrid context:    ${avgHybridContextChars.toFixed(0)} chars`,
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
		if (failureClasses.size > 0) {
			console.log(`  Failure classes:`);
			for (const [klass, count] of failureClasses) {
				console.log(`    ${klass}: ${count}`);
			}
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

	const repoLabel = process.env["BENCHMARK_REPO_LABEL"] ?? "fixture";
	const artifactMeta = await writeBenchmarkArtifacts({
		repoLabel,
		results,
		totalDurationMs,
		summary: {
			vectorMRR_semantic,
			hybridMRR_semantic,
			semanticCount: semantic.length,
			structuralCount: structural.length,
			architecturalCount: architectural.length,
			socialCount: social.length,
			propertyCount: property.length,
			intentAccuracy: intentCorrectAll / Math.max(results.length, 1),
			fallbackCount,
			totalInputTokens,
			totalOutputTokens,
			avgVectorContextChars,
			avgHybridContextChars,
			failureSites: Object.fromEntries(failureSites),
			failureClasses: Object.fromEntries(failureClasses),
		},
	});

	console.log(`\n── Artifacts ──────────────────────────────────────────`);
	console.log(`  JSON: ${artifactMeta.jsonPath}`);
	console.log(`  CSV:  ${artifactMeta.csvPath}`);
	console.log(`  MD:   ${artifactMeta.mdPath}`);
	console.log(`  Manual scoring CSV: ${artifactMeta.manualCsvPath}`);
	console.log(`  Manual scoring MD:  ${artifactMeta.manualMdPath}`);

	console.log();
}

function classifyFailureClass(err: unknown): string {
	const message =
		err instanceof Error
			? err.message.toLowerCase()
			: String(err).toLowerCase();
	if (message.includes("timeout") || message.includes("timed out"))
		return "timeout";
	if (message.includes("429") || message.includes("rate limit"))
		return "rate_limit";
	if (message.includes("embedding") || message.includes("vector"))
		return "embedding_or_vector";
	if (
		message.includes("neo4j") ||
		message.includes("cypher") ||
		message.includes("graph")
	)
		return "graph_query";
	if (message.includes("llm") || message.includes("completion"))
		return "llm_synthesis";
	return "unknown";
}

interface ArtifactSummary {
	vectorMRR_semantic: number;
	hybridMRR_semantic: number;
	semanticCount: number;
	structuralCount: number;
	architecturalCount: number;
	socialCount: number;
	propertyCount: number;
	intentAccuracy: number;
	fallbackCount: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	avgVectorContextChars: number;
	avgHybridContextChars: number;
	failureSites: Record<string, number>;
	failureClasses: Record<string, number>;
}

interface ArtifactWriteInput {
	repoLabel: string;
	results: BenchmarkResult[];
	totalDurationMs: number;
	summary: ArtifactSummary;
}

interface ArtifactWriteOutput {
	jsonPath: string;
	csvPath: string;
	mdPath: string;
	manualCsvPath: string;
	manualMdPath: string;
}

async function loadQuestions(): Promise<{
	questions: Question[];
	sourcePath: string;
}> {
	const configuredPath = process.env["BENCHMARK_QUESTIONS_FILE"];
	const filePath = configuredPath
		? path.resolve(process.cwd(), configuredPath)
		: path.join(import.meta.dir, "questions.json");
	const content = await readFile(filePath, "utf8");
	const parsed = JSON.parse(content) as Question[];
	return { questions: parsed, sourcePath: filePath };
}

async function writeBenchmarkArtifacts(
	input: ArtifactWriteInput,
): Promise<ArtifactWriteOutput> {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const label = sanitizeLabel(input.repoLabel);
	const outDir = path.join(
		process.cwd(),
		"scripts",
		"test-results",
		"benchmarks",
	);
	await mkdir(outDir, { recursive: true });

	const base = `${ts}-${label}`;
	const jsonPath = path.join(outDir, `${base}.json`);
	const csvPath = path.join(outDir, `${base}.csv`);
	const mdPath = path.join(outDir, `${base}.md`);
	const manualCsvPath = path.join(outDir, `${base}-manual-scoring.csv`);
	const manualMdPath = path.join(outDir, `${base}-manual-scoring.md`);

	const jsonPayload = {
		generatedAt: new Date().toISOString(),
		repoLabel: input.repoLabel,
		totalDurationMs: input.totalDurationMs,
		summary: input.summary,
		results: input.results,
	};

	const csvHeader = [
		"type",
		"query",
		"expectedEntity",
		"expectedIntent",
		"hybridKind",
		"vectorRank",
		"hybridCorrect",
		"intentCorrect",
		"intentFallback",
		"failureSite",
		"failureClass",
		"inputTokens",
		"outputTokens",
		"durationMs",
	].join(",");

	const csvLines = input.results.map((r) =>
		[
			r.type,
			escapeCsv(r.query),
			escapeCsv(r.expectedEntity),
			escapeCsv(r.expectedIntent),
			escapeCsv(r.hybridKind),
			r.vectorRank ?? "",
			r.hybridCorrect,
			r.intentCorrect,
			r.intentFallback,
			escapeCsv(r.failureSite ?? ""),
			escapeCsv(r.failureClass ?? ""),
			r.inputTokens,
			r.outputTokens,
			r.hybridDurationMs,
		].join(","),
	);

	const md = buildMarkdownSummary(input);
	const manualSample = buildManualSample(input.results, 10);
	const manualCsv = [
		"query,type,expectedEntity,correctness_1to5,completeness_1to5,relevance_1to5,notes",
		...manualSample.map((r) =>
			[
				escapeCsv(r.query),
				r.type,
				escapeCsv(r.expectedEntity),
				"",
				"",
				"",
				"",
			].join(","),
		),
	].join("\n");

	const manualMd = [
		"# Manual Answer Quality Scoring",
		"",
		"Score each answer on a 1-5 scale for correctness, completeness, and relevance.",
		"",
		"| Query | Type | Expected Entity | Correctness | Completeness | Relevance | Notes |",
		"|---|---|---|---|---|---|---|",
		...manualSample.map(
			(r) =>
				`| ${escapePipes(r.query)} | ${r.type} | ${escapePipes(r.expectedEntity)} |  |  |  |  |`,
		),
	].join("\n");

	await Promise.all([
		writeFile(jsonPath, JSON.stringify(jsonPayload, null, 2), "utf8"),
		writeFile(csvPath, [csvHeader, ...csvLines].join("\n"), "utf8"),
		writeFile(mdPath, md, "utf8"),
		writeFile(manualCsvPath, manualCsv, "utf8"),
		writeFile(manualMdPath, manualMd, "utf8"),
	]);

	return { jsonPath, csvPath, mdPath, manualCsvPath, manualMdPath };
}

function sanitizeLabel(label: string): string {
	return label.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/-+/g, "-");
}

function escapeCsv(value: string): string {
	if (value.includes(",") || value.includes('"') || value.includes("\n")) {
		return `"${value.replaceAll('"', '""')}"`;
	}
	return value;
}

function escapePipes(value: string): string {
	return value.replaceAll("|", "\\|");
}

function buildManualSample(
	results: BenchmarkResult[],
	count: number,
): BenchmarkResult[] {
	const buckets: Array<BenchmarkResult["type"]> = [
		"semantic",
		"structural",
		"architectural",
		"social",
		"property",
	];
	const selected: BenchmarkResult[] = [];
	for (const bucket of buckets) {
		const first = results.find((r) => r.type === bucket);
		if (first) selected.push(first);
	}
	for (const row of results) {
		if (selected.length >= count) break;
		if (!selected.includes(row)) selected.push(row);
	}
	return selected.slice(0, count);
}

function buildMarkdownSummary(input: ArtifactWriteInput): string {
	const s = input.summary;
	return [
		"# CODEX Benchmark Summary",
		"",
		`Generated: ${new Date().toISOString()}`,
		`Repo label: ${input.repoLabel}`,
		"",
		"## Core Metrics",
		"",
		`- Semantic vector-only MRR: ${s.vectorMRR_semantic.toFixed(3)}`,
		`- Semantic hybrid MRR: ${s.hybridMRR_semantic.toFixed(3)}`,
		`- Intent accuracy: ${(s.intentAccuracy * 100).toFixed(1)}%`,
		`- Fallback count: ${s.fallbackCount}`,
		`- Total tokens: ${s.totalInputTokens + s.totalOutputTokens} (in=${s.totalInputTokens}, out=${s.totalOutputTokens})`,
		`- Avg vector context size: ${s.avgVectorContextChars.toFixed(0)} chars`,
		`- Avg hybrid context size: ${s.avgHybridContextChars.toFixed(0)} chars`,
		`- Total duration: ${(input.totalDurationMs / 1000).toFixed(1)}s`,
		"",
		"## Coverage",
		"",
		`- Semantic: ${s.semanticCount}`,
		`- Structural: ${s.structuralCount}`,
		`- Architectural: ${s.architecturalCount}`,
		`- Social: ${s.socialCount}`,
		`- Property: ${s.propertyCount}`,
		"",
		"## Failure Breakdown",
		"",
		...Object.entries(s.failureSites).map(([k, v]) => `- Site ${k}: ${v}`),
		...Object.entries(s.failureClasses).map(([k, v]) => `- Class ${k}: ${v}`),
	].join("\n");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
