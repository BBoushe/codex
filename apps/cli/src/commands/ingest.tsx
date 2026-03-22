import React, { useState, useEffect } from "react";
import { Box, Text, render, useApp } from "ink";
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

interface PhaseState {
	status: StepStatus;
	detail: string;
}

// ─── UI component ────────────────────────────────────────────────────────────

interface IngestUIProps {
	targetPath: string;
	options: IngestOptions;
	onComplete?: (action: PostRunAction) => void;
	nextPhaseLabel?: string;
}

function IngestUI({ targetPath, options, onComplete, nextPhaseLabel }: IngestUIProps) {
	const { exit } = useApp();

	const [phases, setPhases] = useState<Record<Phase, PhaseState>>({
		connect: { status: "pending", detail: "" },
		schema: { status: "pending", detail: "" },
		parse: { status: "pending", detail: "" },
		insert: { status: "pending", detail: "" },
	});

	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const [summary, setSummary] = useState<
		Array<{ label: string; value: string | number }>
	>([]);
	const [parseProgress, setParseProgress] = useState<{
		done: number;
		total: number;
	} | null>(null);

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
			set("connect", {
				status: "failed",
				detail: "could not reach Neo4j — is Docker running?",
			});
			await driver.close();
			exit(new Error("Neo4j unreachable"));
			return;
		}
		set("connect", { status: "done", detail: NEO4J_URI });

		// ── 2. Schema ─────────────────────────────────────────────────────
		set("schema", { status: "running", detail: "" });
		const schemaResult = await initializeSchema(driver);
		set("schema", {
			status: "done",
			detail: `${schemaResult.statementsRun} statements`,
		});

		// ── 3. Parse ──────────────────────────────────────────────────────
		set("parse", { status: "running", detail: absPath });
		if (options.clean) {
			await clearGraph(driver);
		}
		const { files, stats: parseStats } = await parseProject(absPath, {
			onProgress: (parsed, total) => {
				setParseProgress({ done: parsed, total });
				set("parse", {
					status: "running",
					detail: `${parsed} / ${total} files`,
				});
			},
		});
		setParseProgress(null);
		set("parse", {
			status: "done",
			detail: `${parseStats.filesParsed} files · ${parseStats.totalEntities} entities · ${parseStats.totalRelationships} relationships`,
		});

		// ── 4. Insert ─────────────────────────────────────────────────────
		set("insert", { status: "running", detail: "" });
		const insertStats = await insertParseResults(driver, files);
		set("insert", {
			status: "done",
			detail: `${insertStats.nodesInserted} nodes · ${insertStats.edgesInserted} edges · ${insertStats.durationMs}ms`,
		});

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
		// If no post-run handler, exit immediately (direct CLI usage)
		if (!onComplete) exit();
	}

	const STEP_LABELS: Record<Phase, string> = {
		connect: "Connect to Neo4j",
		schema: "Initialize schema",
		parse: "Parse source files",
		insert: "Insert into Neo4j",
	};

	return (
		<Layout showHeader={false} command="ingest" showTokenTicker={false}>
			<Box flexDirection="column" paddingY={1}>
				<Box flexDirection="column" marginTop={1}>
					{(Object.keys(phases) as Phase[]).map((phase) => (
						<React.Fragment key={phase}>
							<Step
								label={STEP_LABELS[phase]}
								status={phases[phase].status}
								detail={phases[phase].detail}
							/>
							{phase === "parse" &&
								phases[phase].status === "running" &&
								parseProgress &&
								parseProgress.total > 0 && (
									<Box paddingLeft={2}>
										<ProgressBar
											value={parseProgress.done / parseProgress.total}
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
