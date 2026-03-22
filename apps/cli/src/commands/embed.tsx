/**
 * @fileoverview CLI `embed` command — generates vector embeddings for all
 * graph entities and indexes them in ChromaDB.
 *
 * Requires a prior `ingest` run to populate Neo4j with entities.
 * The token ticker footer shows live embedding token consumption.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, render, useApp } from "ink";
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
	onComplete?: (action: PostRunAction) => void;
	nextPhaseLabel?: string;
}

type Phase = "connectNeo4j" | "connectChroma" | "fetch" | "embed";

interface PhaseState {
	status: StepStatus;
	detail: string;
}

// ─── Provider factory ────────────────────────────────────────────────────────

function createProvider(providerName: string): EmbeddingProvider {
	switch (providerName) {
		case "openai": {
			const apiKey = process.env.OPENAI_API_KEY;
			if (!apiKey) {
				console.error(
					"OPENAI_API_KEY is not set. Add it to your .env file.",
				);
				process.exit(1);
			}
			return createOpenAIEmbeddingProvider({ apiKey });
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
			return createSiliconFlowEmbeddingProvider({ apiKey });
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

	const [phases, setPhases] = useState<Record<Phase, PhaseState>>({
		connectNeo4j: { status: "pending", detail: "" },
		connectChroma: { status: "pending", detail: "" },
		fetch: { status: "pending", detail: "" },
		embed: { status: "pending", detail: "" },
	});

	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const [summary, setSummary] = useState<
		Array<{ label: string; value: string | number }>
	>([]);
	const [embedProgress, setEmbedProgress] = useState<{
		done: number;
		total: number;
	} | null>(null);

	const set = (phase: Phase, patch: Partial<PhaseState>) =>
		setPhases((prev) => ({
			...prev,
			[phase]: { ...prev[phase], ...patch },
		}));

	useEffect(() => {
		run().catch((err) => {
			setError(err instanceof Error ? err.message : String(err));
			exit();
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function run() {
		const providerName = options.provider ?? "siliconflow";
		const provider = createProvider(providerName);

		// ── 1. Connect to Neo4j ──────────────────────────────────────────
		set("connectNeo4j", { status: "running", detail: NEO4J_URI });
		const driver = neo4j.driver(
			NEO4J_URI,
			neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
		);
		try {
			await driver.verifyConnectivity();
		} catch {
			set("connectNeo4j", {
				status: "failed",
				detail: "could not reach Neo4j — is Docker running?",
			});
			await driver.close();
			exit(new Error("Neo4j unreachable"));
			return;
		}
		set("connectNeo4j", { status: "done", detail: NEO4J_URI });

		// ── 2. Connect to ChromaDB ───────────────────────────────────────
		set("connectChroma", { status: "running", detail: "" });
		const chromaClient = createChromaClient();
		try {
			await verifyChromaConnectivity(chromaClient);
		} catch {
			set("connectChroma", {
				status: "failed",
				detail: "could not reach ChromaDB — is Docker running?",
			});
			await driver.close();
			exit(new Error("ChromaDB unreachable"));
			return;
		}
		set("connectChroma", {
			status: "done",
			detail: process.env.CHROMA_URL ?? "http://localhost:8000",
		});

		// ── 3. Fetch embeddable entities ─────────────────────────────────
		set("fetch", { status: "running", detail: "querying Neo4j..." });
		const entities = await fetchEmbeddableNodes(driver);

		if (entities.length === 0) {
			set("fetch", {
				status: "done",
				detail: "0 entities found — run `codex ingest` first",
			});
			set("embed", { status: "done", detail: "nothing to embed" });
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
		set("fetch", {
			status: "done",
			detail: `${entities.length} entities (${breakdown})`,
		});

		// ── 4. Embed & index ─────────────────────────────────────────────
		set("embed", {
			status: "running",
			detail: `${provider.providerName} / ${provider.modelId}`,
		});

		let stats: EmbedStats;
		try {
			stats = await runEmbeddingPipeline({
				driver,
				chromaClient,
				embeddingProvider: provider,
				clean: options.clean,
				onProgress: (embedded, total) => {
					setEmbedProgress({ done: embedded, total });
					set("embed", {
						status: "running",
						detail: `${embedded} / ${total} entities`,
					});
				},
				onRetry: (attempt, delayMs) => {
					set("embed", {
						status: "running",
						detail: `retry ${attempt} in ${delayMs}ms...`,
					});
				},
			});
		} catch (err) {
			set("embed", {
				status: "failed",
				detail:
					err instanceof Error ? err.message : String(err),
			});
			await driver.close();
			exit(new Error("Embedding pipeline failed"));
			return;
		}

		setEmbedProgress(null);
		set("embed", {
			status: stats.entitiesFailed > 0 ? "done" : "done",
			detail: `${stats.entitiesEmbedded} embedded · ${stats.totalTokens} tokens · ${stats.durationMs}ms`,
		});

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

	const STEP_LABELS: Record<Phase, string> = {
		connectNeo4j: "Connect to Neo4j",
		connectChroma: "Connect to ChromaDB",
		fetch: "Fetch embeddable entities",
		embed: "Embed & index in ChromaDB",
	};

	return (
		<Layout showHeader={false} command="embed" showTokenTicker={true}>
			<Box flexDirection="column" paddingY={1}>
				<Box flexDirection="column" marginTop={1}>
					{(Object.keys(phases) as Phase[]).map((phase) => (
						<React.Fragment key={phase}>
							<Step
								label={STEP_LABELS[phase]}
								status={phases[phase].status}
								detail={phases[phase].detail}
							/>
							{phase === "embed" &&
								phases[phase].status === "running" &&
								embedProgress &&
								embedProgress.total > 0 && (
									<Box paddingLeft={2}>
										<ProgressBar
											value={
												embedProgress.done /
												embedProgress.total
											}
											width={24}
										/>
									</Box>
								)}
						</React.Fragment>
					))}
				</Box>

				{error && (
					<Box marginTop={1}>
						<Text color="red">Error: {error}</Text>
					</Box>
				)}

				{done && <SummaryTable title="Summary" rows={summary} />}

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
			</Box>
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
