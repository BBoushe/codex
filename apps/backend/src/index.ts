import neo4j from "neo4j-driver";
import { initializeSchema } from "@codex/graph-client";
import { Elysia } from "elysia";

if (
	!process.env.NEO4J_URI ||
	!process.env.NEO4J_USER ||
	!process.env.NEO4J_PASSWORD
) {
	console.error(
		"Please set NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD environment variables.",
	);
	process.exit(1);
}

const driver = neo4j.driver(
	process.env.NEO4J_URI || "bolt://localhost:7687",
	neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD),
);

const result = await initializeSchema(driver);
console.log(
	`Neo4j schema ready (${result.statementsRun}) statements, ${result.durationMs}ms}`,
);

const app = new Elysia().listen(3000);

console.log(`CODEX backend running at http://localhost:3000`);
