import { useState, useEffect, useRef } from "react";
import { Box, Text, Static, render, useApp } from "ink";
import neo4j from "neo4j-driver";
import path from "node:path";
import { mine } from "@codex/git-miner";
import { insertMineResults, countFileNodes, clearMineData } from "@codex/graph-client";
import { Step, ProgressBar, SummaryTable, type StepStatus } from "../ui/Progress.js";
import { Layout } from "../ui/Layout.js";
import { PostRunOptions, type PostRunAction } from "../ui/PostRunOptions.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MineCommandOptions {
	since?: string;
	maxCommits?: number;
	clean?: boolean;
}

type Phase = "connect" | "validate" | "log" | "blame" | "compute" | "insert";

interface PhaseEntry {
	phase: Phase;
	label: string;
	status: StepStatus;
	detail: string;
}

const STEP_LABELS: Record<Phase, string> = {
	connect: "Connect to Neo4j",
	validate: "Validate graph state",
	log: "Extract git history",
	blame: "Analyze file ownership",
	compute: "Compute expertise (DOA)",
	insert: "Insert into Neo4j",
};

// ─── UI component ─────────────────────────────────────────────────────────────

interface MineUIProps {
	targetPath: string;
	options: MineCommandOptions;
	onComplete?: (action: PostRunAction) => void;
	nextPhaseLabel?: string;
}

