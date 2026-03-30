#!/usr/bin/env bun
/**
 * @fileoverview Week 15 integrated validation runner.
 *
 * Runs the required sequence:
 *   ingest -> mine -> embed -> benchmark -> rag:validate
 *
 * Produces a versioned JSON report under scripts/test-results/benchmarks/
 * with stage durations, statuses, and failure-site details.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface StageResult {
	name: string;
	command: string;
	status: "passed" | "failed" | "skipped";
	durationMs: number;
	exitCode: number;
	failureSite: string | null;
	failureMessage: string | null;
}

interface ValidationReport {
	generatedAt: string;
	targetPath: string;
	repoLabel: string;
	totalDurationMs: number;
	stages: StageResult[];
	summary: {
		passed: number;
		failed: number;
		skipped: number;
	};
}

const cwd = process.cwd();
const targetPath = process.argv[2] ?? "/tmp/codex-test-Mabis.Frontend";
const repoLabel = sanitizeLabel(path.basename(targetPath) || "fixture");

const stages = [
	{
		name: "ingest",
		command: `bun run apps/cli/src/index.ts ingest ${shellQuote(targetPath)} --clean`,
	},
	{
		name: "mine",
		command: `bun run apps/cli/src/index.ts mine ${shellQuote(targetPath)} --clean`,
	},
	{
		name: "embed",
		command: "bun run apps/cli/src/index.ts embed --clean",
	},
	{
		name: "benchmark",
		command: `BENCHMARK_REPO_LABEL=${shellQuote(repoLabel)} bun run benchmark`,
	},
	{
		name: "rag:validate",
		command: "bun run rag:validate",
	},
] as const;

async function main(): Promise<void> {
	const started = Date.now();
	const results: StageResult[] = [];
	let hasFailure = false;

	for (const stage of stages) {
		if (hasFailure) {
			results.push({
				name: stage.name,
				command: stage.command,
				status: "skipped",
				durationMs: 0,
				exitCode: 0,
				failureSite: null,
				failureMessage: "Skipped because an earlier blocking stage failed",
			});
			continue;
		}

		console.log(`\n▶ Stage: ${stage.name}`);
		console.log(`  ${stage.command}`);

		const result = await runStage(stage.name, stage.command);
		results.push(result);

		if (result.status === "failed") {
			hasFailure = true;
		}
	}

	const report: ValidationReport = {
		generatedAt: new Date().toISOString(),
		targetPath,
		repoLabel,
		totalDurationMs: Date.now() - started,
		stages: results,
		summary: {
			passed: results.filter((r) => r.status === "passed").length,
			failed: results.filter((r) => r.status === "failed").length,
			skipped: results.filter((r) => r.status === "skipped").length,
		},
	};

	const out = await writeReport(report);

	console.log("\n══════════════════════════════════════════════════════");
	console.log("Week 15 Validation Summary");
	console.log("══════════════════════════════════════════════════════");
	console.log(`Target: ${targetPath}`);
	console.log(`Passed: ${report.summary.passed}`);
	console.log(`Failed: ${report.summary.failed}`);
	console.log(`Skipped: ${report.summary.skipped}`);
	console.log(`Duration: ${(report.totalDurationMs / 1000).toFixed(1)}s`);
	console.log(`Report: ${out}`);

	if (report.summary.failed > 0) {
		for (const stage of report.stages.filter((s) => s.status === "failed")) {
			console.error(
				`\n✗ ${stage.name} failed @ ${stage.failureSite ?? "unknown"}`,
			);
			if (stage.failureMessage) {
				console.error(`  ${stage.failureMessage}`);
			}
		}
		process.exit(1);
	}
}

async function runStage(name: string, command: string): Promise<StageResult> {
	const started = Date.now();
	const proc = Bun.spawn(["zsh", "-lc", command], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdoutText = await new Response(proc.stdout).text();
	const stderrText = await new Response(proc.stderr).text();
	if (stdoutText.length > 0) {
		process.stdout.write(stdoutText);
	}
	if (stderrText.length > 0) {
		process.stderr.write(stderrText);
	}

	const exitCode = await proc.exited;
	const durationMs = Date.now() - started;

	if (exitCode === 0) {
		return {
			name,
			command,
			status: "passed",
			durationMs,
			exitCode,
			failureSite: null,
			failureMessage: null,
		};
	}

	const combined = `${stdoutText}\n${stderrText}`;
	const failureMessage =
		combined.trim().slice(-700) || "Command failed without output";
	return {
		name,
		command,
		status: "failed",
		durationMs,
		exitCode,
		failureSite: classifyFailureSite(combined),
		failureMessage,
	};
}

function classifyFailureSite(stderr: string): string {
	const text = stderr.toLowerCase();
	if (text.includes("site:") && text.includes("structural.")) {
		return "rag_validate_structural";
	}
	if (text.includes("site:") && text.includes("resolution.")) {
		return "rag_validate_resolution";
	}
	if (text.includes("site:") && text.includes("path.")) {
		return "rag_validate_path";
	}
	if (text.includes("site:") && text.includes("e2e.")) {
		return "rag_validate_e2e";
	}
	if (text.includes("intent_mismatch") || text.includes("intent routing")) {
		return "rag_intent_routing";
	}
	if (text.includes("result_miss") || text.includes("retrieval_miss")) {
		return "rag_retrieval_miss";
	}
	if (text.includes("failed to connect to chroma") || text.includes("chroma")) {
		return "chroma_connection";
	}
	if (
		text.includes("failed to connect to server") ||
		text.includes("neo4j") ||
		text.includes("bolt")
	) {
		return "neo4j_connection";
	}
	if (
		text.includes("siliconflow") ||
		text.includes("openai") ||
		text.includes("api key")
	) {
		return "provider_configuration";
	}
	if (
		text.includes("types") ||
		text.includes("compile") ||
		text.includes("syntax")
	) {
		return "compile_or_type_error";
	}
	if (text.includes("enoent") || text.includes("no such file")) {
		return "path_or_filesystem";
	}
	return "unknown";
}

async function writeReport(report: ValidationReport): Promise<string> {
	const outDir = path.join(cwd, "scripts", "test-results", "benchmarks");
	await mkdir(outDir, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const outPath = path.join(
		outDir,
		`${ts}-${report.repoLabel}-week15-validation.json`,
	);
	await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
	return outPath;
}

function sanitizeLabel(label: string): string {
	return label.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/-+/g, "-");
}

function shellQuote(input: string): string {
	return `'${input.replaceAll("'", "'\\''")}'`;
}

void main();
