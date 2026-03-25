/**
 * @fileoverview Git-miner orchestrator.
 *
 * `mine()` is the main entry point. It:
 *   1. Extracts commit log (DeveloperInfo[], CommitInfo[])
 *   2. Runs `git blame` on all tracked files (FileBlame[])
 *   3. Maps blame to entity line ranges from Neo4j (EntityAttribution[])
 *   4. Computes DOA (ExpertiseRecord[])
 *   5. Computes Truck Factor + code churn
 *   6. Returns MineResult for graph-client's insertMineResults()
 *
 * The driver is passed in for reading entity line ranges from Neo4j.
 * All Neo4j *writes* are handled by the caller (CLI/backend) via insertMineResults().
 */

import type { Driver } from "neo4j-driver";
import path from "node:path";
import { createGitService } from "./gitService.js";
import { buildModifiedEdges, buildFileModifiedEdge } from "./blameMapper.js";
import { computeExpertise } from "./doaCalculator.js";
import { computeTruckFactor, computeChurn } from "./truckFactor.js";
import { fetchEntityLineRanges, fetchFileNodeIds } from "@codex/graph-client";
import type {
	MineResult,
	MineOptions,
	DeveloperInfo,
	CommitInfo,
	FileHistory,
	FileBlame,
	CommittedRecord,
	ModifiedRecord,
	MineStats,
} from "./types.js";

// Concurrency pool size for parallel blame operations
const BLAME_CONCURRENCY = 8;

// ─── Public API ───────────────────────────────────────────────────────────────

export type { MineResult, MineOptions, MineProgress, OnMineProgress, MineStats, EntityLineRange } from "./types.js";

/**
 * Runs the full git-mining pipeline for a repository.
 *
 * @param repoPath - Absolute or relative path to the git repository root
 * @param driver   - Connected Neo4j driver (for reading entity line ranges)
 * @param options  - Progress callbacks and optional filters
 *
 * @throws If `repoPath` is not a git repository or Neo4j is unreachable.
 *         Partial failures (blame, entity mapping) are recorded in stats.
 */
