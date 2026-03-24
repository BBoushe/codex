import { readdir, readFile } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import fs from "node:fs";
import readLine from "node:readline";
import ignore, { type Ignore } from "ignore";
import { isSupportedExtension } from "./languageService";

/** A discovered source file ready for parsing */
export interface SourceFile {
	/** Absolute path on disk. */
	absolutePath: string;
	/** Path relative to the repository root (used as the canonical identifier). */
	relativePath: string;
	/** File extension including the dot (e.g. ".tsx"). */
	extension: string;
}

export interface WalkOptions {
	/** Additional dirs to skip, beyond built in list
	 * @remark Matched agains the dirs base name, not the full path.
	 */
	extraIgnoreDirs?: string[];
}

/** Summary statistics returned with file list */
export interface WalkResult {
	files: SourceFile[];
	/** Total number of visited directories */
	directoriesVisited: number;
	/** Total number of files skipped (wrong extensions or ignored) */
	filesSkipped: number;
	/** Total number of lines across all discovered files (for reporting) */
	linesOfCode: number;
	/** Total number of characters across all discovered files (for reporting) */
	totalCharacters: number;
	/** Duration of the walk in milliseconds */
	durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ALWAYS_IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"__pycache__",
	".next",
	".nuxt",
	".svelte-kit",
	"dist",
	"build",
	"out",
	"coverage",
	".cache",
	".turbo",
	".parcel-cache",
	".venv",
	"venv",
	"env",
	".env",
	".idea",
	".DS_Store",
	".vscode",
	"vendor",
	"target", // Java/Rust build output
	".gradle",
	// Common artifact files
	"*.png",
	"*.jpg",
	"*.jpeg",
	"*.gif",
	"*.bmp",
	"*.svg",
	"*.ico",
	"*.zip",
	"*.tar",
	"*.gz",
	"*.7z",
	"*.rar",
	"*.pdf",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads a `.gitignore` file from the given directory (if it exists) and
 * adds its rules to the provided `Ignore` instance.
 *
 * Silently does nothing if the file doesn't exist or can't be read.
 */
async function loadGitignore(dir: string, ig: Ignore): Promise<void> {
	const gitignorePath = join(dir, ".gitignore");
	try {
		const content = await readFile(gitignorePath, "utf-8");
		ig.add(content);
	} catch {
		// .gitignore doesn't exist in this directory — that's fine
	}
}

async function getFileStats(
	filePath: string,
): Promise<{ lines: number; characters: number }> {
	let lineCount = 0;
	let charCount = 0;

	const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
	const rl = readLine.createInterface({
		input: fileStream,
		crlfDelay: Infinity,
	});

	for await (const line of rl) {
		lineCount++;
		charCount += line.length + 1; // +1 for the newline character
	}

	return { lines: lineCount, characters: charCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function walkDirectory(
	rootDir: string,
	options?: WalkOptions,
): Promise<WalkResult> {
	const start = Date.now();

	const extraIgnore = new Set(options?.extraIgnoreDirs ?? []);
	const shouldSkipDir = (name: string) =>
		ALWAYS_IGNORED_DIRS.has(name) || extraIgnore.has(name);

	const rootIgnore = ignore();
	await loadGitignore(rootDir, rootIgnore);

	const files: SourceFile[] = [];
	let directoriesVisited = 0;
	let filesSkipped = 0;
	const fileStats = { lines: 0, characters: 0 };

	/** Recursive inner walk.
	 * @param dir Absolute path of the directory to walk
	 * @param ignoreStack Accumulated ignore rules up to and including this directory
	 */
	async function walk(dir: string, ignoreStack: Ignore): Promise<void> {
		directoriesVisited++;

		const entries = await readdir(dir, { withFileTypes: true });

		for (const entry of entries) {
			const absPath = join(dir, entry.name);
			const relPath = relative(rootDir, absPath);

			if (entry.isDirectory()) {
				// Fast-path: skip well known non-source directories without even loading their .gitignore
				if (shouldSkipDir(entry.name)) continue;

				// Check .gitignore rules
				if (ignoreStack.ignores(relPath + "/")) {
					filesSkipped++;
					continue;
				}

				// Create a child ignore instance that inherits parent rules
				const childIgnore = ignore().add(ignoreStack);
				await loadGitignore(absPath, childIgnore);

				await walk(absPath, childIgnore);
			} else if (entry.isFile()) {
				// Check .gitignore rules
				if (ignoreStack.ignores(relPath)) {
					filesSkipped++;
					continue;
				}

				const ext = extname(entry.name);
				if (!isSupportedExtension(ext)) {
					filesSkipped++;
					continue;
				}

				const stats = await getFileStats(absPath);
				fileStats.lines += stats.lines;
				fileStats.characters += stats.characters;

				files.push({
					absolutePath: absPath,
					relativePath: relPath,
					extension: ext,
				});
			}
			// Symlinks and other entry types are silently skipped
		}
	}

	await walk(rootDir, rootIgnore);

	return {
		files,
		directoriesVisited,
		filesSkipped,
		linesOfCode: fileStats.lines,
		totalCharacters: fileStats.characters,
		durationMs: Date.now() - start,
	};
}
