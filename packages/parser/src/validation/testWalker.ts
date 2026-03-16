import { walkDirectory } from "../fileWalker";
import { resolve } from "node:path";

async function main() {
	// Point at the codex repo root
	const root = resolve(import.meta.dir, "..", "..", "..");
	console.log(`Walking: ${root}\n`);

	const result = await walkDirectory(root);

	console.log(`Directories visited: ${result.directoriesVisited}`);
	console.log(`Files found: ${result.files.length}`);
	console.log(`Files skipped: ${result.filesSkipped}\n`);
	console.log(`Lines of code: ${result.linesOfCode}`);
	console.log(`Total characters: ${result.totalCharacters}\n`);
	console.log(`Token estimation: ${Math.floor(result.totalCharacters / 4)}\n`);
	console.log("-------------------------");
	console.log(`Duration: ${result.durationMs}ms\n\n`);

	console.log("Files:");
	for (const f of result.files) {
		console.log(`  ${f.relativePath} (${f.extension})`);
	}
}

main().catch(console.error);
