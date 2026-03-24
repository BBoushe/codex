/**
 * @fileoverview LLM synthesis step for the hybrid RAG pipeline.
 *
 * Takes an assembled context string and a user query, sends them to the
 * configured LLM provider, and returns the generated answer with usage stats.
 */

import type { LLMProvider } from "@codex/shared";
import { tokenTracker } from "@codex/shared";
import type { AssembledContext } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are CODEX, an intelligent code analysis assistant powered by a Code Property Graph (CPG).
You analyze codebases by combining structural relationships (function calls, imports, component rendering, hook usage, class inheritance) with semantic code understanding.

You will receive context in the following structured format:
- TARGET ENTITY: The primary code entity with its full source code, file location, and type.
- STRUCTURAL CONTEXT: Related entities connected via the code property graph — callers (what invokes this entity), callees (what it invokes), rendered components, hooks used, and file-level import dependencies.
- DEVELOPER CONTEXT: Author and expertise data (when available from git mining).

Rules:
- Answer the user's question based ONLY on the provided code context.
- If the context is insufficient to fully answer the question, say so explicitly.
- Do NOT hallucinate functions, classes, modules, or relationships not present in the context.
- When referencing code entities, use their qualified names (e.g., src/api/posts.ts::fetchPosts).
- Use code blocks (\`\`\`) for code snippets. Format your answer in clear paragraphs.`;

// ─────────────────────────────────────────────────────────────────────────────
// Synthesis options
// ─────────────────────────────────────────────────────────────────────────────

export interface SynthesisOptions {
	/** Maximum tokens to generate (default: 1024). */
	maxTokens?: number;
	/** Sampling temperature (default: 0.2 for factual answers). */
	temperature?: number;
}

export interface SynthesisResult {
	answer: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synthesizes a natural language answer from assembled code context.
 *
 * Sends system + user messages to the LLM provider and tracks token usage
 * via the shared tokenTracker.
 */
export async function synthesize(
	llmProvider: LLMProvider,
	userQuery: string,
	context: AssembledContext,
	options?: SynthesisOptions,
): Promise<SynthesisResult> {
	const userMessage = `--- CODE CONTEXT ---\n${context.text}\n\n--- QUESTION ---\n${userQuery}`;

	const response = await llmProvider.generate(
		[
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: userMessage },
		],
		{
			maxTokens: options?.maxTokens ?? 1024,
			temperature: options?.temperature ?? 0.2,
		},
	);

	tokenTracker.add({
		llmInput: response.usage.inputTokens,
		llmOutput: response.usage.outputTokens,
	});

	return {
		answer: response.content,
		model: response.model,
		usage: response.usage,
	};
}
