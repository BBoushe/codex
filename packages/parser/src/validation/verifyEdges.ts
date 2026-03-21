/**
 * Phase 1 edge verification sampler.
 *
 * Runs the parsing pipeline against the mini-app fixture, then samples ~3
 * edges per edge type (targeting 20+ total) and prints a human-readable
 * report for manual spot-checking against the source code.
 *
 * For each sampled edge the report shows:
 *   source entity (name + file)  --[EDGE_TYPE]-->  target entity (name + file)
 *
 * A human reviewer should open the referenced source files and confirm each
 * relationship is correct. Document the results in docs/verification/.
 *
 * Usage:
 *   bun run packages/parser/src/validation/verifyEdges.ts
 */
import { resolve } from "node:path";
import { parseProject } from "../index";
import type { FileParseResult } from "@codex/shared";

const FIXTURE = resolve(import.meta.dir, "../..", "fixtures", "mini-app");
const SAMPLE_PER_TYPE = 3;

interface EdgeSample {
	edgeType: string;
	sourceName: string;
	sourceFile: string;
	targetName: string;
	targetFile: string;
	extraProps: Record<string, unknown>;
}

/** Resolves a nodeId to { name, file } across all parsed files. */
function resolveNode(
	files: FileParseResult[],
	nodeId: string,
): { name: string; file: string } {
	for (const f of files) {
		if (f.file.nodeId === nodeId)
			return { name: f.file.name, file: f.file.filePath };
		for (const e of f.entities) {
			if (e.node.nodeId === nodeId)
				return { name: e.node.name, file: f.file.filePath };
		}
	}
	return { name: `<${nodeId.slice(0, 8)}>`, file: "?" };
}

/** Deterministic pseudo-random sample (no crypto needed). */
function sample<T>(arr: T[], n: number): T[] {
	if (arr.length <= n) return arr;
	const step = Math.max(1, Math.floor(arr.length / n));
	return Array.from({ length: n }, (_, i) => arr[(i * step) % arr.length]!);
}

async function main() {
	console.log(`Edge Verification Report — Phase 1`);
	console.log(`Fixture: ${FIXTURE}\n`);

	const { files, stats } = await parseProject(FIXTURE);

	// Bucket all relationships by edge type
	const byType = new Map<string, EdgeSample[]>();
	for (const f of files) {
		for (const rel of f.relationships) {
			const edgeType = rel.edge.type;
			const { type: _t, ...extraProps } = rel.edge as { type: string } & Record<string, unknown>;

			const sourceName = resolveNode(files, rel.sourceId);
			const targetName = resolveNode(files, rel.targetId);

			const entry: EdgeSample = {
				edgeType,
				sourceName: sourceName.name,
				sourceFile: sourceName.file,
				targetName: targetName.name,
				targetFile: targetName.file,
				extraProps,
			};

			const bucket = byType.get(edgeType) ?? [];
			bucket.push(entry);
			byType.set(edgeType, bucket);
		}
	}

	const totalEdges = [...byType.values()].reduce((sum, b) => sum + b.length, 0);
	console.log(`Total edges: ${totalEdges} across ${byType.size} types`);
	console.log(`Sampling up to ${SAMPLE_PER_TYPE} per type\n`);

	let sampleCount = 0;
	for (const [edgeType, edges] of [...byType.entries()].sort()) {
		const sampled = sample(edges, SAMPLE_PER_TYPE);
		console.log(`──── ${edgeType} (${edges.length} total, ${sampled.length} sampled) ────`);

		for (const e of sampled) {
			const src = `${e.sourceName} (${e.sourceFile})`;
			const tgt = `${e.targetName} (${e.targetFile})`;
			const extra = Object.keys(e.extraProps).length
				? `  props: ${JSON.stringify(e.extraProps)}`
				: "";
			console.log(`  ${src}`);
			console.log(`    --[${edgeType}]-->`);
			console.log(`  ${tgt}${extra}`);
			console.log();
			sampleCount++;
		}
	}

	console.log(`========== SUMMARY ==========`);
	console.log(`Sampled ${sampleCount} edges for manual verification.`);
	console.log(`\nLinking stats:`);
	console.log(`  Imports resolved:    ${stats.linking.importsResolved}`);
	console.log(`  Imports failed:      ${stats.linking.importsFailed}`);
	console.log(`  Calls resolved:      ${stats.linking.callsResolved}`);
	console.log(`  Calls failed:        ${stats.linking.callsFailed}`);
	console.log(`  Renders resolved:    ${stats.linking.rendersResolved}`);
	console.log(`  Renders failed:      ${stats.linking.rendersFailed}`);
	console.log(`  Re-exports followed: ${stats.linking.reExportsFollowed}`);
	console.log(
		`\nManually review the edges above against the source files in:\n  ${FIXTURE}/src`,
	);
}

main().catch(console.error);
