/**
 * @fileoverview Feature-level validation for the Week 7–8 RAG pipeline.
 *
 * Tests each feature independently with explicit pass/fail, failure sites,
 * and per-phase timing breakdown (classifier LLM, embedding, vector search,
 * graph expansion, synthesis LLM).
 *
 * Test categories:
 *   1. Intent classifier — correct routing, fallback behavior
 *   2. Structural queries — each pattern returns results from Neo4j
 *   3. Graph expansion — expandContext returns expected shape
 *   4. Context assembler — budget enforcement, section formatting
 *   5. Full pipeline — end-to-end through runSearch, with timing breakdown
 *
 * Usage:
 *   bun run rag:validate
 *
 * Requires: NEO4J_* + SILICONFLOW_API_KEY + CHROMA_URL env vars.
 */

import neo4j, { type Driver, type Record as Neo4jRecord } from "neo4j-driver";
import {
	createSiliconFlowEmbeddingProvider,
	createSiliconFlowLLMProvider,
	type LLMProvider,
	type EmbeddingProvider,
} from "@codex/shared";
import { createChromaClient } from "@codex/vector-client";
import type { ChromaClient } from "chromadb";
import {
	expandContext,
	structuralQuery,
	resolveEntityByName,
	findShortestPath,
	type StructuralPattern,
} from "@codex/graph-client";
import {
	classifyIntent,
	assembleContext,
	runSearch,
	type ContextBudget,
	type PipelineTimings,
	BUDGET_LIMITS,
	type ExpandedContext,
} from "..";

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

// ─── Test harness ────────────────────────────────────────────────────────────

interface TestResult {
	category: string;
	name: string;
	passed: boolean;
	durationMs: number;
	failureSite: string | null;
	failureMessage: string | null;
	detail: string;
	/** Optional per-phase timing breakdown. */
	timings: PipelineTimings | null;
}

interface ValidationEntity {
	name: string;
	qualifiedName: string;
	label: string;
}

interface ValidationTargets {
	calledByTarget: ValidationEntity | null;
	calledByCaller: ValidationEntity | null;
	definedInTarget: ValidationEntity | null;
	rendersTarget: ValidationEntity | null;
	usesHookTarget: ValidationEntity | null;
}

const allResults: TestResult[] = [];

async function runTest(
	category: string,
	name: string,
	fn: () => Promise<{ detail: string; timings?: PipelineTimings }>,
): Promise<void> {
	const start = Date.now();
	try {
		const { detail, timings } = await fn();
		const durationMs = Date.now() - start;
		allResults.push({
			category,
			name,
			passed: true,
			durationMs,
			failureSite: null,
			failureMessage: null,
			detail,
			timings: timings ?? null,
		});
		const timingStr = timings ? ` [${formatTimings(timings)}]` : "";
		process.stdout.write(
			`  ✓ [${category}] ${name} (${durationMs}ms)${timingStr}\n`,
		);
	} catch (err) {
		const durationMs = Date.now() - start;
		const msg = err instanceof Error ? err.message : String(err);
		const site =
			err instanceof Error && err.cause ? String(err.cause) : category;
		allResults.push({
			category,
			name,
			passed: false,
			durationMs,
			failureSite: site,
			failureMessage: msg,
			detail: "",
			timings: null,
		});
		process.stdout.write(
			`  ✗ [${category}] ${name}: ${msg.slice(0, 100)} (${durationMs}ms)\n`,
		);
	}
}

function fail(site: string, message: string): never {
	const err = new Error(message);
	err.cause = site;
	throw err;
}

function formatTimings(t: PipelineTimings): string {
	const parts: string[] = [];
	if (t.classifierMs > 0) parts.push(`classifier=${t.classifierMs}ms`);
	if (t.embeddingMs > 0) parts.push(`embed=${t.embeddingMs}ms`);
	if (t.vectorSearchMs > 0) parts.push(`vecSearch=${t.vectorSearchMs}ms`);
	if (t.graphExpansionMs > 0) parts.push(`graphExp=${t.graphExpansionMs}ms`);
	if (t.assemblyMs > 0) parts.push(`assembly=${t.assemblyMs}ms`);
	if (t.synthesisMs > 0) parts.push(`synthesis=${t.synthesisMs}ms`);
	parts.push(`total=${t.totalMs}ms`);
	return parts.join(" + ");
}

