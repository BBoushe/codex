// Suppress ChromaDB's "No embedding function configuration found" deserialization
// warnings. These fire whenever the client deserialises a collection that was
// created without server-side embedding function metadata — expected when
// supplying pre-computed vectors directly. The warnings are harmless.
const _consoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
	if (
		typeof args[0] === "string" &&
		args[0].includes("No embedding function")
	)
		return;
	_consoleWarn(...args);
};

import neo4j from "neo4j-driver";
import { Elysia } from "elysia";
import { initializeSchema } from "@codex/graph-client";
import {
	createSiliconFlowEmbeddingProvider,
	createOpenAIEmbeddingProvider,
} from "@codex/shared";
import { createChromaClient } from "@codex/vector-client";
import { searchRoutes } from "./routes/search.js";

// ─── Environment validation ──────────────────────────────────────────────────

console.log("Starting CODEX backend...");

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

// ─── Neo4j ───────────────────────────────────────────────────────────────────

const driver = neo4j.driver(
	process.env.NEO4J_URI,
	neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD),
);

const schemaResult = await initializeSchema(driver);
console.log(
	`Neo4j schema ready (${schemaResult.statementsRun} statements, ${schemaResult.durationMs}ms)`,
);

// ─── ChromaDB ────────────────────────────────────────────────────────────────

const chromaClient = createChromaClient();

// ─── Embedding provider ──────────────────────────────────────────────────────

const providerName = process.env.EMBEDDING_PROVIDER ?? "siliconflow";

function initEmbeddingProvider() {
	if (providerName === "openai") {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.error(
				"OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai",
			);
			process.exit(1);
		}
		return createOpenAIEmbeddingProvider({ apiKey });
	}

	const apiKey = process.env.SILICONFLOW_API_KEY;
	if (!apiKey) {
		console.error("SILICONFLOW_API_KEY is required for embedding search.");
		process.exit(1);
	}
	return createSiliconFlowEmbeddingProvider({ apiKey });
}

const embeddingProvider = initEmbeddingProvider();
console.log(
	`Embedding provider: ${embeddingProvider.providerName} (${embeddingProvider.modelId})`,
);

// ─── Elysia app ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const app = new Elysia()
	.use(searchRoutes({ chromaClient, embeddingProvider }))
	.get("/health", () => ({ status: "ok", neo4j: true, chroma: true }))
	.listen(PORT);

console.log(`CODEX backend running at http://localhost:${PORT}`);
