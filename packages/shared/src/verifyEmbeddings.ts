import { createSiliconFlowEmbeddingProvider } from "./providers";

const apiKey = process.env.SILICONFLOW_API_KEY;

if (!apiKey) {
	throw new Error(
		"SILICONFLOW_API_KEY is not set, Please set it in your environment variables.",
	);
}

const provider = createSiliconFlowEmbeddingProvider({
	apiKey,
	model: process.env.SILICONFLOW_EMBEDDING_MODEL,
});

const result = await provider.embedOne("function validateToken() {}");

console.log("Embedding dimensions:", result.length);
console.log("Embedding result:", result);
