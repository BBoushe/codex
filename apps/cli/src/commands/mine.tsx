import React, { useState, useEffect } from "react";
import { Box, Text, render, useApp } from "ink";
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

interface PhaseState {
	status: StepStatus;
	detail: string;
}

// ─── UI component ─────────────────────────────────────────────────────────────

interface MineUIProps {
	targetPath: string;
	options: MineCommandOptions;
	onComplete?: (action: PostRunAction) => void;
	nextPhaseLabel?: string;
}

function MineUI({ targetPath, options, onComplete, nextPhaseLabel }: MineUIProps) {
	const { exit } = useApp();

	const [phases, setPhases] = useState<Record<Phase, PhaseState>>({
		connect: { status: "pending", detail: "" },
		validate: { status: "pending", detail: "" },
		log: { status: "pending", detail: "" },
		blame: { status: "pending", detail: "" },
		compute: { status: "pending", detail: "" },
		insert: { status: "pending", detail: "" },
	});

	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const [blameProgress, setBlameProgress] = useState<{ done: number; total: number } | null>(null);
	const [summary, setSummary] = useState<Array<{ label: string; value: string | number }>>([]);
	const [failureSites, setFailureSites] = useState<Array<{ title: string; files: string[] }>>([]);

	const set = (phase: Phase, patch: Partial<PhaseState>) =>
		setPhases((prev) => ({ ...prev, [phase]: { ...prev[phase], ...patch } }));

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
		set("connect", { status: "running", detail: NEO4J_URI });
		const driver = neo4j.driver(
			NEO4J_URI,
			neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
		);
		try {
			await driver.verifyConnectivity();
		} catch {
			set("connect", { status: "failed", detail: "could not reach Neo4j — is Docker running?" });
			await driver.close();
			exit(new Error("Neo4j unreachable"));
			return;
		}
		set("connect", { status: "done", detail: NEO4J_URI });

		// ── 2. Validate graph state ───────────────────────────────────────
		set("validate", { status: "running", detail: "Checking for ingested files…" });
		const fileCount = await countFileNodes(driver);
		if (fileCount === 0) {
			set("validate", {
				status: "failed",
				detail: "No File nodes found — run `codex ingest <path>` first",
			});
			await driver.close();
			exit(new Error("Graph is empty — run ingest first"));
			return;
		}
		if (options.clean) {
			set("validate", { status: "running", detail: "Clearing existing mine data…" });
			await clearMineData(driver);
		}
		set("validate", { status: "done", detail: `${fileCount} File nodes found${options.clean ? " · cleared" : ""}` });

		// ── 3-5. Run mining pipeline ──────────────────────────────────────
		set("log", { status: "running", detail: "Reading git log…" });

		// Accumulate phase detail from progress callbacks for display
		let logDetail = "";
		let blameDetail = "";
		let computeDetail = "";

		const result = await mine(absPath, driver, {
			since: options.since,
			maxCommits: options.maxCommits,
			onProgress: (progress) => {
				switch (progress.phase) {
					case "log":
						logDetail = progress.detail ?? "";
						set("log", { status: "running", detail: logDetail });
						break;
					case "blame":
						set("log", { status: "done", detail: logDetail });
						blameDetail = progress.detail ?? "";
						set("blame", { status: "running", detail: blameDetail });
						setBlameProgress({ done: progress.current, total: progress.total });
						break;
					case "map":
						setBlameProgress(null);
						set("blame", { status: "done", detail: blameDetail });
						set("compute", { status: "running", detail: progress.detail ?? "" });
						break;
					case "doa":
						computeDetail = progress.detail ?? "";
						set("compute", { status: "running", detail: computeDetail });
						break;
					default:
						break;
				}
			},
		});

		// Ensure all mining phases show "done" regardless of progress timing
		set("log", { status: "done", detail: `${result.stats.commits} commits · ${result.stats.developers} developers` });
		setBlameProgress(null);
		set("blame", {
			status: "done",
			detail: `${result.stats.filesBlamed} files · ${result.stats.blameFailures} skipped`,
		});
		set("compute", {
			status: "done",
			detail: `${result.stats.expertiseEdges} expertise edges · Truck Factor: ${result.truckFactor.truckFactor}`,
		});

		// ── 6. Insert ─────────────────────────────────────────────────────
		set("insert", { status: "running", detail: "Writing to Neo4j…" });
		const insertStats = await insertMineResults(driver, result);
		set("insert", {
			status: "done",
			detail: `${insertStats.developersInserted} devs · ${insertStats.commitsInserted} commits · ${insertStats.expertiseEdges} expertise · ${insertStats.durationMs}ms`,
		});

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

		// Collect per-site failure lists (only non-empty ones)
		const sites: Array<{ title: string; files: string[] }> = [];
		if (result.stats.blameFailureFiles.length > 0)
			sites.push({ title: "Blame failures (binary/deleted)", files: result.stats.blameFailureFiles });
		if (result.stats.noEntityFiles.length > 0)
			sites.push({ title: "Files with no entity nodes (barrel/config files)", files: result.stats.noEntityFiles });
		setFailureSites(sites);
		setDone(true);
		if (!onComplete) exit();
	}

	const STEP_LABELS: Record<Phase, string> = {
		connect: "Connect to Neo4j",
		validate: "Validate graph state",
		log: "Extract git history",
		blame: "Analyze file ownership",
		compute: "Compute expertise (DOA)",
		insert: "Insert into Neo4j",
	};

	return (
		<Layout showHeader={false} command="mine" showTokenTicker={false}>
			<Box flexDirection="column" paddingY={1}>
				<Box flexDirection="column" marginTop={1}>
					{(Object.keys(phases) as Phase[]).map((phase) => (
						<React.Fragment key={phase}>
							<Step
								label={STEP_LABELS[phase]}
								status={phases[phase].status}
								detail={phases[phase].detail}
							/>
							{phase === "blame" &&
								phases[phase].status === "running" &&
								blameProgress &&
								blameProgress.total > 0 && (
									<Box paddingLeft={2}>
										<ProgressBar
											value={blameProgress.done / blameProgress.total}
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
