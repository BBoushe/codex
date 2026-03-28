/**
 * @fileoverview CLI `embed` command — generates vector embeddings for all
 * graph entities and indexes them in ChromaDB.
 *
 * Requires a prior `ingest` run to populate Neo4j with entities.
 * The token ticker footer shows live embedding token consumption.
 */

import { useState, useEffect } from "react";
import { Box, Text, Static, render, useApp } from "ink";
import neo4j from "neo4j-driver";
import {
	createSiliconFlowEmbeddingProvider,
	createOpenAIEmbeddingProvider,
	type EmbeddingProvider,
} from "@codex/shared";
import {
	createChromaClient,
	verifyChromaConnectivity,
	fetchEmbeddableNodes,
	runEmbeddingPipeline,
	type EmbedStats,
} from "@codex/vector-client";
import {
	Step,
	ProgressBar,
	SummaryTable,
	type StepStatus,
} from "../ui/Progress.js";
import { Layout } from "../ui/Layout.js";
import { PostRunOptions, type PostRunAction } from "../ui/PostRunOptions.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EmbedOptions {
	clean?: boolean;
	provider?: string;
	/** Override the embedding model (default: provider-specific default). */
	model?: string;
	onComplete?: (action: PostRunAction) => void;
	nextPhaseLabel?: string;
}

type Phase = "connectNeo4j" | "connectChroma" | "fetch" | "embed";

interface PhaseEntry {
	phase: Phase;
	label: string;
	status: StepStatus;
	detail: string;
}

const STEP_LABELS: Record<Phase, string> = {
	connectNeo4j: "Connect to Neo4j",
	connectChroma: "Connect to ChromaDB",
	fetch: "Fetch embeddable entities",
	embed: "Embed & index in ChromaDB",
};

const PHASE_ORDER: Phase[] = ["connectNeo4j", "connectChroma", "fetch", "embed"];

// ─── Provider factory ────────────────────────────────────────────────────────

function createProvider(providerName: string, modelOverride?: string): EmbeddingProvider {
	switch (providerName) {
		case "openai": {
			const apiKey = process.env.OPENAI_API_KEY;
			if (!apiKey) {
				console.error(
					"OPENAI_API_KEY is not set. Add it to your .env file.",
				);
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
				console.error(
					"SILICONFLOW_API_KEY is not set. Add it to your .env file.",
				);
				process.exit(1);
			}
			return createSiliconFlowEmbeddingProvider({
				apiKey,
				...(modelOverride ? { model: modelOverride } : {}),
			});
		}
	}
}

// ─── UI component ────────────────────────────────────────────────────────────

interface EmbedUIProps {
	options: EmbedOptions;
	onComplete?: (action: PostRunAction) => void;
	nextPhaseLabel?: string;
}

