#!/usr/bin/env bun
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runIngest } from "./commands/ingest.js";
import { runAnalyze, runMine, runServe } from "./commands/stubs.js";
import { runEmbed } from "./commands/embed.js";

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
	.command("mine")
	.description(
		"Extract git history and compute developer expertise (requires prior ingest)",
	)
	.action(() => runMine());

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

// ─── serve ───────────────────────────────────────────────────────────────────

program
	.command("serve")
	.description(
		"Launch the CODEX web UI on localhost (requires prior ingest + embed)",
	)
	.action(() => runServe());

program.parse();
