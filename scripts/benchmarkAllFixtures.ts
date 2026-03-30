#!/usr/bin/env bun
/**
 * @fileoverview Runs ingest/mine/embed/benchmark/validate across all parser fixtures
 * and writes a consolidated thesis metrics report.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface FixtureConfig {
	id: string;
	path: string;
	questionsFile: string;
}

interface StageResult {
	name: string;
	command: string;
	status: "passed" | "failed";
	durationMs: number;
	exitCode: number;
	failureMessage: string | null;
}

interface BenchmarkArtifact {
	generatedAt: string;
	repoLabel: string;
	totalDurationMs: number;
	summary: {
		vectorMRR_semantic: number;
		hybridMRR_semantic: number;
		intentAccuracy: number;
		fallbackCount: number;
	};
	results: Array<{
		type: string;
		hybridCorrect: boolean;
		inputTokens: number;
		outputTokens: number;
	}>;
}

interface ConsolidatedFixtureMetrics {
	fixture: string;
	benchmarkJsonPath: string;
	semanticVectorMrr: number;
	semanticHybridMrr: number;
	semanticMrrDelta: number;
	structuralCorrect: number;
	structuralTotal: number;
	structuralAccuracy: number;
	intentAccuracy: number;
	fallbackCount: number;
	totalTokens: number;
	semanticArchitecturalTotal: number;
	semanticArchitecturalCorrect: number;
	semanticArchitecturalCorrectRate: number;
	stageStatus: Record<string, "passed" | "failed">;
}

interface FixtureRunReport {
	fixture: string;
	targetPath: string;
	questionsFile: string;
	totalDurationMs: number;
	stages: StageResult[];
	metrics: ConsolidatedFixtureMetrics | null;
}

interface ConsolidatedReport {
	generatedAt: string;
	totalDurationMs: number;
	fixtures: FixtureRunReport[];
	metricsTable: ConsolidatedFixtureMetrics[];
	outputFiles: {
		jsonPath: string;
		mdPath: string;
	};
}

const cwd = process.cwd();
const fixtures: FixtureConfig[] = [
	{
		id: "fixture-ts-mini-app",
		path: "packages/parser/fixtures/mini-app",
		questionsFile: "packages/rag/src/benchmark/questions.json",
	},
	{
		id: "fixture-java-mini",
		path: "packages/parser/fixtures/mini-java",
		questionsFile:
			"packages/rag/src/benchmark/fixtures/questions.mini-java.json",
	},
	{
		id: "fixture-python-mini",
		path: "packages/parser/fixtures/mini-python",
		questionsFile:
			"packages/rag/src/benchmark/fixtures/questions.mini-python.json",
	},
];

async function main(): Promise<void> {
	const started = Date.now();
	const fixtureReports: FixtureRunReport[] = [];
	const metricsTable: ConsolidatedFixtureMetrics[] = [];

	for (const fixture of fixtures) {
		const report = await runFixture(fixture);
		fixtureReports.push(report);
		if (report.metrics) metricsTable.push(report.metrics);
	}

	const out = await writeConsolidatedArtifacts({
		generatedAt: new Date().toISOString(),
		totalDurationMs: Date.now() - started,
		fixtures: fixtureReports,
		metricsTable,
		outputFiles: { jsonPath: "", mdPath: "" },
	});

	console.log("\n══════════════════════════════════════════════════════");
	console.log("Fixture Benchmark Summary");
	console.log("══════════════════════════════════════════════════════");
	for (const row of metricsTable) {
		console.log(
			`${row.fixture.padEnd(22)} semantic MRR ${row.semanticVectorMrr.toFixed(3)} -> ${row.semanticHybridMrr.toFixed(3)} (Δ ${row.semanticMrrDelta >= 0 ? "+" : ""}${row.semanticMrrDelta.toFixed(3)}) | structural ${row.structuralCorrect}/${row.structuralTotal} (${(row.structuralAccuracy * 100).toFixed(1)}%) | intent ${(row.intentAccuracy * 100).toFixed(1)}% | quality proxy ${(row.semanticArchitecturalCorrectRate * 100).toFixed(1)}%`,
		);
	}
	console.log(`\nJSON report: ${out.jsonPath}`);
	console.log(`MD report:   ${out.mdPath}`);
}

async function runFixture(fixture: FixtureConfig): Promise<FixtureRunReport> {
	const started = Date.now();
	const stages: StageResult[] = [];
	const absoluteTarget = path.resolve(cwd, fixture.path);
	const absoluteQuestions = path.resolve(cwd, fixture.questionsFile);

	const commands = [
		{
			name: "ingest",
			command: `bun run apps/cli/src/index.ts ingest ${shellQuote(absoluteTarget)} --clean`,
		},
		{
			name: "mine",
			command: `bun run apps/cli/src/index.ts mine ${shellQuote(absoluteTarget)} --clean`,
		},
		{
			name: "embed",
			command: "bun run apps/cli/src/index.ts embed --clean",
		},
		{
			name: "benchmark",
			command: `BENCHMARK_REPO_LABEL=${shellQuote(fixture.id)} BENCHMARK_QUESTIONS_FILE=${shellQuote(absoluteQuestions)} bun run benchmark`,
		},
		{
			name: "rag:validate",
			command: "bun run rag:validate",
		},
	] as const;

	let benchmarkStdout = "";

	for (const stage of commands) {
		const result = await runStage(stage.name, stage.command);
		stages.push(result);
		if (stage.name === "benchmark") {
			benchmarkStdout = result.failureMessage
				? ""
				: (result.commandOutput ?? "");
		}
	}

	let metrics: ConsolidatedFixtureMetrics | null = null;
	const benchmarkStage = stages.find((s) => s.name === "benchmark");
	if (benchmarkStage?.status === "passed") {
		const benchmarkJsonPath = extractArtifactPath(
			benchmarkStdout,
			/^\s*JSON:\s+(.+)$/m,
		);
		if (benchmarkJsonPath) {
			metrics = await readFixtureMetrics(fixture.id, benchmarkJsonPath, stages);
		}
	}

	return {
		fixture: fixture.id,
		targetPath: absoluteTarget,
		questionsFile: absoluteQuestions,
		totalDurationMs: Date.now() - started,
		stages,
		metrics,
	};
}

async function runStage(
	name: string,
	command: string,
): Promise<StageResult & { commandOutput?: string }> {
	console.log(`\n▶ [${name}] ${command}`);
	const started = Date.now();
	const proc = Bun.spawn(["zsh", "-lc", command], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdoutText = await new Response(proc.stdout).text();
	const stderrText = await new Response(proc.stderr).text();
	if (stdoutText.length > 0) process.stdout.write(stdoutText);
	if (stderrText.length > 0) process.stderr.write(stderrText);

	const exitCode = await proc.exited;
	const durationMs = Date.now() - started;

	if (exitCode === 0) {
		return {
			name,
			command,
			status: "passed",
			durationMs,
			exitCode,
			failureMessage: null,
			commandOutput: `${stdoutText}\n${stderrText}`,
		};
	}

	return {
		name,
		command,
		status: "failed",
		durationMs,
		exitCode,
		failureMessage: `${stdoutText}\n${stderrText}`.trim().slice(-1200),
		commandOutput: `${stdoutText}\n${stderrText}`,
	};
}

async function readFixtureMetrics(
	fixtureId: string,
	benchmarkJsonPath: string,
	stages: StageResult[],
): Promise<ConsolidatedFixtureMetrics> {
	const content = await readFile(benchmarkJsonPath, "utf8");
	const benchmark = JSON.parse(content) as BenchmarkArtifact;
	const structuralRows = benchmark.results.filter(
		(r) => r.type === "structural",
	);
	const structuralCorrect = structuralRows.filter(
		(r) => r.hybridCorrect,
	).length;
	const structuralTotal = structuralRows.length;
	const semanticArchitecturalRows = benchmark.results.filter(
		(r) => r.type === "semantic" || r.type === "architectural",
	);
	const semanticArchitecturalCorrect = semanticArchitecturalRows.filter(
		(r) => r.hybridCorrect,
	).length;
	const semanticArchitecturalTotal = semanticArchitecturalRows.length;
	const totalTokens = benchmark.results.reduce(
		(sum, r) => sum + r.inputTokens + r.outputTokens,
		0,
	);

	const stageStatus: Record<string, "passed" | "failed"> = {};
	for (const stage of stages) {
		stageStatus[stage.name] = stage.status;
	}

	return {
		fixture: fixtureId,
		benchmarkJsonPath,
		semanticVectorMrr: benchmark.summary.vectorMRR_semantic,
		semanticHybridMrr: benchmark.summary.hybridMRR_semantic,
		semanticMrrDelta:
			benchmark.summary.hybridMRR_semantic -
			benchmark.summary.vectorMRR_semantic,
		structuralCorrect,
		structuralTotal,
		structuralAccuracy:
			structuralTotal > 0 ? structuralCorrect / structuralTotal : 0,
		intentAccuracy: benchmark.summary.intentAccuracy,
		fallbackCount: benchmark.summary.fallbackCount,
		totalTokens,
		semanticArchitecturalTotal,
		semanticArchitecturalCorrect,
		semanticArchitecturalCorrectRate:
			semanticArchitecturalTotal > 0
				? semanticArchitecturalCorrect / semanticArchitecturalTotal
				: 0,
		stageStatus,
	};
}

async function writeConsolidatedArtifacts(
	report: ConsolidatedReport,
): Promise<{ jsonPath: string; mdPath: string }> {
	const outDir = path.join(cwd, "scripts", "test-results", "benchmarks");
	await mkdir(outDir, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const jsonPath = path.join(outDir, `${ts}-fixtures-consolidated.json`);
	const mdPath = path.join(outDir, `${ts}-fixtures-consolidated.md`);

	const finalReport: ConsolidatedReport = {
		...report,
		outputFiles: { jsonPath, mdPath },
	};

	const md = buildMarkdown(finalReport);

	await Promise.all([
		writeFile(jsonPath, JSON.stringify(finalReport, null, 2), "utf8"),
		writeFile(mdPath, md, "utf8"),
	]);

	return { jsonPath, mdPath };
}

function buildMarkdown(report: ConsolidatedReport): string {
	const lines = [
		"# Fixture Benchmark Consolidated Report",
		"",
		`Generated: ${report.generatedAt}`,
		`Total duration: ${(report.totalDurationMs / 1000).toFixed(1)}s`,
		"",
		"## Thesis Metrics",
		"",
		"| Fixture | Semantic MRR (Vector) | Semantic MRR (Hybrid) | Semantic MRR Delta | Structural Accuracy | Intent Accuracy | Hybrid Quality Proxy (Semantic+Architectural) | Fallbacks |",
		"|---|---:|---:|---:|---:|---:|---:|---:|",
	];

	for (const row of report.metricsTable) {
		lines.push(
			`| ${row.fixture} | ${row.semanticVectorMrr.toFixed(3)} | ${row.semanticHybridMrr.toFixed(3)} | ${row.semanticMrrDelta >= 0 ? "+" : ""}${row.semanticMrrDelta.toFixed(3)} | ${row.structuralCorrect}/${row.structuralTotal} (${(row.structuralAccuracy * 100).toFixed(1)}%) | ${(row.intentAccuracy * 100).toFixed(1)}% | ${row.semanticArchitecturalCorrect}/${row.semanticArchitecturalTotal} (${(row.semanticArchitecturalCorrectRate * 100).toFixed(1)}%) | ${row.fallbackCount} |`,
		);
	}

	lines.push("", "## Fixture Details", "");
	for (const fixture of report.fixtures) {
		lines.push(`### ${fixture.fixture}`);
		lines.push(`- target: ${fixture.targetPath}`);
		lines.push(`- questions: ${fixture.questionsFile}`);
		lines.push(`- duration: ${(fixture.totalDurationMs / 1000).toFixed(1)}s`);
		lines.push("- stages:");
		for (const stage of fixture.stages) {
			lines.push(
				`  - ${stage.name}: ${stage.status} (${(stage.durationMs / 1000).toFixed(1)}s)`,
			);
		}
		if (fixture.metrics) {
			lines.push(`- benchmark JSON: ${fixture.metrics.benchmarkJsonPath}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function extractArtifactPath(stdout: string, pattern: RegExp): string | null {
	const match = stdout.match(pattern);
	if (!match?.[1]) return null;
	return match[1].trim();
}

function shellQuote(input: string): string {
	return `'${input.replaceAll("'", "'\\''")}'`;
}

void main().catch((err) => {
	console.error(err);
	process.exit(1);
});