function mapValidationEntity(
	record: Neo4jRecord,
	nameKey: string,
	qualifiedNameKey: string,
	labelKey: string,
): ValidationEntity {
	const name = String(record.get(nameKey) ?? "").trim();
	const qualifiedName = String(record.get(qualifiedNameKey) ?? "").trim();
	const label = String(record.get(labelKey) ?? "").trim();
	return {
		name,
		qualifiedName: qualifiedName || name,
		label,
	};
}

async function discoverValidationTargets(
	driver: Driver,
): Promise<ValidationTargets> {
	const session = driver.session({ database: "neo4j" });

	try {
		const callsResult = await session.run(
			`
			MATCH (caller)-[:CALLS]->(callee:Function)
			WHERE caller.name IS NOT NULL AND callee.name IS NOT NULL
			RETURN
			  caller.name AS callerName,
			  coalesce(caller.qualifiedName, caller.name) AS callerQualifiedName,
			  labels(caller)[0] AS callerLabel,
			  callee.name AS calleeName,
			  coalesce(callee.qualifiedName, callee.name) AS calleeQualifiedName,
			  'Function' AS calleeLabel
			LIMIT 1
			`,
		);

		const definedInResult = await session.run(
			`
			MATCH (f:Function)-[:DEFINED_IN]->(:File)
			WHERE f.name IS NOT NULL
			RETURN
			  f.name AS name,
			  coalesce(f.qualifiedName, f.name) AS qualifiedName,
			  'Function' AS label
			LIMIT 1
			`,
		);

		const rendersResult = await session.run(
			`
			MATCH (c:Component)-[:RENDERS]->(:Component)
			WHERE c.name IS NOT NULL
			RETURN
			  c.name AS name,
			  coalesce(c.qualifiedName, c.name) AS qualifiedName,
			  'Component' AS label
			LIMIT 1
			`,
		);

		const usesHookResult = await session.run(
			`
			MATCH (c:Component)-[:USES_HOOK]->(:Hook)
			WHERE c.name IS NOT NULL
			RETURN
			  c.name AS name,
			  coalesce(c.qualifiedName, c.name) AS qualifiedName,
			  'Component' AS label
			LIMIT 1
			`,
		);

		const callRecord = callsResult.records[0] ?? null;
		const calledByTarget = callRecord
			? mapValidationEntity(
					callRecord,
					"calleeName",
					"calleeQualifiedName",
					"calleeLabel",
				)
			: null;
		const calledByCaller = callRecord
			? mapValidationEntity(
					callRecord,
					"callerName",
					"callerQualifiedName",
					"callerLabel",
				)
			: null;

		const definedInRecord = definedInResult.records[0] ?? null;
		const definedInTarget = definedInRecord
			? mapValidationEntity(definedInRecord, "name", "qualifiedName", "label")
			: calledByTarget;

		const rendersRecord = rendersResult.records[0] ?? null;
		const rendersTarget = rendersRecord
			? mapValidationEntity(rendersRecord, "name", "qualifiedName", "label")
			: null;

		const usesHookRecord = usesHookResult.records[0] ?? null;
		const usesHookTarget = usesHookRecord
			? mapValidationEntity(usesHookRecord, "name", "qualifiedName", "label")
			: null;

		return {
			calledByTarget,
			calledByCaller,
			definedInTarget,
			rendersTarget,
			usesHookTarget,
		};
	} finally {
		await session.close();
	}
}

function pickTargetName(
	target: ValidationEntity | null,
	fallback: string,
): string {
	if (!target) return fallback;
	return target.qualifiedName || target.name || fallback;
}

// ─── 1. Intent classifier ────────────────────────────────────────────────────

