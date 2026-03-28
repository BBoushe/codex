import React, { useState, useEffect } from "react";
import { Box, Text, Static, render, useApp } from "ink";
import neo4j from "neo4j-driver";
import path from "node:path";
import { parseProject } from "@codex/parser";
import {
	initializeSchema,
	insertParseResults,
	clearGraph,
} from "@codex/graph-client";
import { Step, ProgressBar, SummaryTable, type StepStatus } from "../ui/Progress.js";
import { Layout } from "../ui/Layout.js";
import { PostRunOptions, type PostRunAction } from "../ui/PostRunOptions.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "";

// ─── Types ───────────────────────────────────────────────────────────────────

interface IngestOptions {
	clean: boolean;
}

type Phase = "connect" | "schema" | "parse" | "insert";

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
	insert: "Insert into Neo4j",
};

const PHASE_ORDER: Phase[] = ["connect", "schema", "parse", "insert"];

// ─── UI component ────────────────────────────────────────────────────────────

interface IngestUIProps {
	targetPath: string;
	options: IngestOptions;
	onComplete?: (action: PostRunAction) => void;
	nextPhaseLabel?: string;
}

function IngestUI({ targetPath, options, onComplete, nextPhaseLabel }: IngestUIProps) {
	const { exit } = useApp();

	// Completed phases rendered once via <Static> — no re-renders
	const [donePhases, setDonePhases] = useState<PhaseEntry[]>([]);
	// Active phase rendered normally
	const [activePhase, setActivePhase] = useState<Phase>("connect");
	const [activeDetail, setActiveDetail] = useState("");

	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const [summary, setSummary] = useState<
		Array<{ label: string; value: string | number }>
	>([]);
	const [parseProgress, setParseProgress] = useState<{
		done: number;
		total: number;
	} | null>(null);

	/** Mark the current phase done and move to the next. */
	function completePhase(phase: Phase, detail: string) {
		setDonePhases((prev) => [
			...prev,
			{ phase, label: STEP_LABELS[phase], status: "done", detail },
		]);
		const nextIdx = PHASE_ORDER.indexOf(phase) + 1;
		if (nextIdx < PHASE_ORDER.length) {
			setActivePhase(PHASE_ORDER[nextIdx]!);
			setActiveDetail("");
		}
	}

	useEffect(() => {
		run().catch((err) => {
			setError(err instanceof Error ? err.message : String(err));
			exit();
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function run() {
		const absPath = path.resolve(targetPath);

		// ── 1. Connect ────────────────────────────────────────────────────
		setActiveDetail(NEO4J_URI);
		const driver = neo4j.driver(
			NEO4J_URI,
			neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
		);
		try {
			await driver.verifyConnectivity();
		} catch {
			setDonePhases((prev) => [
				...prev,
				{
					phase: "connect",
					label: STEP_LABELS.connect,
					status: "failed",
					detail: "could not reach Neo4j — is Docker running?",
				},
			]);
			await driver.close();
			exit(new Error("Neo4j unreachable"));
			return;
		}
		completePhase("connect", NEO4J_URI);

		// ── 2. Schema ─────────────────────────────────────────────────────
		const schemaResult = await initializeSchema(driver);
		completePhase("schema", `${schemaResult.statementsRun} statements`);

		// ── 3. Parse ──────────────────────────────────────────────────────
		setActiveDetail(absPath);
		if (options.clean) {
			await clearGraph(driver);
		}
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

		// ── 4. Insert ─────────────────────────────────────────────────────
		const insertStats = await insertParseResults(driver, files);
		completePhase(
			"insert",
			`${insertStats.nodesInserted} nodes · ${insertStats.edgesInserted} edges · ${insertStats.durationMs}ms`,
		);

		await driver.close();

		setSummary([
			{ label: "Target", value: absPath },
			{ label: "Files parsed", value: parseStats.filesParsed },
			{ label: "Entities", value: parseStats.totalEntities },
			{ label: "Relationships", value: parseStats.totalRelationships },
			{ label: "Nodes → Neo4j", value: insertStats.nodesInserted },
			{ label: "Edges → Neo4j", value: insertStats.edgesInserted },
			{
				label: "Duration",
				value: `${parseStats.totalDurationMs + insertStats.durationMs}ms`,
			},
		]);
		setDone(true);
		if (!onComplete) exit();
	}

	return (
		<Layout showHeader={false} command="ingest" showTokenTicker={false}>
			{/* Completed steps — rendered once, never re-drawn */}
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

			{/* Active step + optional progress bar */}
			{!done && (
				<Box flexDirection="column">
					<Step
						label={STEP_LABELS[activePhase]}
						status="running"
						detail={activeDetail}
					/>
					{activePhase === "parse" && parseProgress && parseProgress.total > 0 && (
						<Box paddingLeft={2}>
							<ProgressBar
								value={parseProgress.done / parseProgress.total}
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

export interface IngestRunOptions extends IngestOptions {
	onComplete?: (action: PostRunAction) => void;
	nextPhaseLabel?: string;
}

export function runIngest(targetPath: string, options: IngestRunOptions) {
	if (!NEO4J_PASSWORD) {
		console.error("NEO4J_PASSWORD is not set. Add it to your .env file.");
		process.exit(1);
	}
	render(
		<IngestUI
			targetPath={targetPath}
			options={options}
			onComplete={options.onComplete}
			nextPhaseLabel={options.nextPhaseLabel}
		/>,
	);
}
