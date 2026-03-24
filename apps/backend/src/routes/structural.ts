/**
 * @fileoverview Structural search and path-finding endpoints.
 *
 * POST /search/structural — direct Cypher pattern queries (no LLM)
 * POST /search/path       — shortest path between two entities
 *
 * Both endpoints return deterministic, structure-derived results.
 */

import { Elysia, t } from "elysia";
import type { Driver } from "neo4j-driver";
import {
	structuralQuery,
	findShortestPath,
	resolveEntityByName,
	isNodeId,
	type StructuralPattern,
	type StructuralQueryResult,
} from "@codex/graph-client";

// ─────────────────────────────────────────────────────────────────────────────
// Route factory
// ─────────────────────────────────────────────────────────────────────────────

interface StructuralDeps {
	driver: Driver;
}

export function structuralRoutes(deps: StructuralDeps) {
	return new Elysia({ prefix: "/search" })
		.post(
			"/structural",
			async ({
				body,
			}: {
				body: { pattern: string; name: string };
			}): Promise<StructuralQueryResult> => {
				return structuralQuery(
					deps.driver,
					body.pattern as StructuralPattern,
					body.name,
				);
			},
			{
				body: t.Object({
					pattern: t.String({ minLength: 1 }),
					name: t.String({ minLength: 1 }),
				}),
			},
		)
		.post(
			"/path",
			async ({ body, set }) => {
				const maxHops = body.maxHops ?? 5;

				// Resolve `from` — either a raw nodeId or an entity name
				const fromNodeId = await resolveToNodeId(
					deps.driver,
					body.from,
				);
				if (!fromNodeId.nodeId) {
					set.status = 400;
					return {
						error: `Could not resolve "from" entity: "${body.from}"`,
						fromCandidates: fromNodeId.candidates,
					};
				}

				// Resolve `to`
				const toNodeId = await resolveToNodeId(deps.driver, body.to);
				if (!toNodeId.nodeId) {
					set.status = 400;
					return {
						error: `Could not resolve "to" entity: "${body.to}"`,
						toCandidates: toNodeId.candidates,
					};
				}

				const result = await findShortestPath(
					deps.driver,
					fromNodeId.nodeId,
					toNodeId.nodeId,
					maxHops,
				);

				if (!result) {
					set.status = 404;
					return {
						error: `No path found between "${body.from}" and "${body.to}" within ${maxHops} hops`,
					};
				}

				return result;
			},
			{
				body: t.Object({
					from: t.String({ minLength: 1 }),
					to: t.String({ minLength: 1 }),
					maxHops: t.Optional(
						t.Number({ minimum: 1, maximum: 10 }),
					),
				}),
			},
		);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ResolveResult {
	nodeId: string | null;
	candidates: string[];
}

/** Auto-detects whether input is a nodeId (16-char hex) or a name, resolves accordingly. */
async function resolveToNodeId(
	driver: Driver,
	input: string,
): Promise<ResolveResult> {
	if (isNodeId(input)) {
		return { nodeId: input, candidates: [] };
	}

	const resolved = await resolveEntityByName(driver, input);
	if (resolved.length === 0) {
		return { nodeId: null, candidates: [] };
	}

	// Return the first match; include all candidates for error messages
	return {
		nodeId: resolved[0]!.nodeId,
		candidates: resolved.map(
			(r) => `${r.name} (${r.label}) — ${r.filePath}`,
		),
	};
}
