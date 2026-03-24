/**
 * @fileoverview Provider-agnostic LLM interface and implementations.
 *
 * Used by the RAG synthesis step to generate natural language answers
 * from retrieved code context.
 *
 * Supported providers:
 *   - SiliconFlow (OpenSource LLM hosting with OpenAI-compatible API)
 *   - Anthropic (Claude Haiku / Sonnet)
 *   - OpenAI (GPT-4o-mini / GPT-4o)
 *   - Any OpenAI-compatible endpoint (Gemini, etc.)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared message types
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface LLMResponse {
	/** The generated text content. */
	content: string;
	/** Model that produced this response. */
	model: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
	};
}

export interface LLMGenerateOptions {
	/** Maximum tokens to generate in the response. */
	maxTokens?: number;
	/** Sampling temperature (0.0 = deterministic, 1.0 = more random).
	 * @default 0.2
	 */
	temperature?: number;
	/** Top-p nucleus sampling parameter (0.0-1.0). */
	topP?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────────────

/** Provider-agnostic interface for LLM text generation */
export interface LLMProvider {
	/** Generates a response from a list of messages (conversation history)
	 *
	 * For single-turn RAG synthesis, pass a single user message containing
	 * the assembled code context and the user's question
	 */
	generate(
		messages: LLMMessage[],
		options?: LLMGenerateOptions,
	): Promise<LLMResponse>;

	/** Human-readable model identifier (e.g. "gpt-4o-mini"). */
	readonly modelId: string;

	/** Provider name for logging and config validation. */
	readonly providerName: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic implementation
// ─────────────────────────────────────────────────────────────────────────────

interface AnthropicResponseBody {
	content: Array<{ type: string; text: string }>;
	model: string;
	usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicLLMConfig {
	apiKey: string;
	model?: string;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
}

export class AnthropicLLMProvider implements LLMProvider {
	readonly modelId: string;
	readonly providerName = "anthropic";

	private readonly apiKey: string;

	constructor(config: AnthropicLLMConfig) {
		this.apiKey = config.apiKey;
		this.modelId = config.model ?? "claude-haiku-4-5-20251001";
	}

	async generate(
		messages: LLMMessage[],
		options: LLMGenerateOptions = {},
	): Promise<LLMResponse> {
		const { maxTokens = 1024, temperature = 0.2, topP = 0.9 } = options;

		const systemMessage = messages.find((msg) => msg.role === "system");
		const conversationMessages = messages.filter(
			(msg) => msg.role !== "system",
		);

		const body: Record<string, unknown> = {
			model: this.modelId,
			max_tokens: maxTokens,
			temperature,
			top_p: topP,
			messages: conversationMessages.map((msg) => ({
				role: msg.role,
				content: msg.content,
			})),
		};

		// If a system message is present, include it in the body (Anthropic API supports a separate system field)
		if (systemMessage) {
			body.system = systemMessage.content;
		}

		const currentVersion = process.env.ANTHROPIC_API_VERSION || "v1";

		const response = await fetch(
			`https://api.anthropic.com/${currentVersion}/messages`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": this.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify(body),
			},
		);

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[anthropic] LLM API error ${response.status}: ${errorBody}`,
			);
		}

		const data = (await response.json()) as AnthropicResponseBody;
		const textBlock = data.content.find((block) => block.type === "text");

		if (!textBlock) {
			throw new Error("[anthropic] Response contained no text block");
		}

		return {
			content: textBlock.text,
			model: data.model,
			usage: {
				inputTokens: data.usage.input_tokens,
				outputTokens: data.usage.output_tokens,
			},
		};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI-compatible implementation (for OpenAI, Gemini, etc.)
// ─────────────────────────────────────────────────────────────────────────────

interface OpenAIChatResponseBody {
	choices: Array<{
		message: { content: string };
		finish_reason: string;
	}>;
	model: string;
	usage: { prompt_tokens: number; completion_tokens: number };
}

export interface OpenAICompatibleLLMConfig {
	baseURL: string;
	apiKey: string;
	model: string;
	providerName: string;
}

export class OpenAICompatibleLLMProvider implements LLMProvider {
	readonly modelId: string;
	readonly providerName: string;

	private readonly apiKey: string;
	private readonly baseURL: string;

	constructor(config: OpenAICompatibleLLMConfig) {
		this.apiKey = config.apiKey;
		this.baseURL = config.baseURL.replace(/\/+$/, ""); // Remove trailing slashes for consistency
		this.modelId = config.model;
		this.providerName = config.providerName ?? "openai-compatible";
	}

	async generate(
		messages: LLMMessage[],
		options: LLMGenerateOptions = {},
	): Promise<LLMResponse> {
		const { maxTokens = 1024, temperature = 0.2, topP = 0.9 } = options;

		const response = await fetch(`${this.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.modelId,
				max_tokens: maxTokens,
				temperature,
				top_p: topP,
				messages: messages.map((msg) => ({
					role: msg.role,
					content: msg.content,
				})),
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[${this.providerName}] LLM API error ${response.status}: ${errorBody}`,
			);
		}

		const data = (await response.json()) as OpenAIChatResponseBody;
		const choice = data.choices[0];

		if (!choice) {
			throw new Error(`[${this.providerName}] Response contained no choices`);
		}

		return {
			content: choice.message.content,
			model: data.model,
			usage: {
				inputTokens: data.usage.prompt_tokens,
				outputTokens: data.usage.completion_tokens,
			},
		};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-configured provider factories
// ─────────────────────────────────────────────────────────────────────────────

export function createAntrhopicLLMProvider(config: {
	apiKey: string;
	model?: string;
}): AnthropicLLMProvider {
	return new AnthropicLLMProvider(config);
}

export function createOpenAILLMProvider(config: {
	apiKey: string;
	model?: string;
}): OpenAICompatibleLLMProvider {
	return new OpenAICompatibleLLMProvider({
		baseURL: `https://api.openai.com/${process.env.OPENAI_API_VERSION || "v1"}`,
		apiKey: config.apiKey,
		model: config.model ?? "gpt-4o-mini",
		providerName: "openai",
	});
}

export function createGeminiLLMProvider(config: {
	apiKey: string;
	model?: string;
}): OpenAICompatibleLLMProvider {
	return new OpenAICompatibleLLMProvider({
		baseURL: `https://generativelanguage.googleapis.com/${process.env.GEMINI_API_VERSION || "v1beta"}/openai`,
		apiKey: config.apiKey,
		model: config.model ?? "gemini-3-flash-preview",
		providerName: "gemini",
	});
}

export function createSiliconFlowLLMProvider(config: {
	apiKey: string;
	model?: string;
}): OpenAICompatibleLLMProvider {
	return new OpenAICompatibleLLMProvider({
		baseURL: `https://api.siliconflow.com/${process.env.SILICONFLOW_API_VERSION || "v1"}`,
		apiKey: config.apiKey,
		model: config.model ?? "Qwen/Qwen3-Coder-30B-A3B-Instruct",
		providerName: "siliconflow",
	});
}

/** Currently not used, implemented for future use when we want to route proprietary models through OpenRouter's API
 */
function createOpenRouterLLMProvider(config: {
	apiKey: string;
	model?: string;
}): OpenAICompatibleLLMProvider {
	return new OpenAICompatibleLLMProvider({
		baseURL: `https://openrouter.ai/api/${process.env.OPENROUTER_API_VERSION || "v1"}`,
		apiKey: config.apiKey,
		model: config.model ?? "anthropic/claude-haiku-4-5-20251001",
		providerName: "openrouter",
	});
}
