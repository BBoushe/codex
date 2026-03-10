/**
 * @fileoverview Provider-agnostic embedding interface and implementations.
 *
 * All embedding providers expose the same interface, allowing the rest of the
 * codebase to be completely decoupled from any specific vendor.
 *
 * Supported providers:
 *   - OpenAI (text-embedding-3-large, text-embedding-3-small)
 *   - Any OpenAI-compatible endpoint (SiliconFlow/Qwen, Azure, etc.)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single embedding vector.
 * Using `number[]` rather than `Float32Array` for JSON serialisation
 * compatibility with ChromaDB's JS client.
 */
export type EmbeddingVector = number[];

/** Result of a batch embed call — parallel array to the input texts. */
export interface EmbeddingResult {
	/** Array of embedding vectors, parallel to the input `texts`. */
	vectors: EmbeddingVector[];
	/** Total tokens consumed (for cost tracking / logging). */
	totalTokens: number;
	/** Model that produced these embeddings. */
	model: string;
}

/**
 * Provider-agnostic interface for text/code embedding.
 *
 * Implementations must be stateless with respect to individual requests —
 * all configuration lives in the constructor.
 */
export interface EmbeddingProvider {
	/**
	 * Embeds a batch of texts in a single API call.
	 *
	 * @param texts - Raw strings to embed. For code entities, pass the
	 *   `sourceCode` field directly; do NOT pre-tokenize.
	 * @returns Parallel array of vectors, same order as `texts`.
	 */
	embedBatch(texts: string[]): Promise<EmbeddingResult>;

	/**
	 * Convenience wrapper for single-text embedding.
	 * Delegates to `embedBatch` internally.
	 */
	embedOne(text: string): Promise<EmbeddingVector>;

	/** Output vector dimensionality.
	 * @remark Required for ChromaDB collection setup. */
	readonly dimensions: number;

	/** Human-readable model identifier (e.g. "text-embedding-3-large"). */
	readonly modelId: string;

	/** Provider name for logging and config validation. */
	readonly providerName: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI-compatible implementation
//
// Works with: OpenAI, SiliconFlow (Qwen3-Embedding), Azure OpenAI,
// any other provider that mirrors the /v1/embeddings endpoint.
// ─────────────────────────────────────────────────────────────────────────────

interface OpenAIEmbeddingResponseBody {
	data: Array<{ embedding: number[]; index: number }>;
	usage: { prompt_tokens: number; total_tokens: number };
	model: string;
}

export interface OpenAICompatibleEmbeddingConfig {
	/** Full base URL including version path (e.g. "https://api.siliconflow.cn/v1"). */
	baseURL: string;
	apiKey: string;
	/** Model identifier as accepted by the provider. */
	model: string;
	/**
	 * Output vector dimensions.
	 * - OpenAI text-embedding-3-large: 3072 (or 1536 with dimension reduction)
	 * - Qwen3-Embedding-4B (SiliconFlow): 2560 (supports Matryoshka truncation)
	 * Set explicitly; do not leave undefined.
	 */
	dimensions: number;
	/**
	 * Maximum number of texts per API request.
	 * OpenAI supports up to 2048; SiliconFlow defaults to lower limits.
	 * @default 512
	 */
	maxBatchSize?: number;
	providerName?: string;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions: number;
	readonly modelId: string;
	readonly providerName: string;

	private readonly baseURL: string;
	private readonly apiKey: string;
	private readonly maxBatchSize: number;

	constructor(config: OpenAICompatibleEmbeddingConfig) {
		this.baseURL = config.baseURL.replace(/\/$/, ""); // strip trailing slash
		this.apiKey = config.apiKey;
		this.modelId = config.model;
		this.dimensions = config.dimensions;
		this.maxBatchSize = config.maxBatchSize ?? 512;
		this.providerName = config.providerName ?? "openai-compatible";
	}

	async embedBatch(texts: string[]): Promise<EmbeddingResult> {
		if (texts.length === 0) {
			return { vectors: [], totalTokens: 0, model: this.modelId };
		}

		// Split into chunks that respect the provider's batch size limit
		const chunks = chunkArray(texts, this.maxBatchSize);
		const results: EmbeddingResult[] = [];

		for (const chunk of chunks) {
			const result = await this.callAPI(chunk);
			results.push(result);
		}

		return {
			vectors: results.flatMap((r) => r.vectors),
			totalTokens: results.reduce((sum, r) => sum + r.totalTokens, 0),
			model: this.modelId,
		};
	}

	async embedOne(text: string): Promise<EmbeddingVector> {
		const result = await this.embedBatch([text]);
		const vector = result.vectors[0];
		if (!vector) {
			throw new Error(
				`[${this.providerName}] embedOne returned no vector for the provided text`,
			);
		}
		return vector;
	}

	private async callAPI(texts: string[]): Promise<EmbeddingResult> {
		const response = await fetch(`${this.baseURL}/embeddings`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.modelId,
				input: texts,
				// Pass dimensions only if the provider supports Matryoshka truncation.
				// Omitting it for providers that don't support the parameter is safer.
				...(this.dimensions ? { dimensions: this.dimensions } : {}),
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[${this.providerName}] Embedding API error ${response.status}: ${errorBody}`,
			);
		}

		const body = (await response.json()) as OpenAIEmbeddingResponseBody;

		// The API returns embeddings in an arbitrary order indexed by `index`.
		// Re-sort to match the input order.
		const sorted = [...body.data].sort((a, b) => a.index - b.index);
		const vectors = sorted.map((item) => item.embedding);

		return {
			vectors,
			totalTokens: body.usage.total_tokens,
			model: body.model,
		};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-configured provider factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an embedding provider backed by OpenAI's API.
 *
 * @example
 * const provider = createOpenAIEmbeddingProvider({
 *   apiKey: process.env.OPENAI_API_KEY,
 *   model: "text-embedding-3-large",
 *   dimensions: 3072,
 * });
 */
export function createOpenAIEmbeddingProvider(config: {
	apiKey: string;
	model?: string;
	dimensions?: number;
}): OpenAICompatibleEmbeddingProvider {
	const currentVersion = process.env.OPENAI_API_VERSION || "v1";

	return new OpenAICompatibleEmbeddingProvider({
		baseURL: `https://api.openai.com/${currentVersion}`,
		apiKey: config.apiKey,
		model: config.model ?? "text-embedding-3-large",
		dimensions: config.dimensions ?? 3072,
		maxBatchSize: 2048,
		providerName: "openai",
	});
}

/**
 * Creates an embedding provider backed by SiliconFlow's OpenAI-compatible API.
 * Defaults to Qwen3-Embedding-4B with 2560 dimensions.
 *
 * @example
 * const provider = createSiliconFlowEmbeddingProvider({
 *   apiKey: process.env.SILICONFLOW_API_KEY,
 * });
 */
export function createSiliconFlowEmbeddingProvider(config: {
	apiKey: string;
	model?: string;
	dimensions?: number;
}): OpenAICompatibleEmbeddingProvider {
	const currentVersion = process.env.SILICONFLOW_API_VERSION || "v1";

	return new OpenAICompatibleEmbeddingProvider({
		baseURL: `https://api.siliconflow.com/${currentVersion}`,
		apiKey: config.apiKey,
		model: config.model ?? "Qwen/Qwen3-Embedding-4B",
		dimensions: config.dimensions ?? 2560,
		maxBatchSize: 64, // SiliconFlow has lower batch limits than OpenAI
		providerName: "siliconflow",
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function chunkArray<T>(array: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size));
	}
	return chunks;
}