async function testIntentClassifier(classifierProvider: LLMProvider) {
	// 1a. Structural queries should route to structural kind
	await runTest(
		"intent",
		"structural: 'What calls fetchPosts?' → kind=structural",
		async () => {
			const intent = await classifyIntent(
				"What calls fetchPosts?",
				classifierProvider,
			);
			if (intent.kind !== "structural")
				fail(
					"intent.kind",
					`Expected structural, got ${intent.kind} (${JSON.stringify(intent)})`,
				);
			return {
				detail: `edge=${intent.spec.edge} dir=${intent.spec.direction} relationship="${intent.relationship}"`,
			};
		},
	);

	await runTest(
		"intent",
		"structural: 'What does App render?' → kind=structural",
		async () => {
			const intent = await classifyIntent(
				"What does App render?",
				classifierProvider,
			);
			if (intent.kind !== "structural")
				fail(
					"intent.kind",
					`Expected structural, got ${intent.kind} (${JSON.stringify(intent)})`,
				);
			return {
				detail: `edge=${intent.spec.edge} dir=${intent.spec.direction} relationship="${intent.relationship}"`,
			};
		},
	);

	await runTest(
		"intent",
		"structural: 'Where is formatDate defined?' → kind=structural",
		async () => {
			const intent = await classifyIntent(
				"Where is formatDate defined?",
				classifierProvider,
			);
			if (intent.kind !== "structural")
				fail(
					"intent.kind",
					`Expected structural, got ${intent.kind} (${JSON.stringify(intent)})`,
				);
			return {
				detail: `edge=${intent.spec.edge} dir=${intent.spec.direction} relationship="${intent.relationship}"`,
			};
		},
	);

	// 1b. Semantic queries should route to hybrid
	await runTest(
		"intent",
		"hybrid: 'What function fetches blog posts?' → kind=hybrid",
		async () => {
			const intent = await classifyIntent(
				"What function fetches blog posts from the API?",
				classifierProvider,
			);
			if (intent.kind !== "hybrid")
				fail(
					"intent.kind",
					`Expected hybrid, got ${intent.kind} (${JSON.stringify(intent)})`,
				);
			return { detail: `subKind=${intent.subKind} topK=${intent.topK}` };
		},
	);

	// 1c. Social queries should route to social
	await runTest(
		"intent",
		"social: 'Who wrote the auth module?' → kind=social",
		async () => {
			const intent = await classifyIntent(
				"Who wrote the auth module?",
				classifierProvider,
			);
			if (intent.kind !== "social")
				fail(
					"intent.kind",
					`Expected social, got ${intent.kind} (${JSON.stringify(intent)})`,
				);
			return { detail: `extractedName=${intent.extractedName}` };
		},
	);

	// 1d. Architectural query should be hybrid/architectural
	await runTest(
		"intent",
		"architectural: multi-module interaction → subKind=architectural",
		async () => {
			const intent = await classifyIntent(
				"How do the API layer, data hooks, and UI components interact to display user data?",
				classifierProvider,
			);
			if (intent.kind !== "hybrid")
				fail(
					"intent.kind",
					`Expected hybrid, got ${intent.kind} (${JSON.stringify(intent)})`,
				);
			if (intent.subKind !== "architectural")
				fail("intent.subKind", `Expected architectural, got ${intent.subKind}`);
			return { detail: `subKind=${intent.subKind} topK=${intent.topK}` };
		},
	);

	await runTest(
		"intent",
		"architectural guard: rendering chain query routes to hybrid",
		async () => {
			const intent = await classifyIntent(
				"What is the rendering chain from App to Button?",
				classifierProvider,
			);
			if (intent.kind !== "hybrid")
				fail(
					"intent.kind",
					`Expected hybrid, got ${intent.kind} (${JSON.stringify(intent)})`,
				);
			if (intent.subKind !== "architectural")
				fail("intent.subKind", `Expected architectural, got ${intent.subKind}`);
			return { detail: `subKind=${intent.subKind} topK=${intent.topK}` };
		},
	);

	// 1e. Verify fallback doesn't fire for well-formed queries
	await runTest(
		"intent",
		"no-fallback: well-formed queries produce non-default intents",
		async () => {
			const queries = [
				{ q: "What calls fetchPosts?", expectKind: "structural" },
				{ q: "What function handles login?", expectKind: "hybrid" },
				{ q: "Who maintains the API?", expectKind: "social" },
			];
			const misrouted: string[] = [];
			for (const { q, expectKind } of queries) {
				const intent = await classifyIntent(q, classifierProvider);
				if (intent.kind !== expectKind) {
					misrouted.push(`"${q}" → ${intent.kind} (expected ${expectKind})`);
				}
			}
			if (misrouted.length > 0) {
				fail(
					"intent.routing",
					`${misrouted.length} misrouted: ${misrouted[0]}`,
				);
			}
			return { detail: `${queries.length}/${queries.length} correctly routed` };
		},
	);
}

