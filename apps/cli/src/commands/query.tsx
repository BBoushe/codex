/**
 * @fileoverview CLI `query` command — hybrid RAG search over the indexed codebase.
 *
 * Usage:
 *   codex query "What function handles post fetching?" --budget standard
 *   codex query "What does PostList render?" --budget compact
 *   codex query "Who knows about the auth module?"
 *
 * Flow:
 *   1. Classify intent (spinner)
 *   2. Run the appropriate pipeline (vector search / graph traversal / LLM synthesis)
 *   3. Display result based on kind: structural (table) | hybrid (prose) | social (devs)
 *   4. Show usage summary + PostRunOptions
 */

import { useState, useEffect } from "react";
import { Box, Text, render, useApp } from "ink";
import neo4j from "neo4j-driver";
import {
	createSiliconFlowEmbeddingProvider,
	createOpenAIEmbeddingProvider,
	createSiliconFlowLLMProvider,
	createOpenAILLMProvider,
	createAntrhopicLLMProvider,
	createGeminiLLMProvider,
} from "@codex/shared";
import { createChromaClient } from "@codex/vector-client";
import {
	runSearch,
	type SearchResult,
	type ContextBudget,
	type StructuralSearchResult,
	type HybridSearchResult,
	type SocialSearchResult,
} from "@codex/rag";
import { Layout } from "../ui/Layout.js";
import { PostRunOptions, type PostRunAction } from "../ui/PostRunOptions.js";
import { SummaryTable } from "@/ui/Progress.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "";
const CHROMA_URL = process.env.CHROMA_URL ?? "http://localhost:8000";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QueryOptions {
	budget?: ContextBudget;
	provider?: string;
	topK?: number;
	onComplete?: (action: PostRunAction) => void;
	nextPhaseLabel?: string; // e.g. "Run another query"
}

type RunPhase =
	| "connecting"
	| "classifying"
	| "searching"
	| "expanding"
	| "synthesizing"
	| "done"
	| "error";

// ─── Provider factories ──────────────────────────────────────────────────────

function createLLMProvider(providerName: string, model: string) {
	switch (providerName) {
		case "anthropic": {
			const apiKey = process.env.ANTHROPIC_API_KEY;
			if (!apiKey) {
				console.error(
					"ANTHROPIC_API_KEY is not set. Add it to your .env file.",
				);
				process.exit(1);
			}
			return createAntrhopicLLMProvider({ apiKey, model });
		}
		case "openai": {
			const apiKey = process.env.OPENAI_API_KEY;
			if (!apiKey) {
				console.error("OPENAI_API_KEY is not set. Add it to your .env file.");
				process.exit(1);
			}
			return createOpenAILLMProvider({ apiKey, model });
		}
		case "gemini": {
			const apiKey = process.env.GEMINI_API_KEY;
			if (!apiKey) {
				console.error("GEMINI_API_KEY is not set. Add it to your .env file.");
				process.exit(1);
			}
			return createGeminiLLMProvider({ apiKey, model });
		}
		case "siliconflow":
		default: {
			const apiKey = process.env.SILICONFLOW_API_KEY;
			if (!apiKey) {
				console.error(
					"SILICONFLOW_API_KEY is not set. Add it to your .env file.",
				);
				process.exit(1);
			}
			return createSiliconFlowLLMProvider({ apiKey, model });
		}
	}
}

// ─── Result renderers ────────────────────────────────────────────────────────

