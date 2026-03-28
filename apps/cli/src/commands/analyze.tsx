/**
 * @fileoverview `codex analyze <path>` — unified pipeline orchestrator.
 *
 * Runs the full CODEX pipeline in a single command:
 *   1. Ingest  — Tree-sitter parse → Neo4j graph
 *   2. Mine    — Git history → DOA / Truck Factor (skippable with --skip-mine)
 *   3. Embed   — Vector embeddings → ChromaDB (with checkpointing)
 *   4. Serve   — Launch web UI (optional with --serve)
 *
 * Mine failures are non-fatal: if git mining fails (e.g. no .git directory),
 * the command warns and continues to embed. Ingest failure aborts everything.
 */

import { useState, useEffect, useRef } from "react";
import { Box, Text, Static, render, useApp } from "ink";
import neo4j from "neo4j-driver";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseProject } from "@codex/parser";
import {
	initializeSchema,
	insertParseResults,
	clearGraph,
	countFileNodes,
	clearMineData,
	insertMineResults,
} from "@codex/graph-client";
import { mine } from "@codex/git-miner";
import {
	createChromaClient,
	verifyChromaConnectivity,
	fetchEmbeddableNodes,
	runEmbeddingPipeline,
	getExistingIds,
	clearCollection,
	getOrCreateEntityCollection,
} from "@codex/vector-client";
import {
	createSiliconFlowEmbeddingProvider,
	createOpenAIEmbeddingProvider,
	type EmbeddingProvider,
} from "@codex/shared";

import { Step, ProgressBar, SummaryTable, type StepStatus } from "../ui/Progress.js";
import { Layout } from "../ui/Layout.js";
import { PostRunOptions, type PostRunAction } from "../ui/PostRunOptions.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "";

// Resolve repo root (4 levels up from apps/cli/src/commands/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnalyzeOptions {
	clean?: boolean;
	skipMine?: boolean;
	serve?: boolean;
	provider?: string;
	model?: string;
	onComplete?: (action: PostRunAction) => void;
}

type Phase =
	// Shared
	| "connect"
	// Ingest
	| "schema"
	| "parse"
	| "insertGraph"
	// Mine
	| "validate"
	| "log"
	| "blame"
	| "compute"
	| "insertMine"
	// Embed
	| "connectChroma"
	| "fetch"
	| "embed";

interface PhaseEntry {
	phase: Phase;
	label: string;
	status: StepStatus;
	detail: string;
}

const STEP_LABELS: Record<Phase, string> = {
	connect: "Connect to Neo4j",
	schema: "Initialize schema",
	parse: "Parse source files",
	insertGraph: "Insert into Neo4j",
	validate: "Validate graph state",
	log: "Extract git history",
	blame: "Analyze file ownership",
	compute: "Compute expertise (DOA)",
	insertMine: "Insert mine results",
	connectChroma: "Connect to ChromaDB",
	fetch: "Fetch embeddable entities",
	embed: "Embed & index in ChromaDB",
};

/** Group headers rendered above the first phase of each sub-pipeline. */
const PHASE_GROUPS: Partial<Record<Phase, string>> = {
	schema: "── Ingest ──────────────────────────",
	validate: "── Mine ────────────────────────────",
	connectChroma: "── Embed ───────────────────────────",
};

// ─── Provider factory ────────────────────────────────────────────────────────

function createProvider(providerName: string, modelOverride?: string): EmbeddingProvider {
	switch (providerName) {
		case "openai": {
			const apiKey = process.env.OPENAI_API_KEY;
			if (!apiKey) {
				console.error("OPENAI_API_KEY is not set. Add it to your .env file.");
				process.exit(1);
			}
			return createOpenAIEmbeddingProvider({
				apiKey,
				...(modelOverride ? { model: modelOverride } : {}),
			});
		}
		case "siliconflow":
		default: {
			const apiKey = process.env.SILICONFLOW_API_KEY;
			if (!apiKey) {
				console.error("SILICONFLOW_API_KEY is not set. Add it to your .env file.");
				process.exit(1);
			}
			return createSiliconFlowEmbeddingProvider({
				apiKey,
				...(modelOverride ? { model: modelOverride } : {}),
			});
		}
	}
}

