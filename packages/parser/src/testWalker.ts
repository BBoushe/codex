import { walkDirectory } from "./fileWalker";
import { resolve } from "node:path";

async function main() {
	// Point at the codex repo root
	const root = resolve(import.meta.dir, "..", "..", "..");
	console.log(`Walking: ${root}\n`);

	const result = await walkDirectory(root);

	console.log(`Directories visited: ${result.directoriesVisited}`);
	console.log(`Files found: ${result.files.length}`);
	console.log(`Files skipped: ${result.filesSkipped}`);
	console.log(`Duration: ${result.durationMs}ms\n`);

	console.log("Files:");
	for (const f of result.files) {
		console.log(`  ${f.relativePath} (${f.extension})`);
	}
}

main().catch(console.error);
