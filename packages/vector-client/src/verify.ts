/**
 * @fileoverview End-to-end verification for the embedding pipeline.
 *
 * Run after `codex ingest` to verify:
 *   1. ChromaDB connectivity
 *   2. Neo4j entity fetch
 *   3. Context string formatting
 *   4. Embedding + upsert pipeline
 *   5. Vector search with sample queries
 *
 * Usage: bun run packages/vector-client/src/verify.ts
 */

import neo4j from "neo4j-driver";
import { createSiliconFlowEmbeddingProvider } from "@codex/shared";
import {
	createChromaClient,
	verifyChromaConnectivity,
	fetchEmbeddableNodes,
	runEmbeddingPipeline,
	searchEntities,
	getOrCreateEntityCollection,
} from "./index.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "";

if (!NEO4J_PASSWORD) {
	console.error("NEO4J_PASSWORD is not set. Add it to your .env file.");
	process.exit(1);
}

const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY ?? "";
if (!SILICONFLOW_API_KEY) {
	console.error(
		"SILICONFLOW_API_KEY is not set. Add it to your .env file.",
	);
	process.exit(1);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const driver = neo4j.driver(
	NEO4J_URI,
	neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
);

try {
	// 1. Verify ChromaDB
	console.log("── Step 1: ChromaDB connectivity ──");
	const chromaClient = createChromaClient();
	const heartbeat = await verifyChromaConnectivity(chromaClient);
	console.log(`  ✔ ChromaDB heartbeat: ${heartbeat}`);

	// 2. Fetch embeddable entities
	console.log("\n── Step 2: Fetch embeddable entities from Neo4j ──");
	const entities = await fetchEmbeddableNodes(driver);
	console.log(`  ✔ Found ${entities.length} embeddable entities`);

	if (entities.length === 0) {
		console.log("  ⚠ No entities found — run `codex ingest` first.");
		process.exit(0);
	}

	// Show a sample context string
	const sample = entities[0]!;
	console.log(`\n  Sample: ${sample.name} (${sample.label})`);
	console.log(
		`  Context (first 200 chars): ${sample.contextString.slice(0, 200)}...`,
	);

	// 3. Run embedding pipeline
	console.log("\n── Step 3: Embedding pipeline ──");
	const provider = createSiliconFlowEmbeddingProvider({
		apiKey: SILICONFLOW_API_KEY,
	});

	const stats = await runEmbeddingPipeline({
		driver,
		chromaClient,
		embeddingProvider: provider,
		clean: true,
		onProgress: (done, total) => {
			process.stdout.write(`\r  Embedding: ${done}/${total}`);
		},
	});

	console.log(
		`\n  ✔ Embedded ${stats.entitiesEmbedded} entities, ${stats.totalTokens} tokens, ${stats.durationMs}ms`,
	);
	if (stats.entitiesFailed > 0) {
		console.log(`  ⚠ ${stats.entitiesFailed} failures:`);
		for (const f of stats.failures) {
			console.log(`    - ${f.name}: ${f.error}`);
		}
	}

	// 4. Test queries
	console.log("\n── Step 4: Vector search tests ──");
	const collection = await getOrCreateEntityCollection(chromaClient);

	const queries = [
		{ query: "fetchUser", description: "Exact function name" },
		{
			query: "user data fetching logic",
			description: "Descriptive query",
		},
		{
			query: "what handles rendering posts",
			description: "Behavioral query",
		},
		{ query: "database migration", description: "Negative test" },
		{
			query: "get user information",
			description: "Synonym test",
		},
	];

	for (const { query, description } of queries) {
		const queryVector = await provider.embedOne(query);
		const results = await searchEntities(collection, queryVector, 3);

		console.log(`\n  Query: "${query}" (${description})`);
		if (results.length === 0) {
			console.log("    No results");
		} else {
			for (const r of results) {
				console.log(
					`    ${r.name.padEnd(25)} ${r.label.padEnd(12)} dist=${r.distance.toFixed(4)}  ${r.filePath}`,
				);
			}
		}
	}

	console.log("\n✅ Verification complete\n");
} catch (error) {
	console.error("\n❌ Verification failed:", error);
	process.exit(1);
} finally {
	await driver.close();
}
