/**
 * Phase 1 performance benchmark.
 *
 * Runs the parsing pipeline against the mini-app fixture 3 times and reports
 * median timing, peak heap memory, and node/edge counts. Results are suitable
 * for inclusion in the thesis as the Phase 1 baseline benchmark.
 *
 * Usage:
 *   bun run packages/parser/src/validation/benchmark.ts
 */
import { resolve } from "node:path";
import { parseProject } from "../index";
import type { ParseProjectStats } from "../index";

const FIXTURE = resolve(import.meta.dir, "../..", "fixtures", "mini-app");
const RUNS = 3;

interface RunResult {
	stats: ParseProjectStats;
	peakHeapMB: number;
	edgesByType: Record<string, number>;
	nodesByLabel: Record<string, number>;
}

async function runOnce(): Promise<RunResult> {
	const heapBefore = process.memoryUsage().heapUsed;

	const { files, stats } = await parseProject(FIXTURE);

	const heapAfter = process.memoryUsage().heapUsed;
	const peakHeapMB = Math.max(0, heapAfter - heapBefore) / 1024 / 1024;

	// Tally nodes by label
	const nodesByLabel: Record<string, number> = {};
	for (const f of files) {
		for (const e of f.entities) {
			const label = e.node.label;
			nodesByLabel[label] = (nodesByLabel[label] ?? 0) + 1;
		}
		// Count the file node itself
		nodesByLabel[f.file.label] = (nodesByLabel[f.file.label] ?? 0) + 1;
	}

	// Tally edges by type
	const edgesByType: Record<string, number> = {};
	for (const f of files) {
		for (const r of f.relationships) {
			const t = r.edge.type;
			edgesByType[t] = (edgesByType[t] ?? 0) + 1;
		}
	}

	return { stats, peakHeapMB, edgesByType, nodesByLabel };
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted[mid] ?? 0;
}

async function main() {
	console.log(`Benchmark: Phase 1 parsing pipeline`);
	console.log(`Fixture:   ${FIXTURE}`);
	console.log(`Runs:      ${RUNS}\n`);

	const results: RunResult[] = [];
	for (let i = 0; i < RUNS; i++) {
		process.stdout.write(`  Run ${i + 1}/${RUNS}...`);
		const r = await runOnce();
		results.push(r);
		console.log(` ${r.stats.totalDurationMs}ms`);
	}

	// Use the last run for counts (deterministic), median for timing
	const last = results[results.length - 1]!;
	const walkMs = median(results.map((r) => r.stats.walkDurationMs));
	const parseMs = median(results.map((r) => r.stats.parseDurationMs));
	const linkMs = median(results.map((r) => r.stats.linkDurationMs));
	const totalMs = median(results.map((r) => r.stats.totalDurationMs));
	const heapMB = median(results.map((r) => r.peakHeapMB));

	console.log("\n========== RESULTS (median of 3 runs) ==========");
	console.log(`\nFiles`);
	console.log(`  Found:   ${last.stats.filesFound}`);
	console.log(`  Parsed:  ${last.stats.filesParsed}`);
	console.log(`  Failed:  ${last.stats.filesFailed}`);

	console.log(`\nEntities`);
	console.log(`  Total:   ${last.stats.totalEntities}`);
	for (const [label, count] of Object.entries(last.nodesByLabel).sort()) {
		console.log(`  ${label.padEnd(12)} ${count}`);
	}

	console.log(`\nRelationships`);
	console.log(`  Total:   ${last.stats.totalRelationships}`);
	for (const [type, count] of Object.entries(last.edgesByType).sort()) {
		console.log(`  ${type.padEnd(16)} ${count}`);
	}

	console.log(`\nLinking`);
	console.log(`  Imports resolved:   ${last.stats.linking.importsResolved}`);
	console.log(`  Imports failed:     ${last.stats.linking.importsFailed}`);
	console.log(`  Calls resolved:     ${last.stats.linking.callsResolved}`);
	console.log(`  Calls failed:       ${last.stats.linking.callsFailed}`);
	console.log(`  Renders resolved:   ${last.stats.linking.rendersResolved}`);
	console.log(`  Renders failed:     ${last.stats.linking.rendersFailed}`);
	console.log(`  Re-exports followed:${last.stats.linking.reExportsFollowed}`);

	// Categorize unresolved calls so we can verify failures are expected.
	// Categories (checked in order, first match wins):
	//   builtin   — known JS/browser/Node globals
	//   setter    — React state setters (set* pattern)
	//   method    — callee is a dotted member expression (e.g. res.json)
	//   callback  — lowercase name that likely came from a parameter/closure
	//   unknown   — anything else (potential extraction gap worth investigating)
	const BUILTINS = new Set([
		"fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
		"console", "JSON", "Object", "Array", "Math", "Promise", "Error",
		"parseInt", "parseFloat", "isNaN", "encodeURIComponent", "decodeURIComponent",
	]);

	const categories: Record<string, string[]> = {
		builtin: [], setter: [], method: [], callback: [], unknown: [],
	};

	for (const c of last.stats.linking.unresolvedCalls) {
		const n = c.calleeName;
		if (BUILTINS.has(n.split(".")[0]!)) {
			categories.builtin!.push(n);
		} else if (/^set[A-Z]/.test(n)) {
			categories.setter!.push(n);
		} else if (n.includes(".")) {
			categories.method!.push(n);
		} else if (/^[a-z]/.test(n)) {
			categories.callback!.push(n);
		} else {
			categories.unknown!.push(n);
		}
	}

	console.log(`\nUnresolved calls breakdown (${last.stats.linking.callsFailed} total)`);
	for (const [cat, names] of Object.entries(categories)) {
		if (names.length === 0) continue;
		const deduped = [...new Set(names)].sort().join(", ");
		console.log(`  ${cat.padEnd(10)} (${names.length}) ${deduped}`);
	}

	console.log(`\nTiming (median)`);
	console.log(`  Walk:   ${walkMs}ms`);
	console.log(`  Parse:  ${parseMs}ms`);
	console.log(`  Link:   ${linkMs}ms`);
	console.log(`  Total:  ${totalMs}ms`);

	console.log(`\nMemory`);
	console.log(`  Heap delta: ${heapMB.toFixed(2)} MB`);

	console.log(`\nTarget: <10s for ≤1000 LOC fixture — ${totalMs < 10_000 ? "PASS ✓" : "FAIL ✗"}`);
}

main().catch(console.error);