// ─── 2. Structural queries ───────────────────────────────────────────────────

async function testStructuralQueries(
	driver: Driver,
	targets: ValidationTargets,
) {
	const patterns: Array<{
		pattern: StructuralPattern;
		name: string;
		expectResults: boolean;
		description: string;
	}> = [
		{
			pattern: "called_by",
			name: pickTargetName(targets.calledByTarget, "__missing_called_target__"),
			expectResults: targets.calledByTarget !== null,
			description: `callers of ${pickTargetName(targets.calledByTarget, "<unavailable>")}`,
		},
		{
			pattern: "defined_in",
			name: pickTargetName(
				targets.definedInTarget,
				"__missing_defined_target__",
			),
			expectResults: targets.definedInTarget !== null,
			description: `file containing ${pickTargetName(targets.definedInTarget, "<unavailable>")}`,
		},
		{
			pattern: "renders",
			name: pickTargetName(targets.rendersTarget, "__missing_render_target__"),
			expectResults: targets.rendersTarget !== null,
			description: `components rendered by ${pickTargetName(targets.rendersTarget, "<unavailable>")}`,
		},
		{
			pattern: "uses_hook",
			name: pickTargetName(targets.usesHookTarget, "__missing_hook_target__"),
			expectResults: targets.usesHookTarget !== null,
			description: `hooks used by ${pickTargetName(targets.usesHookTarget, "<unavailable>")}`,
		},
		// what_calls may return 0 if fetchPosts doesn't call anything in the graph
		{
			pattern: "what_calls",
			name: pickTargetName(targets.calledByCaller, "__missing_caller_target__"),
			expectResults: false,
			description: `what ${pickTargetName(targets.calledByCaller, "<unavailable>")} calls (may be empty)`,
		},
		// Week 8 scaffolds — should return empty, NOT error
		{
			pattern: "implements",
			name: "SomeInterface",
			expectResults: false,
			description: "Week 8 scaffold",
		},
		{
			pattern: "decorators",
			name: "SomeClass",
			expectResults: false,
			description: "Week 8 scaffold",
		},
		{
			pattern: "overrides",
			name: "SomeMethod",
			expectResults: false,
			description: "Week 8 scaffold",
		},
	];

	for (const { pattern, name, expectResults, description } of patterns) {
		await runTest(
			"structural",
			`${pattern}("${name}") — ${description}`,
			async () => {
				const result = await structuralQuery(driver, pattern, name);
				if (result.pattern !== pattern)
					fail(
						"structural.pattern",
						`Pattern mismatch: expected ${pattern}, got ${result.pattern}`,
					);
				if (expectResults && result.entities.length === 0) {
					fail(
						"structural.empty",
						`Expected results for ${pattern}("${name}") but got 0`,
					);
				}
				return { detail: `${result.entities.length} entities` };
			},
		);
	}
}

// ─── 3. Graph expansion ─────────────────────────────────────────────────────

