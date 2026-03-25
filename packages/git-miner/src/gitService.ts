/**
 * @fileoverview simple-git wrapper for the CODEX git-miner pipeline.
 *
 * Provides typed methods for the three core git operations needed:
 *   - getLog()          — full commit history with per-file diff stats
 *   - blame()           — per-line author attribution (porcelain format)
 *   - getTrackedFiles() — list of files currently tracked by git
 *
 * All methods are designed to be called from the orchestrator in index.ts.
 * Errors from git operations are caught and returned as empty results rather
 * than thrown — callers receive failure site data in MineStats.
 */

import simpleGit, { type SimpleGit } from "simple-git";
import fs from "node:fs";
import path from "node:path";
import type { CommitInfo, FileBlame, BlameLineInfo, DiffStatEntry } from "./types.js";

// Supported file extensions for blame analysis (mirrors parser)
const BLAME_EXTENSIONS = new Set([
	".ts", ".tsx", ".js", ".jsx",
	".py",
	".java",
]);

// ─── Public interface ─────────────────────────────────────────────────────────

export interface GitService {
	getLog(options?: GetLogOptions): Promise<CommitInfo[]>;
	blame(filePath: string): Promise<FileBlame>;
	getTrackedFiles(): Promise<string[]>;
	repoPath: string;
}

