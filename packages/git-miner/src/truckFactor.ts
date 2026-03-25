/**
 * @fileoverview Truck Factor computation and code churn metrics.
 *
 * Truck Factor (Avelino et al.):
 *   The minimum number of developers whose departure would leave >50% of
 *   files without a knowledgeable maintainer.
 *
 * Algorithm:
 *   1. For each file, the "owner" is the developer with the highest DOA score.
 *   2. Iteratively remove the developer who owns the most files.
 *   3. After each removal, check if >50% of files are orphaned.
 *   4. Truck Factor = number of removals when the threshold is first breached.
 *
 * Code Churn:
 *   Per-file: totalCommits, totalAdded, totalDeleted, churnRate (per month over 6 months).
 */

import type { ExpertiseRecord, FileChurn, TruckFactorResult, CommitInfo } from "./types.js";

// ─── Truck Factor ─────────────────────────────────────────────────────────────

/**
 * Computes the Truck Factor for the project using Avelino's greedy algorithm.
 *
 * @param expertise - All HAS_EXPERTISE records (output of computeExpertise)
 */
export function computeTruckFactor(expertise: ExpertiseRecord[]): TruckFactorResult {
	if (expertise.length === 0) {
		return { truckFactor: 0, criticalDevelopers: [], ownershipCounts: new Map() };
	}

	// Find the owner (highest DOA) for each file
	const fileOwner = new Map<string, { email: string; doaScore: number }>();
	for (const record of expertise) {
		const current = fileOwner.get(record.filePath);
		if (!current || record.doaScore > current.doaScore) {
			fileOwner.set(record.filePath, { email: record.developerEmail, doaScore: record.doaScore });
		}
	}

	const totalFiles = fileOwner.size;
	const orphanThreshold = Math.ceil(totalFiles * 0.5); // >50% orphaned

	// Build ownership counts (how many files each developer owns)
	const ownershipCounts = new Map<string, number>();
	for (const { email } of fileOwner.values()) {
		ownershipCounts.set(email, (ownershipCounts.get(email) ?? 0) + 1);
	}

	// Greedy removal loop
	// We work on a mutable copy so the original is untouched
	const mutableOwner = new Map(fileOwner);
	const mutableCounts = new Map(ownershipCounts);
	const criticalDevelopers: string[] = [];
	let orphanedFiles = 0;

	while (orphanedFiles <= orphanThreshold && mutableCounts.size > 0) {
		// Find developer with highest ownership count
		let topDev = "";
		let topCount = 0;
		for (const [email, count] of mutableCounts) {
			if (count > topCount) {
				topCount = count;
				topDev = email;
			}
		}
		if (!topDev) break;

		// Remove this developer
		criticalDevelopers.push(topDev);
		mutableCounts.delete(topDev);

		// Reassign owned files — find next best owner from expertise records
		for (const [filePath, owner] of mutableOwner) {
			if (owner.email !== topDev) continue;

			// Find next highest DOA for this file among remaining developers
			const candidates = expertise
				.filter((e) => e.filePath === filePath && mutableCounts.has(e.developerEmail))
				.sort((a, b) => b.doaScore - a.doaScore);

			if (candidates.length > 0 && candidates[0]) {
				const newOwner = candidates[0];
				mutableOwner.set(filePath, { email: newOwner.developerEmail, doaScore: newOwner.doaScore });
				mutableCounts.set(newOwner.developerEmail, (mutableCounts.get(newOwner.developerEmail) ?? 0) + 1);
			} else {
				// File is now orphaned
				mutableOwner.delete(filePath);
				orphanedFiles++;
			}
		}

		// Check if we've crossed the threshold
		if (orphanedFiles > orphanThreshold) break;
	}

	return {
		truckFactor: criticalDevelopers.length,
		criticalDevelopers,
		ownershipCounts,
	};
}

// ─── Code Churn ───────────────────────────────────────────────────────────────

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

/**
 * Computes per-file churn metrics from the commit log.
 *
 * @param commits     - All commits extracted from git log
 * @param fileNodeIds - Map of filePath → nodeId (from File nodes in Neo4j)
 */
export function computeChurn(
	commits: CommitInfo[],
	fileNodeIds: Map<string, string>,
): FileChurn[] {
	const now = Date.now();
	const sixMonthsAgo = now - SIX_MONTHS_MS;

	// Aggregate per-file stats
	const stats = new Map<
		string,
		{ totalCommits: number; totalAdded: number; totalDeleted: number; recentAdded: number; recentDeleted: number }
	>();

	for (const commit of commits) {
		const commitTime = new Date(commit.timestamp).getTime();
		const isRecent = commitTime >= sixMonthsAgo;

		for (const filePath of commit.filesChanged) {
			if (!stats.has(filePath)) {
				stats.set(filePath, { totalCommits: 0, totalAdded: 0, totalDeleted: 0, recentAdded: 0, recentDeleted: 0 });
			}
			const s = stats.get(filePath)!;
			s.totalCommits++;
			// Note: commit.linesAdded/Deleted are totals across all files.
			// We approximate per-file as the commit total divided by files changed.
			// This is an approximation — precise data requires diff-tree per commit.
			const fileCount = Math.max(commit.filesChanged.length, 1);
			const perFileAdded = Math.round(commit.linesAdded / fileCount);
			const perFileDeleted = Math.round(commit.linesDeleted / fileCount);
			s.totalAdded += perFileAdded;
			s.totalDeleted += perFileDeleted;
			if (isRecent) {
				s.recentAdded += perFileAdded;
				s.recentDeleted += perFileDeleted;
			}
		}
	}

	const result: FileChurn[] = [];
	for (const [filePath, s] of stats) {
		const nodeId = fileNodeIds.get(filePath);
		if (!nodeId) continue; // file not in graph (e.g., deleted or not parsed)

		// churnRate = (added + deleted) per month over last 6 months
		const churnRate = (s.recentAdded + s.recentDeleted) / 6;

		result.push({
			fileNodeId: nodeId,
			filePath,
			totalCommits: s.totalCommits,
			totalAdded: s.totalAdded,
			totalDeleted: s.totalDeleted,
			churnRate: Math.round(churnRate * 10) / 10, // 1 decimal place
		});
	}

	return result;
}
