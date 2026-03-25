/**
 * @fileoverview Entity context endpoint.
 *
 * GET /entity/:nodeId — returns the full expanded context for a single entity:
 *   source code, file metadata, callers, callees, rendered components,
 *   hooks used, imported files, and developer expertise.
 */

import { Elysia } from "elysia";
import type { Driver } from "neo4j-driver";
import { expandContext } from "@codex/graph-client";

interface EntityDeps {
	driver: Driver;
}

export function entityRoutes(deps: EntityDeps) {
	return new Elysia().get("/entity/:nodeId", async ({ params, set }) => {
		const context = await expandContext(deps.driver, params.nodeId);

		if (!context) {
			set.status = 404;
			return { error: `Entity not found: ${params.nodeId}` };
		}

		return context;
	});
}