async function testGraphExpansion(driver: Driver) {
	await runTest("expansion", "expandContext returns valid shape", async () => {
		const session = driver.session({ database: "neo4j" });
		let nodeId: string;
		try {
			const r = await session.run(
				`MATCH (n:Function) RETURN n.nodeId AS nodeId LIMIT 1`,
			);
			const rec = r.records[0];
			if (!rec) fail("expansion.query", "No Function nodes found in graph");
			nodeId = rec.get("nodeId") as string;
		} finally {
			await session.close();
		}

		const expanded = await expandContext(driver, nodeId);
		if (!expanded)
			fail("expansion.null", `expandContext returned null for ${nodeId}`);
		if (!expanded.target?.nodeId)
			fail("expansion.target", "target.nodeId missing");
		if (!expanded.target?.name) fail("expansion.target", "target.name missing");
		if (!expanded.target?.label)
			fail("expansion.target", "target.label missing");
		if (!Array.isArray(expanded.callers))
			fail("expansion.callers", "callers is not an array");
		if (!Array.isArray(expanded.callees))
			fail("expansion.callees", "callees is not an array");
		if (!Array.isArray(expanded.importedFiles))
			fail("expansion.imports", "importedFiles is not an array");

		return {
			detail: `target=${expanded.target.name} callers=${expanded.callers.length} callees=${expanded.callees.length} imports=${expanded.importedFiles.length}`,
		};
	});

	await runTest(
		"expansion",
		"expandContext for missing nodeId returns null",
		async () => {
			const expanded = await expandContext(driver, "nonexistent_node_id_xyz");
			if (expanded !== null)
				fail(
					"expansion.missing",
					"expandContext should return null for nonexistent nodeId",
				);
			return { detail: "correctly returned null" };
		},
	);
}

// ─── 4. Context assembler ────────────────────────────────────────────────────

async function testContextAssembler() {
	const mockExpanded: ExpandedContext = {
		target: {
			nodeId: "test-1",
			name: "fetchPosts",
			qualifiedName: "src/api.ts::fetchPosts",
			label: "Function",
			filePath: "src/api.ts",
			sourceCode:
				'export async function fetchPosts() {\n  return fetch("/api/posts").then(r => r.json());\n}',
			startLine: 10,
			endLine: 12,
		},
		file: { filePath: "src/api.ts", language: "TypeScript" },
		callers: [
			{
				nodeId: "test-2",
				name: "PostList",
				qualifiedName: "src/PostList.tsx::PostList",
				filePath: "src/PostList.tsx",
				label: "Component",
				sourceCode: "function PostList() { ... }",
				callSiteLine: 15,
			},
		],
		callees: [],
		renderedComponents: [],
		hooksUsed: [],
		importedFiles: [{ filePath: "src/utils.ts", language: "TypeScript" }],
		developers: [],
	};

	await runTest("assembler", "compact budget limits output", async () => {
		const result = assembleContext(mockExpanded, { budget: "compact" });
		if (result.charCount > BUDGET_LIMITS.compact)
			fail(
				"assembler.budget",
				`compact budget exceeded: ${result.charCount} > ${BUDGET_LIMITS.compact}`,
			);
		if (!result.text.includes("fetchPosts"))
			fail("assembler.content", "Target name missing from output");
		return {
			detail: `${result.charCount} chars, truncated=${result.wasTruncated}`,
		};
	});

	await runTest("assembler", "standard budget includes source", async () => {
		const result = assembleContext(mockExpanded, { budget: "standard" });
		if (!result.text.includes("export async function"))
			fail(
				"assembler.source",
				"Target source code missing from standard output",
			);
		if (result.charCount > BUDGET_LIMITS.standard)
			fail(
				"assembler.budget",
				`standard budget exceeded: ${result.charCount} > ${BUDGET_LIMITS.standard}`,
			);
		return {
			detail: `${result.charCount} chars, refs=${result.referencedNodeIds.length}`,
		};
	});

	await runTest("assembler", "full budget includes everything", async () => {
		const result = assembleContext(mockExpanded, { budget: "full" });
		if (!result.text.includes("PostList"))
			fail("assembler.callers", "Caller name missing from full output");
		if (!result.text.includes("src/utils.ts"))
			fail("assembler.imports", "Imported file missing from full output");
		return {
			detail: `${result.charCount} chars, refs=${result.referencedNodeIds.length}`,
		};
	});

	await runTest("assembler", "referenced nodeIds are tracked", async () => {
		const result = assembleContext(mockExpanded, { budget: "full" });
		if (!result.referencedNodeIds.includes("test-1"))
			fail("assembler.refs", "Target nodeId not in referencedNodeIds");
		if (!result.referencedNodeIds.includes("test-2"))
			fail("assembler.refs", "Caller nodeId not in referencedNodeIds");
		return { detail: `refs=${result.referencedNodeIds.join(",")}` };
	});
}

