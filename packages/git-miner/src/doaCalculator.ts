/**
 * @fileoverview Degree of Authorship (DOA) calculator.
 *
 * Implements the Fritz et al. formula:
 *   DOA_raw = 3.293 + 1.098 × FA + 0.164 × DL − 0.321 × ln(1 + AC)
 *
 * Where:
 *   FA (First Author)  — 1 if developer made the first commit to this file
 *   DL (Deliveries)    — number of commits by this developer to this file
 *   AC (Acceptances)   — number of commits by OTHERS after this dev's last commit
 *
 * Recency decay: DOA_decayed = DOA_raw × exp(−λ × daysSinceLastContrib)
 * where λ = ln(2)/180 gives a 180-day half-life.
 *
 * Scores are normalized per-file to [0, 1] by dividing by the file maximum.
 */

import type { FileHistory, ExpertiseRecord } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Fritz et al. weights */
const W_INTERCEPT = 3.293;
const W_FA = 1.098;
const W_DL = 0.164;
const W_AC = -0.321;

/** Half-life of 180 days → λ = ln(2) / 180 */
const DECAY_LAMBDA = Math.LN2 / 180;

const MS_PER_DAY = 86_400_000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Computes DOA-based expertise records for all (developer, file) pairs.
 *
 * @param histories - Map of filePath → FileHistory (from orchestrator)
 * @returns One ExpertiseRecord per (developer, file) pair with DOA > 0
 */
export function computeExpertise(
	histories: Map<string, FileHistory>,
): ExpertiseRecord[] {
	const results: ExpertiseRecord[] = [];
	const now = Date.now();

	for (const [, history] of histories) {
		if (history.commits.length === 0) continue;

		const records = computeFileExpertise(history, now);
		results.push(...records);
	}

	return results;
}

// ─── Per-file computation ─────────────────────────────────────────────────────

function computeFileExpertise(
	history: FileHistory,
	now: number,
): ExpertiseRecord[] {
	const { commits, fileNodeId, filePath } = history;

	if (commits.length === 0) return [];

	// Oldest commit first
	const sorted = [...commits].sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
	);

	const firstAuthorEmail = sorted[0]?.authorEmail ?? "";

	// Count deliveries (commits per developer)
	const deliveries = new Map<string, number>();
	for (const c of sorted) {
		deliveries.set(c.authorEmail, (deliveries.get(c.authorEmail) ?? 0) + 1);
	}

	// Find last contribution timestamp per developer
	const lastContrib = new Map<string, Date>();
	for (const c of sorted) {
		const ts = new Date(c.timestamp);
		const prev = lastContrib.get(c.authorEmail);
		if (!prev || ts > prev) lastContrib.set(c.authorEmail, ts);
	}

	// Compute acceptances (commits by OTHERS after this dev's last commit)
	const acceptances = new Map<string, number>();
	for (const [email, lastDate] of lastContrib) {
		const othersAfter = sorted.filter(
			(c) => c.authorEmail !== email && new Date(c.timestamp) > lastDate,
		).length;
		acceptances.set(email, othersAfter);
	}

	// Compute raw DOA for each developer
	interface DevDoa {
		email: string;
		rawDoa: number;
		decayedDoa: number;
		isFirstAuthor: boolean;
		deliveries: number;
		acceptances: number;
		lastContribution: Date;
	}

	const devDoas: DevDoa[] = [];

	for (const [email, dl] of deliveries) {
		const fa = email === firstAuthorEmail ? 1 : 0;
		const ac = acceptances.get(email) ?? 0;
		const lastDate = lastContrib.get(email) ?? new Date();

		const rawDoa = W_INTERCEPT + W_FA * fa + W_DL * dl + W_AC * Math.log(1 + ac);
		const daysSince = (now - lastDate.getTime()) / MS_PER_DAY;
		const decayedDoa = Math.max(0, rawDoa * Math.exp(-DECAY_LAMBDA * daysSince));

		devDoas.push({
			email,
			rawDoa,
			decayedDoa,
			isFirstAuthor: fa === 1,
			deliveries: dl,
			acceptances: ac,
			lastContribution: lastDate,
		});
	}

	// Normalize per-file: divide by max decayed DOA
	const maxDecayed = Math.max(...devDoas.map((d) => d.decayedDoa), 1e-9);

	return devDoas.map((d) => ({
		developerEmail: d.email,
		fileNodeId,
		filePath,
		doaScore: maxDecayed > 0 ? d.decayedDoa / maxDecayed : 0,
		rawDoa: d.rawDoa,
		isFirstAuthor: d.isFirstAuthor,
		deliveries: d.deliveries,
		acceptances: d.acceptances,
		lastContribution: d.lastContribution.toISOString(),
	}));
}