function EmbedUI({ options, onComplete, nextPhaseLabel }: EmbedUIProps) {
	const { exit } = useApp();

	const [donePhases, setDonePhases] = useState<PhaseEntry[]>([]);
	const [activePhase, setActivePhase] = useState<Phase>("connectNeo4j");
	const [activeDetail, setActiveDetail] = useState("");

	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const [summary, setSummary] = useState<
		Array<{ label: string; value: string | number }>
	>([]);
	const [embedProgress, setEmbedProgress] = useState<{
		done: number;
		total: number;
	} | null>(null);

	function completePhase(phase: Phase, detail: string, status: StepStatus = "done") {
		setDonePhases((prev) => [
			...prev,
			{ phase, label: STEP_LABELS[phase], status, detail },
		]);
		const nextIdx = PHASE_ORDER.indexOf(phase) + 1;
		if (nextIdx < PHASE_ORDER.length) {
			setActivePhase(PHASE_ORDER[nextIdx]!);
			setActiveDetail("");
		}
	}

	function failPhase(phase: Phase, detail: string) {
		setDonePhases((prev) => [
			...prev,
			{ phase, label: STEP_LABELS[phase], status: "failed", detail },
		]);
	}

	useEffect(() => {
		run().catch((err) => {
			setError(err instanceof Error ? err.message : String(err));
			exit();
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function run() {
		const providerName = options.provider ?? "siliconflow";
		const provider = createProvider(providerName, options.model || undefined);

		// ── 1. Connect to Neo4j ──────────────────────────────────────────
		setActiveDetail(NEO4J_URI);
		const driver = neo4j.driver(
			NEO4J_URI,
			neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
		);
		try {
			await driver.verifyConnectivity();
		} catch {
			failPhase("connectNeo4j", "could not reach Neo4j — is Docker running?");
			await driver.close();
			exit(new Error("Neo4j unreachable"));
			return;
		}
		completePhase("connectNeo4j", NEO4J_URI);

		// ── 2. Connect to ChromaDB ───────────────────────────────────────
		const chromaClient = createChromaClient();
		try {
			await verifyChromaConnectivity(chromaClient);
		} catch {
			failPhase("connectChroma", "could not reach ChromaDB — is Docker running?");
			await driver.close();
			exit(new Error("ChromaDB unreachable"));
			return;
		}
		completePhase("connectChroma", process.env.CHROMA_URL ?? "http://localhost:8000");

		// ── 3. Fetch embeddable entities ─────────────────────────────────
		setActiveDetail("querying Neo4j...");
		const entities = await fetchEmbeddableNodes(driver);

		if (entities.length === 0) {
			completePhase("fetch", "0 entities found — run `codex ingest` first");
			completePhase("embed", "nothing to embed");
			await driver.close();
			setDone(true);
			exit();
			return;
		}

		const labelCounts = new Map<string, number>();
		for (const e of entities) {
			labelCounts.set(e.label, (labelCounts.get(e.label) ?? 0) + 1);
		}
		const breakdown = Array.from(labelCounts.entries())
			.map(([l, c]) => `${c} ${l}`)
			.join(", ");
		completePhase("fetch", `${entities.length} entities (${breakdown})`);

		// ── 4. Embed & index ─────────────────────────────────────────────
		setActiveDetail(`${provider.providerName} / ${provider.modelId}`);

		let stats: EmbedStats;
		try {
			stats = await runEmbeddingPipeline({
				driver,
				chromaClient,
				embeddingProvider: provider,
				clean: options.clean,
				onProgress: (embedded, total) => {
					setEmbedProgress({ done: embedded, total });
					setActiveDetail(`${embedded} / ${total} entities`);
				},
				onRetry: (attempt, delayMs) => {
					setActiveDetail(`retry ${attempt} in ${delayMs}ms...`);
				},
			});
		} catch (err) {
			failPhase("embed", err instanceof Error ? err.message : String(err));
			await driver.close();
			exit(new Error("Embedding pipeline failed"));
			return;
		}

		setEmbedProgress(null);
		completePhase(
			"embed",
			`${stats.entitiesEmbedded} embedded · ${stats.totalTokens} tokens · ${stats.durationMs}ms`,
		);

		await driver.close();

		// ── Summary ──────────────────────────────────────────────────────
		const summaryRows: Array<{ label: string; value: string | number }> =
			[
				{ label: "Provider", value: provider.providerName },
				{ label: "Model", value: stats.model },
				{
					label: "Entities embedded",
					value: stats.entitiesEmbedded,
				},
				{ label: "Tokens consumed", value: stats.totalTokens },
				{
					label: "Estimated cost",
					value: `$${stats.estimatedCost.toFixed(4)}`,
				},
				{ label: "Collection", value: stats.collectionName },
				{ label: "Duration", value: `${stats.durationMs}ms` },
			];

		if (stats.entitiesFailed > 0) {
			summaryRows.push({
				label: "Failures",
				value: stats.entitiesFailed,
			});
		}

		setSummary(summaryRows);
		setDone(true);
		// If no post-run handler, exit immediately (direct CLI usage)
		if (!onComplete) exit();
	}

	return (
		<Layout showHeader={false} command="embed" showTokenTicker={true}>
			{/* Completed steps — rendered once via Static */}
			<Static items={donePhases}>
				{(entry) => (
					<Step
						key={entry.phase}
						label={entry.label}
						status={entry.status}
						detail={entry.detail}
					/>
				)}
			</Static>

			{/* Active step */}
			{!done && (
				<Box flexDirection="column">
					<Step
						label={STEP_LABELS[activePhase]}
						status="running"
						detail={activeDetail}
					/>
					{activePhase === "embed" && embedProgress && embedProgress.total > 0 && (
						<Box paddingLeft={2}>
							<ProgressBar
								value={embedProgress.done / embedProgress.total}
								width={24}
							/>
						</Box>
					)}
				</Box>
			)}

			{error && (
				<Box marginTop={1}>
					<Text color="red">Error: {error}</Text>
				</Box>
			)}

			{done && <SummaryTable title="Run summary" rows={summary} />}

			{done && onComplete && (
				<PostRunOptions
					nextPhaseLabel={nextPhaseLabel}
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

export function runEmbed(options: EmbedOptions) {
	if (!NEO4J_PASSWORD) {
		console.error("NEO4J_PASSWORD is not set. Add it to your .env file.");
		process.exit(1);
	}
	render(
		<EmbedUI
			options={options}
			onComplete={options.onComplete}
			nextPhaseLabel={options.nextPhaseLabel}
		/>,
	);
}