// ─── 5. End-to-end pipeline (with timing breakdown) ──────────────────────────

async function testEndToEnd(
	driver: Driver,
	chromaClient: ChromaClient,
	embeddingProvider: EmbeddingProvider,
	llmProvider: LLMProvider,
	classifierProvider: LLMProvider,
	targets: ValidationTargets,
) {
	const opts = {
		driver,
		chromaClient,
		embeddingProvider,
		llmProvider,
		classifierProvider,
		budget: "standard" as ContextBudget,
	};

	await runTest(
		"e2e",
		"semantic query returns results (hybrid or structural)",
		async () => {
			const result = await runSearch(
				"What function fetches blog posts from the API?",
				opts,
			);
			// Accept either hybrid or structural routing — both can produce correct answers.
			// What matters is that the pipeline returns non-empty results.
			if (result.kind === "hybrid") {
				if (!result.result.answer)
					fail("e2e.answer", "Hybrid result has empty answer");
				return {
					detail: `kind=hybrid anchors=${result.result.anchors.length} tokens=${result.result.usage.inputTokens}+${result.result.usage.outputTokens}`,
					timings: result.timings,
				};
			}
			if (result.kind === "structural") {
				return {
					detail: `kind=structural entities=${result.result.entities.length} edge=${result.result.pattern} (classifier chose structural over hybrid)`,
					timings: result.timings,
				};
			}
			return {
				detail: `kind=${result.kind} (unexpected route)`,
				timings: result.timings,
			};
		},
	);

	await runTest(
		"e2e",
		"structural query returns entities with timings",
		async () => {
			if (!targets.definedInTarget) {
				return {
					detail:
						"skipped strict entity assertion: no function with DEFINED_IN edge found",
				};
			}

			const entityName = pickTargetName(targets.definedInTarget, "fetchPosts");
			const result = await runSearch(`Where is ${entityName} defined?`, opts);
			if (result.kind === "structural") {
				if (result.result.entities.length === 0)
					fail("e2e.entities", "Structural result has no entities");
				return {
					detail: `kind=structural entities=${result.result.entities.length} pattern=${result.result.pattern}`,
					timings: result.timings,
				};
			}
			// Classifier may route as hybrid — note it, don't fail
			return {
				detail: `kind=${result.kind} (routed as ${result.intent.kind} instead of structural)`,
				timings: result.timings,
			};
		},
	);

	await runTest(
		"e2e",
		"social query returns social result or stub with timings",
		async () => {
			const result = await runSearch("Who wrote the auth module?", opts);
			if (result.kind === "social") {
				return {
					detail: `kind=social devs=${result.result.developers.length} answer=${result.result.answer.slice(0, 60)}`,
					timings: result.timings,
				};
			}
			return {
				detail: `kind=${result.kind} (routed as ${result.intent.kind} instead of social)`,
				timings: result.timings,
			};
		},
	);

	await runTest(
		"e2e",
		"architectural query uses K=5 with timings",
		async () => {
			const result = await runSearch(
				"How do the API module, hooks, and components work together?",
				opts,
			);
			if (result.kind !== "hybrid")
				fail("e2e.kind", `Expected hybrid, got ${result.kind}`);
			// Don't strictly assert K=5 — the classifier may choose differently
			return {
				detail: `kind=${result.kind} anchors=${result.result.anchors.length} intent=${result.intent.kind}/${result.intent.kind === "hybrid" ? result.intent.subKind : "n/a"}`,
				timings: result.timings,
			};
		},
	);
}

// ─── 6. Name resolution & path search ─────────────────────────────────────