// ─── UI component ─────────────────────────────────────────────────────────────

interface AnalyzeUIProps {
	targetPath: string;
	options: AnalyzeOptions;
	onComplete?: (action: PostRunAction) => void;
}

function AnalyzeUI({ targetPath, options, onComplete }: AnalyzeUIProps) {
	const { exit } = useApp();

	const [donePhases, setDonePhases] = useState<PhaseEntry[]>([]);
	const [activePhase, setActivePhase] = useState<Phase>("connect");
	const [activeDetail, setActiveDetail] = useState("");

	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const [summary, setSummary] = useState<Array<{ label: string; value: string | number }>>([]);

	// Progress bars
	const [parseProgress, setParseProgress] = useState<{ done: number; total: number } | null>(null);
	const [blameProgress, setBlameProgress] = useState<{ done: number; total: number } | null>(null);
	const [embedProgress, setEmbedProgress] = useState<{ done: number; total: number } | null>(null);

	// Serve state
	const [serving, setServing] = useState(false);
	const [serveStatus, setServeStatus] = useState("");
	const serveProcsRef = useRef<ReturnType<typeof Bun.spawn>[]>([]);

	// Track which mine phases have been pushed to Static (mine callbacks fire multiple times)
	const pushedMineRef = useRef<Set<string>>(new Set());

	function completePhase(phase: Phase, detail: string, status: StepStatus = "done") {
		setDonePhases((prev) => [
			...prev,
			{ phase, label: STEP_LABELS[phase], status, detail },
		]);
	}

	useEffect(() => {
		const cleanup = () => {
			for (const proc of serveProcsRef.current) {
				try { proc.kill(); } catch { /* already dead */ }
			}
		};
		process.on("SIGINT", cleanup);

		run().catch((err) => {
			setError(err instanceof Error ? err.message : String(err));
			exit();
		});

		return () => {
			process.off("SIGINT", cleanup);
			cleanup();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function run() {
		const absPath = path.resolve(targetPath);
		const timings = { ingest: 0, mine: 0, embed: 0 };

		// ── 1. Connect to Neo4j (shared driver for all sub-pipelines) ─────────
		setActiveDetail(NEO4J_URI);
		const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
		try {
			await driver.verifyConnectivity();
		} catch {
			completePhase("connect", "could not reach Neo4j — is Docker running?", "failed");
			await driver.close();
			exit(new Error("Neo4j unreachable"));
			return;
		}
		completePhase("connect", NEO4J_URI);

		// ════════════════════════════════════════════════════════════════════════
		// INGEST SUB-PIPELINE
		// ════════════════════════════════════════════════════════════════════════
		const ingestStart = Date.now();
		setActivePhase("schema");

		try {
			// ── Schema ──────────────────────────────────────────────────────────
			setActiveDetail("running…");
			const schemaResult = await initializeSchema(driver);
			completePhase("schema", `${schemaResult.statementsRun} statements`);
			setActivePhase("parse");

			// ── Parse ────────────────────────────────────────────────────────────
			if (options.clean) {
				setActiveDetail("clearing existing graph…");
				await clearGraph(driver);
			}
			setActiveDetail(absPath);
			const { files, stats: parseStats } = await parseProject(absPath, {
				onProgress: (parsed, total) => {
					setParseProgress({ done: parsed, total });
					setActiveDetail(`${parsed} / ${total} files`);
				},
			});
			setParseProgress(null);
			completePhase(
				"parse",
				`${parseStats.filesParsed} files · ${parseStats.totalEntities} entities · ${parseStats.totalRelationships} relationships`,
			);
			setActivePhase("insertGraph");

			// ── Insert ───────────────────────────────────────────────────────────
			setActiveDetail("writing to Neo4j…");
			const insertStats = await insertParseResults(driver, files);
			completePhase(
				"insertGraph",
				`${insertStats.nodesInserted} nodes · ${insertStats.edgesInserted} edges · ${insertStats.durationMs}ms`,
			);
		} catch (err) {
			completePhase("insertGraph", err instanceof Error ? err.message : String(err), "failed");
			await driver.close();
			setError("Ingest failed — cannot continue.");
			exit(new Error("Ingest failed"));
			return;
		}
		timings.ingest = Date.now() - ingestStart;

		// ════════════════════════════════════════════════════════════════════════
		// MINE SUB-PIPELINE (non-fatal)
		// ════════════════════════════════════════════════════════════════════════
		const mineStart = Date.now();

		if (options.skipMine) {
			setActivePhase("connectChroma");
			for (const phase of ["validate", "log", "blame", "compute", "insertMine"] as Phase[]) {
				completePhase(phase, "skipped (--skip-mine)", "warned");
			}
		} else {
			setActivePhase("validate");
			try {
				// ── Validate ───────────────────────────────────────────────────────
				setActiveDetail("checking graph state…");
				const fileCount = await countFileNodes(driver);
				if (options.clean) {
					setActiveDetail("clearing mine data…");
					await clearMineData(driver);
				}
				completePhase(
					"validate",
					`${fileCount} File nodes${options.clean ? " · cleared" : ""}`,
				);
				setActivePhase("log");

				// ── Mine (log → blame → compute) ──────────────────────────────────
				setActiveDetail("reading git log…");
				let finalLogDetail = "";
				let finalBlameDetail = "";

				const mineResult = await mine(absPath, driver, {
					onProgress: (progress) => {
						switch (progress.phase) {
							case "log":
								finalLogDetail = progress.detail ?? "";
								setActiveDetail(finalLogDetail);
								break;
							case "blame":
								if (!pushedMineRef.current.has("log")) {
									pushedMineRef.current.add("log");
									completePhase("log", finalLogDetail || "complete");
									setActivePhase("blame");
								}
								finalBlameDetail = progress.detail ?? "";
								setActiveDetail(finalBlameDetail);
								setBlameProgress({ done: progress.current, total: progress.total });
								break;
							case "map":
								setBlameProgress(null);
								if (!pushedMineRef.current.has("blame")) {
									pushedMineRef.current.add("blame");
									completePhase("blame", finalBlameDetail || "complete");
									setActivePhase("compute");
								}
								setActiveDetail(progress.detail ?? "");
								break;
							case "doa":
								setActiveDetail(progress.detail ?? "");
								break;
							default:
								break;
						}
					},
				});

				const logFinal = `${mineResult.stats.commits} commits · ${mineResult.stats.developers} developers`;
				const blameFinal = `${mineResult.stats.filesBlamed} files · ${mineResult.stats.blameFailures} skipped`;
				const computeFinal = `${mineResult.stats.expertiseEdges} expertise edges · Truck Factor: ${mineResult.truckFactor.truckFactor}`;

				if (!pushedMineRef.current.has("log")) completePhase("log", logFinal);
				if (!pushedMineRef.current.has("blame")) completePhase("blame", blameFinal);
				completePhase("compute", computeFinal);
				setBlameProgress(null);
				setActivePhase("insertMine");

				// ── Insert mine ────────────────────────────────────────────────────
				setActiveDetail("writing to Neo4j…");
				const mineInsert = await insertMineResults(driver, mineResult);
				completePhase(
					"insertMine",
					`${mineInsert.developersInserted} devs · ${mineInsert.commitsInserted} commits · ${mineInsert.durationMs}ms`,
				);
			} catch (err) {
				// Mine failure is non-fatal — warn and continue to embed
				const msg = err instanceof Error ? err.message : String(err);
				for (const phase of ["log", "blame", "compute", "insertMine"] as Phase[]) {
					if (!pushedMineRef.current.has(phase)) {
						completePhase(phase, phase === "log" ? msg : "skipped due to mine failure", "warned");
					}
				}
			}
		}
		timings.mine = Date.now() - mineStart;

		// ════════════════════════════════════════════════════════════════════════
		// EMBED SUB-PIPELINE
		// ════════════════════════════════════════════════════════════════════════
		const embedStart = Date.now();
		setActivePhase("connectChroma");

		const provider = createProvider(options.provider ?? "siliconflow", options.model || undefined);
		const chromaClient = createChromaClient();

		// ── Connect ChromaDB ─────────────────────────────────────────────────
		setActiveDetail("connecting…");
		try {
			await verifyChromaConnectivity(chromaClient);
		} catch {
			completePhase("connectChroma", "could not reach ChromaDB — is Docker running?", "failed");
			await driver.close();
			exit(new Error("ChromaDB unreachable"));
			return;
		}
		completePhase("connectChroma", process.env.CHROMA_URL ?? "http://localhost:8000");
		setActivePhase("fetch");

		// ── Fetch + Checkpoint ────────────────────────────────────────────────
		setActiveDetail("querying Neo4j…");
		const allEntities = await fetchEmbeddableNodes(driver);

		// Checkpointing: on re-runs without --clean, fetch IDs already in ChromaDB
		// so the embedding API is never called for entities that are already indexed.
		let skipIds = new Set<string>();
		if (!options.clean && allEntities.length > 0) {
			setActiveDetail("checking cached embeddings…");
			skipIds = await getExistingIds(chromaClient);
		}

		if (options.clean) {
			await clearCollection(chromaClient);
		} else {
			// Ensure the collection exists before embedding
			await getOrCreateEntityCollection(chromaClient);
		}

		const newCount = allEntities.length - skipIds.size;
		const labelCounts = new Map<string, number>();
		for (const e of allEntities) labelCounts.set(e.label, (labelCounts.get(e.label) ?? 0) + 1);
		const breakdown = Array.from(labelCounts.entries()).map(([l, c]) => `${c} ${l}`).join(", ");

		if (allEntities.length === 0) {
			completePhase("fetch", "0 entities — ingest phase may have failed");
			completePhase("embed", "nothing to embed");
			await driver.close();
			timings.embed = Date.now() - embedStart;
		} else {
			const cacheNote = skipIds.size > 0 ? ` · ${skipIds.size} cached · ${newCount} new` : "";
			completePhase("fetch", `${allEntities.length} total (${breakdown})${cacheNote}`);
			setActivePhase("embed");

			// ── Embed ──────────────────────────────────────────────────────────
			setActiveDetail(`${provider.providerName} / ${provider.modelId}`);
			let embedStats;
			try {
				embedStats = await runEmbeddingPipeline({
					driver,
					chromaClient,
					embeddingProvider: provider,
					clean: false, // Collection already handled above
					skipIds,
					prefetchedEntities: allEntities, // Avoid redundant Neo4j fetch
					onProgress: (embedded, total) => {
						setEmbedProgress({ done: embedded, total });
						setActiveDetail(`${embedded} / ${total} new entities`);
					},
					onRetry: (attempt, delayMs) => {
						setActiveDetail(`retry ${attempt} in ${delayMs}ms…`);
					},
				});
			} catch (err) {
				completePhase("embed", err instanceof Error ? err.message : String(err), "failed");
				await driver.close();
				setDone(true);
				if (!onComplete) exit();
				return;
			}

			setEmbedProgress(null);
			const cachedNote = (embedStats.cachedCount ?? 0) > 0
				? ` · ${embedStats.cachedCount} cached`
				: "";
			completePhase(
				"embed",
				`${embedStats.entitiesEmbedded} embedded · ${embedStats.totalTokens} tokens · ${embedStats.durationMs}ms${cachedNote}`,
			);
			timings.embed = Date.now() - embedStart;

			await driver.close();

			setSummary([
				{ label: "Target", value: absPath },
				{ label: "── Timing ──", value: "" },
				{ label: "  Ingest", value: `${timings.ingest}ms` },
				{ label: "  Mine", value: options.skipMine ? "skipped" : `${timings.mine}ms` },
				{ label: "  Embed", value: `${timings.embed}ms (API: ${embedStats.durationMs}ms)` },
				{ label: "  Total", value: `${timings.ingest + timings.mine + timings.embed}ms` },
				{ label: "── Embed stats ──", value: "" },
				{ label: "  Entities embedded", value: embedStats.entitiesEmbedded },
				...(embedStats.cachedCount ? [{ label: "  Entities cached", value: embedStats.cachedCount }] : []),
				...(embedStats.entitiesFailed > 0 ? [{ label: "  Embed failures", value: embedStats.entitiesFailed }] : []),
				{ label: "  Tokens consumed", value: embedStats.totalTokens },
				{ label: "  Est. cost", value: `$${embedStats.estimatedCost.toFixed(4)}` },
			]);
		}

		setDone(true);

		// ── Serve (optional) ─────────────────────────────────────────────────
		if (options.serve) {
			setServing(true);
			setServeStatus("Starting servers…");

			const backend = Bun.spawn(["bun", "run", "dev:backend"], {
				cwd: REPO_ROOT,
				stdout: "ignore",
				stderr: "ignore",
			});
			const frontend = Bun.spawn(["bun", "run", "dev:frontend"], {
				cwd: REPO_ROOT,
				stdout: "ignore",
				stderr: "ignore",
			});
			serveProcsRef.current.push(backend, frontend);

			const deadline = Date.now() + 30_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(1000) });
					if (res.ok) { ready = true; break; }
				} catch { /* not ready */ }
				await Bun.sleep(500);
			}

			if (ready) {
				Bun.spawn(["open", FRONTEND_URL], { stdout: "ignore", stderr: "ignore" });
				setServeStatus(`Running — ${FRONTEND_URL} — Ctrl+C to stop`);
			} else {
				setServeStatus("Backend did not respond within 30s");
			}
			// Stay alive to keep servers running
			return;
		}

		if (!onComplete) exit();
	}

	return (
		<Layout showHeader={false} command="analyze" showTokenTicker={true}>
			{/* Completed steps — rendered once via Static */}
			<Static items={donePhases}>
				{(entry) => (
					<Box key={entry.phase} flexDirection="column">
						{PHASE_GROUPS[entry.phase] && (
							<Text dimColor>{PHASE_GROUPS[entry.phase]}</Text>
						)}
						<Step
							label={entry.label}
							status={entry.status}
							detail={entry.detail}
						/>
					</Box>
				)}
			</Static>

			{/* Active step + progress bars */}
			{!done && (
				<Box flexDirection="column">
					{PHASE_GROUPS[activePhase] && (
						<Text dimColor>{PHASE_GROUPS[activePhase]}</Text>
					)}
					<Step label={STEP_LABELS[activePhase]} status="running" detail={activeDetail} />
					{activePhase === "parse" && parseProgress && parseProgress.total > 0 && (
						<Box paddingLeft={2}>
							<ProgressBar value={parseProgress.done / parseProgress.total} width={24} />
						</Box>
					)}
					{activePhase === "blame" && blameProgress && blameProgress.total > 0 && (
						<Box paddingLeft={2}>
							<ProgressBar value={blameProgress.done / blameProgress.total} width={24} />
						</Box>
					)}
					{activePhase === "embed" && embedProgress && embedProgress.total > 0 && (
						<Box paddingLeft={2}>
							<ProgressBar value={embedProgress.done / embedProgress.total} width={24} />
						</Box>
					)}
				</Box>
			)}

			{error && (
				<Box marginTop={1}>
					<Text color="red">✘ {error}</Text>
				</Box>
			)}

			{done && summary.length > 0 && <SummaryTable title="Run summary" rows={summary} />}

			{serving && (
				<Box marginTop={1} gap={1}>
					<Text color={serveStatus.includes("Running") ? "green" : "yellow"}>
						{serveStatus.includes("Running") ? "✔" : "⟳"}
					</Text>
					<Text>{serveStatus}</Text>
				</Box>
			)}

			{done && !serving && onComplete && (
				<PostRunOptions
					onComplete={(action) => {
						exit();
						onComplete(action);
					}}
				/>
			)}

			{!done && (
				<Box marginTop={1}>
					<Text dimColor>^C to abort</Text>
				</Box>
			)}
		</Layout>
	);
}

// ─── Entry point called by Commander ─────────────────────────────────────────

export function runAnalyze(targetPath: string, options: AnalyzeOptions = {}) {
	if (!NEO4J_PASSWORD) {
		console.error("NEO4J_PASSWORD is not set. Add it to your .env file.");
		process.exit(1);
	}
	render(
		<AnalyzeUI
			targetPath={targetPath}
			options={options}
			onComplete={options.onComplete}
		/>,
	);
}