export async function mine(
	repoPath: string,
	driver: Driver,
	options: MineOptions = {},
): Promise<MineResult> {
	const t0 = Date.now();
	const { onProgress } = options;
	const absPath = path.resolve(repoPath);

	const stats: MineStats = {
		developers: 0,
		commits: 0,
		filesBlamed: 0,
		blameFailures: 0,
		blameFailureFiles: [],
		entitiesMapped: 0,
		filesWithNoEntities: 0,
		noEntityFiles: [],
		expertiseEdges: 0,
		modifiedEdges: 0,
		modifiedEdgeFailures: 0,
		durationMs: 0,
	};

	// ── 1. Create git service ─────────────────────────────────────────────────
	const git = await createGitService(absPath);

	// ── 2. Extract commit log ─────────────────────────────────────────────────
	onProgress?.({ phase: "log", current: 0, total: 1, detail: "Reading git log…" });

	const allCommits: CommitInfo[] = await git.getLog({
		since: options.since,
		maxCount: options.maxCommits,
	});

	// Deduplicate developers by email
	const devMap = new Map<string, DeveloperInfo>();
	for (const commit of allCommits) {
		const email = commit.authorEmail;
		if (!email) continue;
		const existing = devMap.get(email);
		if (existing) {
			existing.totalCommits++;
		} else {
			devMap.set(email, {
				email,
				name: email.split("@")[0] ?? email,
				totalCommits: 1,
			});
		}
	}
	const developers = Array.from(devMap.values());
	stats.developers = developers.length;
	stats.commits = allCommits.length;

	onProgress?.({
		phase: "log",
		current: 1,
		total: 1,
		detail: `${allCommits.length} commits · ${developers.length} developers`,
	});

	// ── 3. Build COMMITTED edges ─────────────────────────────────────────────
	const committedEdges: CommittedRecord[] = allCommits.map((c) => ({
		developerEmail: c.authorEmail,
		commitSha: c.sha,
	}));

	// ── 4. Blame tracked files ────────────────────────────────────────────────
	const trackedFiles = await git.getTrackedFiles();
	const totalFiles = trackedFiles.length;

	onProgress?.({ phase: "blame", current: 0, total: totalFiles, detail: "Starting blame…" });

	// Fetch file nodeId map from Neo4j
	const fileNodeIds = await fetchFileNodeIds(driver);

	const blameResults: FileBlame[] = [];
	const blameFailuresList: string[] = [];

	let completed = 0;
	await runWithConcurrency(trackedFiles, BLAME_CONCURRENCY, async (absFilePath) => {
		const relPath = path.relative(absPath, absFilePath).replace(/\\/g, "/");
		const result = await git.blame(absFilePath);
		if (result.lines.length === 0) {
			blameFailuresList.push(relPath);
		} else {
			// Normalize the filePath stored in FileBlame to repo-relative
			blameResults.push({ filePath: relPath, lines: result.lines });
		}
		completed++;
		onProgress?.({
			phase: "blame",
			current: completed,
			total: totalFiles,
			detail: `${completed}/${totalFiles} files`,
		});
	});

	stats.filesBlamed = blameResults.length;
	stats.blameFailures = blameFailuresList.length;
	stats.blameFailureFiles = blameFailuresList;

	// ── 5. Map blame → entities + MODIFIED edges ─────────────────────────────
	onProgress?.({ phase: "map", current: 0, total: blameResults.length, detail: "Mapping blame to entities…" });

	const modifiedEdges: ModifiedRecord[] = [];
	const fileHistories = new Map<string, FileHistory>();

	// File-level MODIFIED edges from commit diff stats
	for (const commit of allCommits) {
		for (const filePath of commit.filesChanged) {
			const normPath = filePath.replace(/\\/g, "/");
			const nodeId = fileNodeIds.get(normPath);
			if (!nodeId) {
				stats.modifiedEdgeFailures++;
				continue;
			}
			modifiedEdges.push(buildFileModifiedEdge(nodeId, commit.sha, commit.linesAdded, commit.linesDeleted));
		}
	}

	// Entity-level MODIFIED edges + FileHistory for DOA
	let mapIdx = 0;
	for (const blame of blameResults) {
		const normPath = blame.filePath;
		const entityRanges = await fetchEntityLineRanges(driver, normPath);

		if (entityRanges.length === 0) {
			stats.filesWithNoEntities++;
			stats.noEntityFiles.push(normPath);
		} else {
			const entityModified = buildModifiedEdges(blame, entityRanges);
			modifiedEdges.push(...entityModified);
			stats.entitiesMapped += entityRanges.length;
		}

		const fileNodeId = fileNodeIds.get(normPath);
		if (fileNodeId) {
			const fileCommits = allCommits
				.filter((c) => c.filesChanged.some((f) => f.replace(/\\/g, "/") === normPath))
				.map((c) => ({ sha: c.sha, authorEmail: c.authorEmail, timestamp: c.timestamp }))
				.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

			fileHistories.set(normPath, {
				filePath: normPath,
				fileNodeId,
				commits: fileCommits,
				currentBlame: blame,
			});
		}

		mapIdx++;
		if (mapIdx % 50 === 0) {
			onProgress?.({
				phase: "map",
				current: mapIdx,
				total: blameResults.length,
				detail: `${mapIdx}/${blameResults.length} files mapped`,
			});
		}
	}

	stats.modifiedEdges = modifiedEdges.length;

	// ── 6. Compute DOA + Truck Factor + Churn ────────────────────────────────
	onProgress?.({
		phase: "doa",
		current: 0,
		total: 1,
		detail: `Computing DOA for ${developers.length} developers × ${fileHistories.size} files`,
	});

	const fileExpertise = computeExpertise(fileHistories);
	stats.expertiseEdges = fileExpertise.length;

	const truckFactor = computeTruckFactor(fileExpertise);
	const churn = computeChurn(allCommits, fileNodeIds);

	onProgress?.({
		phase: "doa",
		current: 1,
		total: 1,
		detail: `Truck Factor: ${truckFactor.truckFactor} · ${fileExpertise.length} expertise edges`,
	});

	stats.durationMs = Date.now() - t0;

	return {
		developers,
		commits: allCommits,
		fileExpertise,
		modifiedEdges,
		committedEdges,
		churn,
		truckFactor,
		stats,
	};
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

/** Runs tasks with at most `concurrency` in-flight at once. */
async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	const queue = [...items];
	const workers = Array.from(
		{ length: Math.min(concurrency, Math.max(items.length, 1)) },
		async () => {
			while (queue.length > 0) {
				const item = queue.shift();
				if (item !== undefined) await fn(item);
			}
		},
	);
	await Promise.all(workers);
}
