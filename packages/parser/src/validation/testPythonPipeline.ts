/**
 * Quick test: run the parser pipeline against the mini-python fixture.
 *
 * Usage: bun run packages/parser/src/validation/testPythonPipeline.ts
 */

import { parseProject } from "..";
import { resolve } from "node:path";

async function main() {
	const fixtureDir = resolve(import.meta.dir, "../../fixtures/mini-python");
	console.log(`\nParsing: ${fixtureDir}\n`);

	const result = await parseProject(fixtureDir);

	console.log("\n=== Summary ===");
	console.log(`Files parsed: ${result.stats.filesParsed}`);
	console.log(`Entities: ${result.stats.totalEntities}`);
	console.log(`Relationships: ${result.stats.totalRelationships}`);

	const labelCounts = new Map<string, number>();
	const edgeCounts = new Map<string, number>();

	for (const file of result.files) {
		for (const entity of file.entities) {
			const label = (entity.node as { label?: string }).label ?? "unknown";
			labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
		}
		for (const rel of file.relationships) {
			edgeCounts.set(rel.edge.type, (edgeCounts.get(rel.edge.type) ?? 0) + 1);
		}
	}

	console.log("\n=== Entity Breakdown ===");
	for (const [label, count] of [...labelCounts.entries()].sort()) {
		console.log(`  ${label}: ${count}`);
	}

	console.log("\n=== Edge Breakdown ===");
	for (const [type, count] of [...edgeCounts.entries()].sort()) {
		console.log(`  ${type}: ${count}`);
	}

	console.log("\n=== Linking ===");
	const ls = result.stats.linking;
	console.log(
		`  Imports: ${ls.importsResolved} resolved, ${ls.importsFailed} failed`,
	);
	console.log(
		`  Calls:   ${ls.callsResolved} resolved, ${ls.callsFailed} failed`,
	);

	console.log("\n=== All Entities ===");
	for (const file of result.files) {
		for (const entity of file.entities) {
			const n = entity.node as { label?: string; name?: string; qualifiedName?: string };
			console.log(`  [${n.label}] ${n.qualifiedName ?? n.name}`);
		}
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
