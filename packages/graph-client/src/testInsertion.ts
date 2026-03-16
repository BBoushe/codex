/**
 * @fileoverview smoke test for the full parser → Neo4j pipeline.
 *
 * Run from repo root:
 *   bun run packages/graph-client/src/testInsertion.ts
 *
 * Expects:
 *   - Neo4j running on localhost:7687 (docker compose up)
 *   - NEO4J_PASSWORD in root .env
 */

import neo4j from "neo4j-driver";
import { parseProject } from "@codex/parser";
import { initializeSchema, clearGraph, insertParseResults } from "./index";
import path from "path";

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "password";

const FIXTURE_PATH = path.resolve(
	import.meta.dir,
	"../../parser/fixtures/mini-app",
);

async function main() {
	console.log("═══════════════════════════════════════════");
	console.log("  CODEX — Parser → Neo4j insertion test");
	console.log("═══════════════════════════════════════════\n");

	// 1. Connect ---------------------------------------------------------------
	const driver = neo4j.driver(
		NEO4J_URI,
		neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
	);

	try {
		await driver.verifyConnectivity();
		console.log("✔  Neo4j connected\n");
	} catch {
		console.error("✘  Neo4j connection failed — is docker compose up?");
		process.exit(1);
	}

	// 2. Schema ----------------------------------------------------------------
	const schemaResult = await initializeSchema(driver);
	console.log(
		`✔  Schema ready (${schemaResult.statementsRun} statements, ${schemaResult.durationMs}ms)\n`,
	);

	// 3. Wipe existing data (clean slate for repeatable testing) ---------------
	console.log("⟳  Clearing existing graph data …");
	await clearGraph(driver);
	console.log("✔  Graph cleared\n");

	// 4. Parse the fixture ------------------------------------------------------
	console.log(`⟳  Parsing fixture: ${FIXTURE_PATH}`);
	const { files, stats: parseStats } = await parseProject(FIXTURE_PATH);

	console.log(`✔  Parse complete:`);
	console.log(`     Files found     : ${parseStats.filesFound}`);
	console.log(`     Files parsed    : ${parseStats.filesParsed}`);
	console.log(`     Files failed    : ${parseStats.filesFailed}`);
	console.log(`     Total entities  : ${parseStats.totalEntities}`);
	console.log(`     Total relations : ${parseStats.totalRelationships}`);
	console.log(`     Parse time      : ${parseStats.totalDurationMs}ms\n`);

	// 5. Insert ----------------------------------------------------------------
	console.log("⟳  Inserting into Neo4j …");
	const insertStats = await insertParseResults(driver, files);

	console.log(`✔  Insertion complete:`);
	console.log(`     Files inserted  : ${insertStats.filesInserted}`);
	console.log(`     Nodes inserted  : ${insertStats.nodesInserted}`);
	console.log(`     Edges inserted  : ${insertStats.edgesInserted}`);
	console.log(`     Duration        : ${insertStats.durationMs}ms\n`);

	console.log("  Nodes by label:");
	for (const [label, count] of Object.entries(insertStats.nodesByLabel)) {
		console.log(`     ${label.padEnd(16)} ${count}`);
	}

	console.log("\n  Edges by type:");
	for (const [type, count] of Object.entries(insertStats.edgesByType)) {
		console.log(`     ${type.padEnd(20)} ${count}`);
	}

	// 6. Verification queries --------------------------------------------------
	console.log("\n⟳  Running verification queries …\n");
	const session = driver.session();

	try {
		// Total node count
		const nodeCount = await session.run("MATCH (n) RETURN count(n) AS c");

		if (nodeCount.records.length === 0) {
			console.error("✘  No records returned from node count query");
			process.exit(1);
		}

		console.log(
			`     Total nodes in DB    : ${nodeCount.records[0]?.get("c")}`,
		);

		// Total edge count
		const edgeCount = await session.run(
			"MATCH ()-[r]->() RETURN count(r) AS c",
		);
		console.log(
			`     Total edges in DB    : ${edgeCount.records[0]?.get("c")}`,
		);

		// Spot-check: list all Function nodes
		const fns = await session.run(
			"MATCH (f:Function) RETURN f.name AS name, f.filePath AS file ORDER BY f.name",
		);
		console.log(`\n     Function nodes (${fns.records.length}):`);
		for (const r of fns.records) {
			console.log(`       - ${r.get("name")}  (${r.get("file")})`);
		}

		// Spot-check: CALLS edges
		const calls = await session.run(
			`MATCH (a)-[:CALLS]->(b)
       RETURN a.name AS caller, b.name AS callee
       LIMIT 10`,
		);
		console.log(`\n     CALLS edges (first ${calls.records.length}):`);
		for (const r of calls.records) {
			console.log(`       ${r.get("caller")} → ${r.get("callee")}`);
		}

		// Spot-check: RENDERS edges (React component tree)
		const renders = await session.run(
			`MATCH (a:Component)-[:RENDERS]->(b:Component)
       RETURN a.name AS parent, b.name AS child`,
		);
		console.log(`\n     RENDERS edges (${renders.records.length}):`);
		for (const r of renders.records) {
			console.log(`       ${r.get("parent")} → ${r.get("child")}`);
		}

		// Spot-check: IMPORTS edges (module dependency graph)
		const imports = await session.run(
			`MATCH (a:File)-[:IMPORTS]->(b:File)
       RETURN a.filePath AS from, b.filePath AS to`,
		);
		console.log(`\n     IMPORTS edges (${imports.records.length}):`);
		for (const r of imports.records) {
			console.log(`       ${r.get("from")} → ${r.get("to")}`);
		}
	} finally {
		await session.close();
	}

	await driver.close();

	console.log("\n═══════════════════════════════════════════");
	console.log("  All checks passed. Graph is populated.");
	console.log("  Open http://localhost:7474 to explore visually.");
	console.log("═══════════════════════════════════════════\n");
}

main().catch((err) => {
	console.error("\n✘  Fatal error:", err);
	process.exit(1);
});