function MineUI({ targetPath, options, onComplete, nextPhaseLabel }: MineUIProps) {
	const { exit } = useApp();

	const [donePhases, setDonePhases] = useState<PhaseEntry[]>([]);
	const [activePhase, setActivePhase] = useState<Phase>("connect");
	const [activeDetail, setActiveDetail] = useState("");

	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const [blameProgress, setBlameProgress] = useState<{ done: number; total: number } | null>(null);
	const [summary, setSummary] = useState<Array<{ label: string; value: string | number }>>([]);
	const [failureSites, setFailureSites] = useState<Array<{ title: string; files: string[] }>>([]);

	// Track which phases have already been pushed to Static (to avoid duplicates in callbacks)
	const pushedRef = useRef<Set<Phase>>(new Set());

	function completePhase(phase: Phase, detail: string, status: StepStatus = "done") {
		if (pushedRef.current.has(phase)) return;
		pushedRef.current.add(phase);
		setDonePhases((prev) => [
			...prev,
			{ phase, label: STEP_LABELS[phase], status, detail },
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
			completePhase("connect", "could not reach Neo4j — is Docker running?", "failed");
			await driver.close();
			exit(new Error("Neo4j unreachable"));
			return;
		}
		completePhase("connect", NEO4J_URI);
		setActivePhase("validate");

		// ── 2. Validate graph state ───────────────────────────────────────
		setActiveDetail("Checking for ingested files…");
		const fileCount = await countFileNodes(driver);
		if (fileCount === 0) {
			completePhase("validate", "No File nodes found — run `codex ingest <path>` first", "failed");
			await driver.close();
			exit(new Error("Graph is empty — run ingest first"));
			return;
		}
		if (options.clean) {
			setActiveDetail("Clearing existing mine data…");
			await clearMineData(driver);
		}
		completePhase("validate", `${fileCount} File nodes found${options.clean ? " · cleared" : ""}`);
		setActivePhase("log");

		// ── 3-5. Run mining pipeline ──────────────────────────────────────
		setActiveDetail("Reading git log…");

		let finalLogDetail = "";
		let finalBlameDetail = "";

		const result = await mine(absPath, driver, {
			since: options.since,
			maxCommits: options.maxCommits,
			onProgress: (progress) => {
				switch (progress.phase) {
					case "log":
						finalLogDetail = progress.detail ?? "";
						setActiveDetail(finalLogDetail);
						break;
					case "blame":
						completePhase("log", finalLogDetail || "complete");
						setActivePhase("blame");
						finalBlameDetail = progress.detail ?? "";
						setActiveDetail(finalBlameDetail);
						setBlameProgress({ done: progress.current, total: progress.total });
						break;
					case "map":
						setBlameProgress(null);
						completePhase("blame", finalBlameDetail || "complete");
						setActivePhase("compute");
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

		// Flush any remaining in-flight phases with final stats
		const logFinal = `${result.stats.commits} commits · ${result.stats.developers} developers`;
		const blameFinal = `${result.stats.filesBlamed} files · ${result.stats.blameFailures} skipped`;
		const computeFinal = `${result.stats.expertiseEdges} expertise edges · Truck Factor: ${result.truckFactor.truckFactor}`;

		completePhase("log", logFinal);
		completePhase("blame", blameFinal);
		completePhase("compute", computeFinal);
		setBlameProgress(null);
		setActivePhase("insert");
		setActiveDetail("Writing to Neo4j…");

		// ── 6. Insert ─────────────────────────────────────────────────────
		const insertStats = await insertMineResults(driver, result);
		completePhase(
			"insert",
			`${insertStats.developersInserted} devs · ${insertStats.commitsInserted} commits · ${insertStats.expertiseEdges} expertise · ${insertStats.durationMs}ms`,
		);

		await driver.close();

		setSummary([
			{ label: "Target", value: absPath },
			{ label: "Developers", value: insertStats.developersInserted },
			{ label: "Commits", value: insertStats.commitsInserted },
			{ label: "Expertise edges", value: insertStats.expertiseEdges },
			{ label: "MODIFIED edges", value: insertStats.modifiedEdges },
			{ label: "Truck Factor", value: result.truckFactor.truckFactor },
			{
				label: "Critical devs",
				value: result.truckFactor.criticalDevelopers.slice(0, 3).join(", ") || "—",
			},
			{ label: "Churn files updated", value: insertStats.churnFilesUpdated },
			{ label: "Duration", value: `${result.stats.durationMs}ms` },
		]);

		const sites: Array<{ title: string; files: string[] }> = [];
		if (result.stats.blameFailureFiles.length > 0)
			sites.push({ title: "Blame failures (binary/deleted)", files: result.stats.blameFailureFiles });
		if (result.stats.noEntityFiles.length > 0)
			sites.push({ title: "Files with no entity nodes (barrel/config files)", files: result.stats.noEntityFiles });
		setFailureSites(sites);
		setDone(true);
		if (!onComplete) exit();
	}

	return (
		<Layout showHeader={false} command="mine" showTokenTicker={false}>
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

			{/* Active step + optional blame progress bar */}
			{!done && (
				<Box flexDirection="column">
					<Step label={STEP_LABELS[activePhase]} status="running" detail={activeDetail} />
					{activePhase === "blame" && blameProgress && blameProgress.total > 0 && (
						<Box paddingLeft={2}>
							<ProgressBar value={blameProgress.done / blameProgress.total} width={24} />
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

			{done && failureSites.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold color="yellow">Failure breakdown</Text>
					{failureSites.map((site) => (
						<Box key={site.title} flexDirection="column" marginTop={1}>
							<Text color="yellow">  {site.title} ({site.files.length})</Text>
							{site.files.map((f) => (
								<Text key={f} dimColor>    {f}</Text>
							))}
						</Box>
					))}
				</Box>
			)}

			{done && !onComplete && (
				<Box marginTop={1}>
					<Text color="yellow">Tip: </Text>
					<Text dimColor>Run </Text>
					<Text color="cyan">codex embed</Text>
					<Text dimColor> to update file metadata with churn data.</Text>
				</Box>
			)}

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

export interface MineRunOptions extends MineCommandOptions {
	onComplete?: (action: PostRunAction) => void;
	nextPhaseLabel?: string;
}

export function runMine(targetPath: string, options: MineRunOptions = {}) {
	if (!NEO4J_PASSWORD) {
		console.error("NEO4J_PASSWORD is not set. Add it to your .env file.");
		process.exit(1);
	}
	render(
		<MineUI
			targetPath={targetPath}
			options={options}
			onComplete={options.onComplete}
			nextPhaseLabel={options.nextPhaseLabel}
		/>,
	);
}
