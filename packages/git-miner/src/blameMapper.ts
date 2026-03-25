/**
 * @fileoverview Maps per-line blame data to entity-level attribution.
 *
 * Bridges the gap between git's line-level granularity (blame) and the
 * CPG's entity-level granularity (Function, Class, Component nodes with
 * startLine/endLine). For each entity in a file, computes how many of
 * its lines are attributed to each developer in the current blame state.
 *
 * Output feeds into:
 *   - MODIFIED edges (grouping blame lines by commitSha within entity ranges)
 *   - DOA "acceptances" metric (surviving lines per developer)
 */

import type {
	FileBlame,
	BlameLineInfo,
	EntityLineRange,
	EntityAttribution,
	ModifiedRecord,
} from "./types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * For each entity in the file, count how many blame lines fall within
 * [startLine, endLine] and aggregate by developer email.
 *
 * @param blame   - Current blame output for the file
 * @param entities - Entity line ranges from Neo4j for this file
 * @returns One EntityAttribution per (developer, entity) pair with ≥1 line
 */
export function mapBlameToEntities(
	blame: FileBlame,
	entities: EntityLineRange[],
): EntityAttribution[] {
	if (blame.lines.length === 0 || entities.length === 0) return [];

	// Build a line → BlameLineInfo lookup for O(1) access
	const lineMap = new Map<number, BlameLineInfo>();
	for (const blameLine of blame.lines) {
		lineMap.set(blameLine.line, blameLine);
	}

	const result: EntityAttribution[] = [];

	for (const entity of entities) {
		const totalLines = entity.endLine - entity.startLine + 1;
		if (totalLines <= 0) continue;

		// Count lines per developer within this entity's range
		const devCounts = new Map<string, number>();
		for (let line = entity.startLine; line <= entity.endLine; line++) {
			const blameLine = lineMap.get(line);
			if (!blameLine) continue;
			const email = blameLine.authorEmail;
			devCounts.set(email, (devCounts.get(email) ?? 0) + 1);
		}

		for (const [developerEmail, lineCount] of devCounts) {
			result.push({
				entityNodeId: entity.nodeId,
				developerEmail,
				lineCount,
				proportion: lineCount / totalLines,
			});
		}
	}

	return result;
}

/**
 * Builds MODIFIED edge records by grouping blame lines within entity ranges
 * by their commit SHA. Each (commit, entity) pair with ≥1 line produces one
 * ModifiedRecord.
 *
 * This is used to create Commit → Entity MODIFIED edges in Neo4j.
 *
 * @param blame    - Current blame output for the file
 * @param entities - Entity line ranges from Neo4j for this file
 * @param commitShaToFileLinesAdded - Map of sha → {added, deleted} per file
 *                                    from git diff-tree (used for line counts)
 */
export function buildModifiedEdges(
	blame: FileBlame,
	entities: EntityLineRange[],
): ModifiedRecord[] {
	if (blame.lines.length === 0 || entities.length === 0) return [];

	// Map: entityNodeId → commitSha → lineCount
	const entityCommitLines = new Map<string, Map<string, number>>();

	for (const entity of entities) {
		const commitCounts = new Map<string, number>();

		for (let line = entity.startLine; line <= entity.endLine; line++) {
			const blameLine = blame.lines.find((b) => b.line === line);
			if (!blameLine) continue;
			const sha = blameLine.commitSha;
			commitCounts.set(sha, (commitCounts.get(sha) ?? 0) + 1);
		}

		entityCommitLines.set(entity.nodeId, commitCounts);
	}

	// Emit one ModifiedRecord per (entity, commit) pair
	const records: ModifiedRecord[] = [];
	for (const [entityNodeId, commitCounts] of entityCommitLines) {
		for (const [commitSha, lineCount] of commitCounts) {
			records.push({
				commitSha,
				entityNodeId,
				// Approximate: lines attributed to this commit in this entity
				linesAdded: lineCount,
				linesDeleted: 0,
			});
		}
	}

	return records;
}

/**
 * Builds MODIFIED edge records at the File level (Commit → File).
 * Uses commit diff stats (from git diff-tree) rather than blame,
 * since blame only shows the *current* state.
 *
 * @param fileNodeId - nodeId of the File node
 * @param commitSha  - SHA of the commit
 * @param linesAdded - From git diff-tree --numstat
 * @param linesDeleted - From git diff-tree --numstat
 */
export function buildFileModifiedEdge(
	fileNodeId: string,
	commitSha: string,
	linesAdded: number,
	linesDeleted: number,
): ModifiedRecord {
	return { commitSha, entityNodeId: fileNodeId, linesAdded, linesDeleted };
}