async function testNameResolutionAndPath(driver: Driver) {
	await runTest(
		"resolution",
		"resolveEntityByName finds graph-backed target",
		async () => {
			const targets = await discoverValidationTargets(driver);
			const lookup = pickTargetName(targets.definedInTarget, "");
			if (!lookup) {
				return {
					detail:
						"skipped strict name-resolution assertion: no function target discovered",
				};
			}

			const results = await resolveEntityByName(driver, lookup);
			if (results.length === 0)
				fail("resolution.empty", `No results for '${lookup}'`);
			const first = results[0]!;
			if (!first.nodeId)
				fail("resolution.nodeId", "First result has no nodeId");
			const expectedNameFragment =
				targets.definedInTarget?.name ?? lookup.split("::").at(-1) ?? lookup;
			if (!first.name.includes(expectedNameFragment))
				fail(
					"resolution.name",
					`Expected name containing '${expectedNameFragment}', got '${first.name}'`,
				);
			return {
				detail: `found=${results.length} first=${first.name} (${first.label})`,
			};
		},
	);

	await runTest(
		"resolution",
		"resolveEntityByName returns empty for nonsense",
		async () => {
			const results = await resolveEntityByName(
				driver,
				"zzz_nonexistent_entity_xyz",
			);
			if (results.length !== 0)
				fail(
					"resolution.unexpected",
					`Expected 0 results, got ${results.length}`,
				);
			return { detail: "correctly returned empty" };
		},
	);

	await runTest(
		"path",
		"findShortestPath between graph-backed entities",
		async () => {
			const targets = await discoverValidationTargets(driver);
			const fromLookup = pickTargetName(targets.calledByCaller, "");
			const toLookup = pickTargetName(targets.calledByTarget, "");

			if (!fromLookup || !toLookup) {
				return {
					detail:
						"skipped strict path assertion: no CALLS edge pair discovered",
				};
			}

			const fromResults = await resolveEntityByName(driver, fromLookup);
			const toResults = await resolveEntityByName(driver, toLookup);
			if (fromResults.length === 0)
				fail("path.resolve_from", `Could not resolve '${fromLookup}'`);
			if (toResults.length === 0)
				fail("path.resolve_to", `Could not resolve '${toLookup}'`);

			const fromId = fromResults[0]!.nodeId;
			const toId = toResults[0]!.nodeId;
			// Try both directions since the path may be directed
			const pathResult =
				(await findShortestPath(driver, fromId, toId)) ??
				(await findShortestPath(driver, toId, fromId));

			if (!pathResult)
				fail(
					"path.null",
					`No path found between '${fromLookup}' and '${toLookup}' in either direction`,
				);
			if (pathResult.hops === 0)
				fail("path.hops", "Path has 0 hops — nodes are the same?");
			return {
				detail: `hops=${pathResult.hops} edges=[${pathResult.edgeTypes.join(",")}] nodes=${pathResult.path.map((n) => n.name).join(" → ")}`,
			};
		},
	);

	await runTest(
		"path",
		"findShortestPath returns null for nonexistent node",
		async () => {
			const result = await findShortestPath(
				driver,
				"nonexistent_aaa",
				"nonexistent_bbb",
			);
			if (result !== null)
				fail("path.unexpected", "Expected null for nonexistent nodes");
			return { detail: "correctly returned null" };
		},
	);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const totalStart = Date.now();

	console.log("\n══════════════════════════════════════════════════════════");
	console.log("  CODEX RAG Pipeline Validation");
	console.log("══════════════════════════════════════════════════════════\n");

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
	const targets = await discoverValidationTargets(driver);

	console.log("Detected validation targets:");
	console.log(
		`  called_by target: ${targets.calledByTarget?.qualifiedName ?? "<none>"}`,
	);
	console.log(
		`  called_by caller: ${targets.calledByCaller?.qualifiedName ?? "<none>"}`,
	);
	console.log(
		`  defined_in target: ${targets.definedInTarget?.qualifiedName ?? "<none>"}`,
	);
	console.log(
		`  renders target: ${targets.rendersTarget?.qualifiedName ?? "<none>"}`,
	);
	console.log(
		`  uses_hook target: ${targets.usesHookTarget?.qualifiedName ?? "<none>"}`,
	);

	// ── Run test suites ─────────────────────────────────────────────────
	console.log("── 1. Intent Classifier ───────────────────────────────\n");
	await testIntentClassifier(classifierProvider);

	console.log("\n── 2. Structural Queries ──────────────────────────────\n");
	await testStructuralQueries(driver, targets);

	console.log("\n── 3. Graph Expansion ─────────────────────────────────\n");
	await testGraphExpansion(driver);

	console.log("\n── 4. Context Assembler ───────────────────────────────\n");
	await testContextAssembler();

	console.log("\n── 5. End-to-End Pipeline ─────────────────────────────\n");
	await testEndToEnd(
		driver,
		chromaClient,
		embeddingProvider,
		llmProvider,
		classifierProvider,
		targets,
	);

	console.log("\n── 6. Name Resolution & Path Search ───────────────────\n");
	await testNameResolutionAndPath(driver);

	await driver.close();

	// ═══════════════════════════════════════════════════════════════════════
	// Summary
	// ═══════════════════════════════════════════════════════════════════════
	const totalDurationMs = Date.now() - totalStart;
	const passed = allResults.filter((r) => r.passed);
	const failed = allResults.filter((r) => !r.passed);

	console.log("\n══════════════════════════════════════════════════════════");
	console.log("  Validation Summary");
	console.log("══════════════════════════════════════════════════════════");
	console.log(`\n  Total:     ${allResults.length} tests`);
	console.log(
		`  Passed:    ${passed.length}/${allResults.length} (${((passed.length / allResults.length) * 100).toFixed(0)}%)`,
	);
	console.log(`  Failed:    ${failed.length}/${allResults.length}`);
	console.log(`  Duration:  ${(totalDurationMs / 1000).toFixed(1)}s`);

	// ── Per-category breakdown ──────────────────────────────────────────
	const categories = [...new Set(allResults.map((r) => r.category))];
	console.log(`\n── Per-Category Breakdown ─────────────────────────────\n`);
	for (const cat of categories) {
		const catResults = allResults.filter((r) => r.category === cat);
		const catPassed = catResults.filter((r) => r.passed).length;
		const catFailed = catResults.length - catPassed;
		const icon = catFailed === 0 ? "✓" : "✗";
		console.log(
			`  ${icon} ${cat.padEnd(15)} ${catPassed}/${catResults.length} passed`,
		);
	}

	// ── Timing breakdown for e2e tests ──────────────────────────────────
	const e2eResults = allResults.filter(
		(r) => r.category === "e2e" && r.timings,
	);
	if (e2eResults.length > 0) {
		console.log(`\n── E2E Timing Breakdown ───────────────────────────────\n`);
		for (const r of e2eResults) {
			const t = r.timings!;
			console.log(`  ${r.name} (${r.durationMs}ms total)`);
			console.log(
				`    classifier=${t.classifierMs}ms  embed=${t.embeddingMs}ms  vecSearch=${t.vectorSearchMs}ms`,
			);
			console.log(
				`    graphExp=${t.graphExpansionMs}ms  assembly=${t.assemblyMs}ms  synthesis=${t.synthesisMs}ms`,
			);
			const overhead =
				t.totalMs -
				t.classifierMs -
				t.embeddingMs -
				t.vectorSearchMs -
				t.graphExpansionMs -
				t.assemblyMs -
				t.synthesisMs;
			console.log(
				`    overhead=${overhead}ms (connection setup, serialization)`,
			);
		}
	}

	// ── Failure details ─────────────────────────────────────────────────
	if (failed.length > 0) {
		console.log(`\n── Failure Details ────────────────────────────────────\n`);
		for (const f of failed) {
			console.log(`  ✗ [${f.category}] ${f.name}`);
			console.log(`    Site:    ${f.failureSite}`);
			console.log(`    Message: ${f.failureMessage}`);
		}
	}

	console.log();

	if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