function StructuralResult({ result }: { result: StructuralSearchResult }) {
	if (result.entities.length === 0) {
		return (
			<Box marginTop={1}>
				<Text color="yellow">
					No results found for {result.pattern} "{result.query}".
				</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" marginTop={1} gap={0}>
			<Text bold color="cyan">
				{result.pattern} "{result.query}" — {result.entities.length} result
				{result.entities.length !== 1 ? "s" : ""}
			</Text>
			{result.entities.map((entity, i) => (
				<Box key={i} gap={2} paddingLeft={2}>
					<Text color="green">•</Text>
					<Text bold>{entity.name || entity.filePath}</Text>
					<Text color="gray">[{entity.label}]</Text>
					{entity.startLine != null && (
						<Text dimColor>
							{entity.filePath}:{entity.startLine}
						</Text>
					)}
					{entity.name === "" && <Text dimColor>{entity.filePath}</Text>}
				</Box>
			))}
		</Box>
	);
}

function HybridResult({ result }: { result: HybridSearchResult }) {
	return (
		<Box flexDirection="column" marginTop={1} gap={1}>
			<Text bold color="cyan">
				Answer
			</Text>
			<Box
				borderStyle="round"
				borderColor="gray"
				paddingX={2}
				paddingY={1}
				flexDirection="column"
			>
				<Text>{result.answer}</Text>
			</Box>
			{result.anchors.length > 0 && (
				<Box flexDirection="column" gap={0}>
					<Text bold color="gray" dimColor>
						Vector anchors:
					</Text>
					{result.anchors.map((anchor, i) => (
						<Box key={i} gap={2} paddingLeft={2}>
							<Text dimColor>•</Text>
							<Text dimColor>
								{anchor.name} ({anchor.filePath}) [{anchor.label}]
							</Text>
							<Text dimColor>dist={anchor.distance.toFixed(4)}</Text>
						</Box>
					))}
				</Box>
			)}
		</Box>
	);
}

function SocialResult({ result }: { result: SocialSearchResult }) {
	if (result.message) {
		return (
			<Box marginTop={1}>
				<Text color="yellow">{result.message}</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" marginTop={1} gap={0}>
			<Text bold color="cyan">
				Developers with expertise in "{result.query}"
			</Text>
			{result.developers.map((dev, i) => (
				<Box key={i} gap={2} paddingLeft={2}>
					<Text color="green">•</Text>
					<Text bold>{dev.name}</Text>
					<Text dimColor>
						{"<"}
						{dev.email}
						{">"}
					</Text>
					<Text color="cyan">DOA={dev.doaScore.toFixed(3)}</Text>
					{dev.isFirstAuthor && <Text color="yellow">[first author]</Text>}
				</Box>
			))}
		</Box>
	);
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

function Spinner({ label }: { label: string }) {
	return (
		<Box gap={2}>
			<Text color="cyan">⟳</Text>
			<Text color="gray">{label}</Text>
		</Box>
	);
}

// ─── Main UI component ───────────────────────────────────────────────────────

interface QueryUIProps {
	question: string;
	options: QueryOptions;
}

function QueryUI({ question, options }: QueryUIProps) {
	const { exit } = useApp();

	const [phase, setPhase] = useState<RunPhase>("connecting");
	const [phaseDetail, setPhaseDetail] = useState("");
	const [result, setResult] = useState<SearchResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [durationMs, setDurationMs] = useState(0);

	useEffect(() => {
		run().catch((err) => {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function run() {
		const budget: ContextBudget =
			options.budget ??
			(process.env["RAG_CONTEXT_BUDGET"] as ContextBudget | undefined) ??
			"standard";

		const providerName =
			options.provider ?? process.env["LLM_PROVIDER"] ?? "siliconflow";
		const llmModel =
			process.env["LLM_MODEL"] ?? "Qwen/Qwen3-Coder-30B-A3B-Instruct";
		const classifierModel = process.env["CLASSIFIER_MODEL"] ?? "Qwen/Qwen3-14B";

		// ── Connect ──────────────────────────────────────────────────────
		setPhase("connecting");
		setPhaseDetail(`Neo4j: ${NEO4J_URI}, ChromaDB: ${CHROMA_URL}`);

		const driver = neo4j.driver(
			NEO4J_URI,
			neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
		);

		const sfApiKey = process.env.SILICONFLOW_API_KEY;
		if (!sfApiKey) {
			console.error("SILICONFLOW_API_KEY is not set.");
			process.exit(1);
		}

		const embeddingProvider = createSiliconFlowEmbeddingProvider({
			apiKey: sfApiKey,
		});
		const chromaClient = createChromaClient();
		const llmProvider = createLLMProvider(providerName, llmModel);
		const classifierProvider = createSiliconFlowLLMProvider({
			apiKey: sfApiKey,
			model: classifierModel,
		});

		// ── Classify ─────────────────────────────────────────────────────
		setPhase("classifying");
		setPhaseDetail("Determining query type...");

		const startTime = Date.now();

		try {
			const searchResult = await runSearch(question, {
				driver,
				chromaClient,
				embeddingProvider,
				llmProvider,
				classifierProvider,
				topK: options.topK,
				budget,
			});

			setDurationMs(Date.now() - startTime);
			setResult(searchResult);
			setPhase("done");
		} finally {
			await driver.close();
		}

		if (!options.onComplete) exit();
	}

	const summaryRows: Array<{ label: string; value: string | number }> = result
		? [
				{ label: "Query", value: question },
				{
					label: "Kind",
					value:
						result.kind === "hybrid"
							? `hybrid (${result.result.anchors.length} anchors)`
							: result.kind,
				},
				...(result.kind === "hybrid"
					? [
							{ label: "Model", value: result.result.model },
							{
								label: "Input tokens",
								value: result.result.usage.inputTokens,
							},
							{
								label: "Output tokens",
								value: result.result.usage.outputTokens,
							},
						]
					: []),
				{ label: "Duration", value: `${durationMs}ms` },
			]
		: [];

	return (
		<Layout showHeader={false} command="query" showTokenTicker={true}>
			<Box flexDirection="column" paddingY={1}>
				{/* Phase spinners */}
				{phase === "connecting" && (
					<Spinner label="Connecting to services..." />
				)}
				{phase === "classifying" && <Spinner label="Classifying query..." />}
				{phase === "searching" && <Spinner label="Searching vectors..." />}
				{phase === "expanding" && (
					<Spinner label="Expanding graph context..." />
				)}
				{phase === "synthesizing" && <Spinner label="Generating answer..." />}

				{phaseDetail !== "" && phase !== "done" && phase !== "error" && (
					<Box paddingLeft={4}>
						<Text dimColor>{phaseDetail}</Text>
					</Box>
				)}

				{/* Error */}
				{phase === "error" && error && (
					<Box marginTop={1}>
						<Text color="red">Error: {error}</Text>
					</Box>
				)}

				{/* Results */}
				{phase === "done" && result && (
					<>
						{result.kind === "structural" && (
							<StructuralResult result={result.result} />
						)}
						{result.kind === "hybrid" && (
							<HybridResult result={result.result} />
						)}
						{result.kind === "social" && (
							<SocialResult result={result.result} />
						)}
						{result.kind === "path" && (
							<Box marginTop={1}>
								<Text color="yellow">
									Path search not yet supported in CLI.
								</Text>
							</Box>
						)}

						<SummaryTable title="Run summary" rows={summaryRows} />

						{options.onComplete && (
							<PostRunOptions
								onComplete={(action) => {
									exit();
									options.onComplete!(action);
								}}
							/>
						)}
						{!options.onComplete && (
							<Box marginTop={1}>
								<Text dimColor>Done.</Text>
							</Box>
						)}
					</>
				)}

				{phase !== "done" && phase !== "error" && (
					<Box marginTop={1}>
						<Text dimColor>^C to abort</Text>
					</Box>
				)}
			</Box>
		</Layout>
	);
}

// ─── Entry point called by Commander ─────────────────────────────────────────

export function runQuery(question: string, options: QueryOptions) {
	if (!NEO4J_PASSWORD) {
		console.error("NEO4J_PASSWORD is not set. Add it to your .env file.");
		process.exit(1);
	}
	render(<QueryUI question={question} options={options} />);
}
