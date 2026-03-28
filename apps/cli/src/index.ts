#!/usr/bin/env bun
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runIngest } from "./commands/ingest.js";
import { runAnalyze } from "./commands/stubs.js";
import { runMine } from "./commands/mine.js";
import { runEmbed } from "./commands/embed.js";
import { runQuery } from "./commands/query.js";
import { runUi } from "./commands/ui.js";

const program = new Command();

program
	.name("codex")
	.description("Codebase Organisation and Developer EXplorer")
	.version("0.1.0")
	// Show interactive picker when no subcommand is given
	.action(() => runInit());

// ─── init (explicit) ─────────────────────────────────────────────────────────

program
	.command("init")
	.description("Interactive command picker")
	.action(() => runInit());

// ─── ingest ──────────────────────────────────────────────────────────────────

program
	.command("ingest <path>")
	.description(
		"Parse source files and populate the Neo4j graph (structural layer)",
	)
	.option("--clean", "wipe the existing graph before ingesting", false)
	.action((targetPath: string, options: { clean: boolean }) => {
		runIngest(targetPath, options);
	});

// ─── analyze ─────────────────────────────────────────────────────────────────

program
	.command("analyze <path>")
	.description("Run the full pipeline: ingest → mine → embed → serve")
	.action((targetPath: string) => runAnalyze(targetPath));

// ─── mine ────────────────────────────────────────────────────────────────────

program
	.command("mine <path>")
	.description(
		"Extract git history and compute developer expertise (requires prior ingest)",
	)
	.option("--clean", "wipe existing Developer/Commit nodes before mining", false)
	.option("--since <date>", "only process commits after this ISO date")
	.option("--max-commits <n>", "cap the number of commits processed", (v) => parseInt(v, 10))
	.action((targetPath: string, options: { clean: boolean; since?: string; maxCommits?: number }) => {
		runMine(targetPath, options);
	});

// ─── embed ───────────────────────────────────────────────────────────────────

program
	.command("embed")
	.description(
		"Generate and index vector embeddings for all graph entities (requires prior ingest)",
	)
	.option("--clean", "wipe existing embeddings before re-embedding", false)
	.option(
		"--provider <name>",
		"embedding provider (siliconflow | openai)",
		"siliconflow",
	)
	.action((options: { clean: boolean; provider: string }) =>
		runEmbed(options),
	);

// ─── ui ──────────────────────────────────────────────────────────────────────

program
	.command("ui")
	.alias("serve")
	.description(
		"Launch the CODEX web UI on localhost (starts backend + frontend dev servers)",
	)
	.action(() => runUi());

// ─── query ───────────────────────────────────────────────────────────────────

program
	.command("query <question>")
	.description(
		"Ask a natural language question about the codebase (requires prior ingest + embed)",
	)
	.option(
		"--budget <tier>",
		"context budget: compact | standard | full",
		process.env.RAG_CONTEXT_BUDGET ?? "standard",
	)
	.option(
		"--provider <name>",
		"LLM provider: siliconflow | openai | anthropic | gemini",
		process.env.LLM_PROVIDER ?? "siliconflow",
	)
	.option("--top-k <number>", "override auto-detected topK", (v) =>
		parseInt(v, 10),
	)
	.action(
		(
			question: string,
			options: { budget: string; provider: string; topK?: number },
		) => {
			runQuery(question, {
				budget: options.budget as "compact" | "standard" | "full",
				provider: options.provider,
				topK: options.topK,
			});
		},
	);

program.parse();
