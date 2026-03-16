// packages/parser/src/test-pipeline.ts
import { resolve } from "node:path";
import { parseProject } from "../index";

async function main() {
	const rootDir = resolve(import.meta.dir, "../..", "fixtures", "mini-app");
	console.log(`Parsing: ${rootDir}\n`);

	const { files, stats } = await parseProject(rootDir);

	console.log("\n========== STATS ==========");
	console.log(
		`Files:     ${stats.filesParsed}/${stats.filesFound} parsed (${stats.filesFailed} failed)`,
	);
	console.log(`Entities:  ${stats.totalEntities}`);
	console.log(`Relations: ${stats.totalRelationships}`);
	console.log(
		`Timing:    walk=${stats.walkDurationMs}ms parse=${stats.parseDurationMs}ms link=${stats.linkDurationMs}ms total=${stats.totalDurationMs}ms`,
	);

	console.log("\n========== PER FILE ==========");
	for (const f of files) {
		console.log(`\n--- ${f.file.filePath} ---`);
		console.log(`  Entities:`);
		for (const e of f.entities) {
			console.log(`    [${e.node.label}] ${e.node.name}`);
			if ("propType" in e.node)
				console.log(
					`    	required: ${e.node.isRequired}, default: ${e.node.defaultValue}`,
				);
		}
		console.log(`  Relationships:`);
		for (const r of f.relationships) {
			const srcName = findName(files, r.sourceId);
			const tgtName = findName(files, r.targetId);
			console.log(`    ${srcName} --[${r.edge.type}]--> ${tgtName}`);
		}
	}
}

/** Resolves a nodeId to a human-readable name for display. */
function findName(
	files: Awaited<ReturnType<typeof parseProject>>["files"],
	nodeId: string,
): string {
	for (const f of files) {
		if (f.file.nodeId === nodeId) return f.file.name;
		for (const e of f.entities) {
			if (e.node.nodeId === nodeId) return e.node.name;
		}
	}
	return nodeId.slice(0, 8);
}

main().catch(console.error);