export interface GetLogOptions {
	/** Only include commits after this ISO 8601 date. */
	since?: string;
	/** Cap the number of commits returned. */
	maxCount?: number;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a GitService for the given repository path.
 * Validates that the path is a git repository before returning.
 *
 * @throws If `repoPath` is not a git repository.
 */
export async function createGitService(repoPath: string): Promise<GitService> {
	const absPath = path.resolve(repoPath);

	if (!fs.existsSync(absPath)) {
		throw new Error(`Repository path does not exist: ${absPath}`);
	}

	const git: SimpleGit = simpleGit(absPath);

	const isRepo = await git.checkIsRepo();
	if (!isRepo) {
		throw new Error(`Not a git repository: ${absPath}`);
	}

	return {
		repoPath: absPath,
		getLog: (opts) => getLog(git, absPath, opts),
		blame: (filePath) => blame(git, absPath, filePath),
		getTrackedFiles: () => getTrackedFiles(git, absPath),
	};
}

// ─── Implementation ───────────────────────────────────────────────────────────

async function getLog(
	git: SimpleGit,
	repoPath: string,
	options: GetLogOptions = {},
): Promise<CommitInfo[]> {
	const args: string[] = [
		"log",
		"--format=%H|%ae|%ai|%s",
		"--numstat",
	];

	if (options.since) {
		args.push(`--after=${options.since}`);
	}
	if (options.maxCount) {
		args.push(`--max-count=${options.maxCount}`);
	}

	const raw = await git.raw(args);
	return parseGitLog(raw, repoPath);
}

/**
 * Parse the output of `git log --format=%H|%ae|%ai|%s --numstat`.
 *
 * Each commit block looks like:
 *   <sha>|<author_email>|<ISO_date>|<subject>
 *   <blank line>
 *   <added>\t<deleted>\t<file>
 *   <added>\t<deleted>\t<file>
 *   <blank line>
 *   <next commit...>
 */
function parseGitLog(raw: string, _repoPath: string): CommitInfo[] {
	const commits: CommitInfo[] = [];
	const lines = raw.split("\n");

	let i = 0;
	while (i < lines.length) {
		const headerLine = lines[i]?.trim();
		if (!headerLine) { i++; continue; }

		// Check if this is a commit header (contains pipe-separated fields)
		const parts = headerLine.split("|");
		if (parts.length < 4) { i++; continue; }

		const [sha, authorEmail, timestamp] = parts;
		const message = parts.slice(3).join("|").trim();

		if (!sha || sha.length !== 40) { i++; continue; }

		i++; // skip blank line after header
		if (i < lines.length && lines[i]?.trim() === "") i++;

		// Parse numstat lines
		const filesChanged: string[] = [];
		let linesAdded = 0;
		let linesDeleted = 0;

		while (i < lines.length) {
			const statLine = lines[i] ?? "";
			if (statLine.trim() === "") { i++; break; }

			// If this looks like a commit header, stop without consuming it
			if (/^[0-9a-f]{40}\|/.test(statLine)) break;

			// numstat format: <added>\t<deleted>\t<file>
			// Binary files show "-\t-\t<file>"
			const statParts = statLine.split("\t");
			if (statParts.length >= 3) {
				const added = parseInt(statParts[0] ?? "0", 10);
				const deleted = parseInt(statParts[1] ?? "0", 10);
				const file = statParts[2]?.trim() ?? "";

				if (!isNaN(added)) linesAdded += added;
				if (!isNaN(deleted)) linesDeleted += deleted;
				if (file) filesChanged.push(file);
			}
			i++;
		}

		commits.push({
			sha: sha.trim(),
			message: message ?? "",
			timestamp: (timestamp ?? "").trim(),
			authorEmail: (authorEmail ?? "").trim().replace(/^<|>$/g, ""),
			linesAdded,
			linesDeleted,
			filesChanged,
		});
	}

	return commits;
}

/**
 * Run `git blame --porcelain` on a single file and parse the output.
 *
 * Porcelain format per-line group:
 *   <sha> <orig_line> <final_line> [<num_lines>]
 *   author <name>
 *   author-mail <email>
 *   author-time <epoch>
 *   ...
 *   \t<source_line>
 *
 * Returns empty FileBlame on any error (binary, deleted, untracked files).
 */
async function blame(
	git: SimpleGit,
	repoPath: string,
	filePath: string,
): Promise<FileBlame> {
	// Make path relative to repo for git blame
	const absFile = path.isAbsolute(filePath)
		? filePath
		: path.join(repoPath, filePath);
	const relFile = path.relative(repoPath, absFile);

	try {
		const raw = await git.raw(["blame", "--porcelain", relFile]);
		return { filePath: relFile, lines: parsePorcelainBlame(raw) };
	} catch {
		// Binary files, new untracked files, etc.
		return { filePath: relFile, lines: [] };
	}
}

/**
 * Parse `git blame --porcelain` output into BlameLineInfo[].
 *
 * Each stanza starts with a line: `<40-char-sha> <orig> <final> [count]`
 * followed by header lines until a tab-prefixed source line.
 */
function parsePorcelainBlame(raw: string): BlameLineInfo[] {
	const lines = raw.split("\n");
	const result: BlameLineInfo[] = [];

	// Cache sha → { email, name, timestamp } to avoid re-parsing repeated shas
	const shaCache = new Map<string, { email: string; name: string; timestamp: string }>();

	let currentSha = "";
	let currentLine = 0;
	let currentEmail = "";
	let currentName = "";
	let currentTimestamp = "";

	for (const line of lines) {
		if (!line) continue;

		// Commit header: 40-hex-chars followed by line numbers
		const headerMatch = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
		if (headerMatch) {
			currentSha = headerMatch[1] ?? "";
			currentLine = parseInt(headerMatch[2] ?? "0", 10);

			const cached = shaCache.get(currentSha);
			if (cached) {
				currentEmail = cached.email;
				currentName = cached.name;
				currentTimestamp = cached.timestamp;
			} else {
				currentEmail = "";
				currentName = "";
				currentTimestamp = "";
			}
			continue;
		}

		if (line.startsWith("author-mail ")) {
			currentEmail = line.slice("author-mail ".length).replace(/[<>]/g, "").trim();
			continue;
		}

		if (line.startsWith("author ")) {
			currentName = line.slice("author ".length).trim();
			continue;
		}

		if (line.startsWith("author-time ")) {
			currentTimestamp = line.slice("author-time ".length).trim();
			continue;
		}

		// Tab-prefixed line = source code line (end of stanza)
		if (line.startsWith("\t")) {
			if (currentSha && currentLine > 0) {
				shaCache.set(currentSha, {
					email: currentEmail,
					name: currentName,
					timestamp: currentTimestamp,
				});

				result.push({
					line: currentLine,
					authorEmail: currentEmail,
					authorName: currentName,
					commitSha: currentSha,
					timestamp: currentTimestamp,
				});
			}
			currentLine++;
		}
	}

	return result;
}

async function getTrackedFiles(
	git: SimpleGit,
	repoPath: string,
): Promise<string[]> {
	const raw = await git.raw(["ls-files"]);
	return raw
		.split("\n")
		.map((f) => f.trim())
		.filter((f) => {
			if (!f) return false;
			const ext = path.extname(f).toLowerCase();
			return BLAME_EXTENSIONS.has(ext);
		})
		.map((f) => path.join(repoPath, f));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Runs `git diff-tree --numstat -r <sha>` to get per-file add/delete counts.
 * Used to build file-level MODIFIED edges.
 */
export async function getDiffStat(
	git: SimpleGit,
	sha: string,
): Promise<DiffStatEntry[]> {
	try {
		const raw = await git.raw(["diff-tree", "--numstat", "-r", sha]);
		return raw
			.split("\n")
			.filter((l) => l.trim())
			.map((line) => {
				const parts = line.split("\t");
				const added = parseInt(parts[0] ?? "0", 10);
				const deleted = parseInt(parts[1] ?? "0", 10);
				const filePath = parts[2]?.trim() ?? "";
				return { filePath, linesAdded: isNaN(added) ? 0 : added, linesDeleted: isNaN(deleted) ? 0 : deleted };
			})
			.filter((e) => e.filePath.length > 0);
	} catch {
		return [];
	}
}
