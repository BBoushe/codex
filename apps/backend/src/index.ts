import neo4j from "neo4j-driver";
import { Elysia } from "elysia";
import { initializeSchema } from "@codex/graph-client";
import {
	createSiliconFlowEmbeddingProvider,
	createOpenAIEmbeddingProvider,
	createSiliconFlowLLMProvider,
	createOpenAILLMProvider,
	createAntrhopicLLMProvider,
	createGeminiLLMProvider,
} from "@codex/shared";
import { createChromaClient } from "@codex/vector-client";
import { searchRoutes } from "./routes/search.js";
import { hybridRoutes } from "./routes/hybrid.js";

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

const embeddingProviderName = process.env.EMBEDDING_PROVIDER ?? "siliconflow";

function initEmbeddingProvider() {
	if (embeddingProviderName === "openai") {
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

// ─── LLM provider (synthesis) ────────────────────────────────────────────────

const llmProviderName = process.env.LLM_PROVIDER ?? "siliconflow";
const llmModel = process.env.LLM_MODEL ?? "Qwen/Qwen3-Coder-30B-A3B-Instruct";

function initLLMProvider() {
	if (llmProviderName === "anthropic") {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			console.error(
				"ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic",
			);
			process.exit(1);
		}
		return createAntrhopicLLMProvider({ apiKey, model: llmModel });
	}

	if (llmProviderName === "openai") {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
			process.exit(1);
		}
		return createOpenAILLMProvider({ apiKey, model: llmModel });
	}

	if (llmProviderName === "gemini") {
		const apiKey = process.env.GEMINI_API_KEY;
		if (!apiKey) {
			console.error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini");
			process.exit(1);
		}
		return createGeminiLLMProvider({ apiKey, model: llmModel });
	}

	// Default: SiliconFlow
	const apiKey = process.env.SILICONFLOW_API_KEY;
	if (!apiKey) {
		console.error("SILICONFLOW_API_KEY is required for LLM synthesis.");
		process.exit(1);
	}
	return createSiliconFlowLLMProvider({ apiKey, model: llmModel });
}

const llmProvider = initLLMProvider();
console.log(
	`LLM provider: ${llmProvider.providerName} (${llmProvider.modelId})`,
);

// ─── Classifier provider (intent classification) ─────────────────────────────

const classifierModel = process.env.CLASSIFIER_MODEL ?? "Qwen/Qwen3-14B";

function initClassifierProvider() {
	// Classifier always uses SiliconFlow with a dedicated fast model
	const apiKey = process.env.SILICONFLOW_API_KEY;
	if (!apiKey) {
		console.error("SILICONFLOW_API_KEY is required for intent classification.");
		process.exit(1);
	}
	return createSiliconFlowLLMProvider({ apiKey, model: classifierModel });
}

const classifierProvider = initClassifierProvider();
console.log(
	`Classifier provider: ${classifierProvider.providerName} (${classifierProvider.modelId})`,
);

// ─── Elysia app ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000", 10);

new Elysia()
	.use(searchRoutes({ chromaClient, embeddingProvider }))
	.use(
		hybridRoutes({
			driver,
			chromaClient,
			embeddingProvider,
			llmProvider,
			classifierProvider,
		}),
	)
	.get("/health", () => ({ status: "ok", neo4j: true, chroma: true }))
	.listen(PORT);

console.log(`CODEX backend running at http://localhost:${PORT}`);
