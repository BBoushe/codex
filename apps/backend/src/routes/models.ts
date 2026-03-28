/**
 * @fileoverview Model catalogue endpoint.
 *
 * GET /models — returns the list of available LLM models for the currently
 * configured provider, plus the active provider name and default model.
 */

import { Elysia } from "elysia";

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
}

export interface ModelsResponse {
	provider: string;
	activeModel: string;
	models: ModelInfo[];
}

const MODELS_BY_PROVIDER: Record<string, ModelInfo[]> = {
	siliconflow: [
		{ id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", name: "Qwen3 Coder 30B", provider: "siliconflow" },
		{ id: "Qwen/Qwen3-14B", name: "Qwen3 14B", provider: "siliconflow" },
		{ id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3", provider: "siliconflow" },
		{ id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen2.5 72B", provider: "siliconflow" },
	],
	openai: [
		{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
		{ id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
		{ id: "gpt-4-turbo", name: "GPT-4 Turbo", provider: "openai" },
	],
	anthropic: [
		{ id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
		{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
		{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
	],
	gemini: [
		{ id: "gemini-3-flash-preview", name: "Gemini 3 Flash", provider: "gemini" },
		{ id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "gemini" },
		{ id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", provider: "gemini" },
	],
};

export function modelsRoutes() {
	return new Elysia().get("/models", (): ModelsResponse => {
		const provider = process.env.LLM_PROVIDER ?? "siliconflow";
		const activeModel = process.env.LLM_MODEL ?? "Qwen/Qwen3-Coder-30B-A3B-Instruct";
		const models = MODELS_BY_PROVIDER[provider] ?? [];
		return { provider, activeModel, models };
	});
}
