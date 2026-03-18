/**
 * init — interactive command picker with inline configuration.
 *
 * Three-stage flow:
 *   1. PICK    — arrow-key navigation over command list
 *   2. CONFIG  — path input + boolean option toggles for the chosen command
 *   3. RUN     — hands off to the real command implementation
 */

import { useState } from "react";
import fs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { Box, Text, render, useApp, useInput } from "ink";
import { Layout } from "../ui/Layout.js";
import { runIngest } from "./ingest.js";
import { runAnalyze, runMine, runEmbed, runServe } from "./stubs.js";

// ─── Path input with tab completion ───────────────────────────────────────────

function getCompletions(partial: string): string[] {
	const expanded = partial.replace(/^~/, os.homedir());
	const trailingSlash = partial.endsWith("/");
	const dir = trailingSlash ? expanded : nodePath.dirname(expanded) || ".";
	const base = trailingSlash ? "" : nodePath.basename(expanded);
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.name.startsWith(base))
			.map((e) => {
				const rel = nodePath.join(
					trailingSlash ? partial : nodePath.dirname(partial) || ".",
					e.name,
				);
				return e.isDirectory() ? rel + "/" : rel;
			});
	} catch {
		return [];
	}
}

function commonPrefix(strs: string[]): string {
	if (!strs.length) return "";
	return strs.reduce((acc, s) => {
		let i = 0;
		while (i < acc.length && s[i] === acc[i]) i++;
		return acc.slice(0, i);
	});
}

interface PathInputProps {
	value: string;
	onChange: (v: string) => void;
	onSubmit: () => void;
}

function PathInput({ value, onChange, onSubmit }: PathInputProps) {
	const [completions, setCompletions] = useState<string[]>([]);

	useInput((input, key) => {
		if (key.return) {
			setCompletions([]);
			onSubmit();
			return;
		}

		if (key.tab) {
			const fullMatches = getCompletions(value).filter(
				// filter out hidden files, only works if user types out the entire name of the hidden file
				(m) => !m.replace(/\/$/, "").split("/").at(-1)!.startsWith("."),
			);
			const displayMatches = fullMatches.map((m) => {
				const isDir = m.endsWith("/");
				const name = m.replace(/\/$/, "").split("/").at(-1)!;
				return isDir ? name + "/" : name;
			});
			if (fullMatches.length === 1) {
				onChange(fullMatches[0]!);
				setCompletions([]);
			} else if (fullMatches.length > 1) {
				const prefix = commonPrefix(fullMatches);
				if (prefix.length > value.length) onChange(prefix);
				setCompletions(displayMatches);
			}
			return;
		}

		if (key.backspace || key.delete) {
			onChange(value.slice(0, -1));
			setCompletions([]);
			return;
		}

		if (input && !key.ctrl && !key.meta) {
			onChange(value + input);
			setCompletions([]);
		}
	});

	return (
		<Box flexDirection="column">
			<Box>
				<Text color="white">{value}</Text>
				<Text backgroundColor="white" color="black">
					{" "}
				</Text>
			</Box>
			{completions.length > 1 && (
				<Box flexDirection="row" marginTop={1} paddingLeft={2}>
					{completions.slice(0, 8).map((c, i) => (
						<Text key={i} color="cyan">
							{c}
							{"  "}
						</Text>
					))}
					{completions.length > 8 && (
						<Text dimColor>…and {completions.length - 8} more</Text>
					)}
				</Box>
			)}
		</Box>
	);
}

// ─── Command registry ─────────────────────────────────────────────────────────

interface OptionDef {
	key: string; // e.g. "clean"
	flag: string; // e.g. "--clean"
	description: string;
	default: boolean;
	available?: boolean; // defaults to true if omitted
}

interface CommandDef {
	name: string;
	description: string;
	detail: string;
	phase: string;
	available: boolean;
	needsPath: boolean; // whether to prompt for a <path> argument
	options: OptionDef[];
}

const COMMANDS: CommandDef[] = [
	{
		name: "analyze",
		description: "Full pipeline",
		detail: "Runs ingest → mine → embed → serve in sequence.",
		phase: "Phase 5",
		available: false,
		needsPath: true,
		options: [
			{
				key: "clean",
				flag: "--clean",
				description: "Wipe graph before running",
				default: false,
			},
		],
	},
	{
		name: "ingest",
		description: "Structural analysis",
		detail:
			"Parses source files with Tree-sitter and populates the Neo4j graph.",
		phase: "Phase 1",
		available: true,
		needsPath: true,
		options: [
			{
				key: "clean",
				flag: "--clean",
				description: "Wipe graph before ingesting",
				default: false,
				available: true,
			},
			{
				key: "analyze-only",
				flag: "--analyze-only",
				description: "Skip ingest and embed, run only the Analyze phase",
				default: false,
				available: false,
			},
		],
	},
	{
		name: "embed",
		description: "Semantic indexing",
		detail:
			"Generates vector embeddings for all graph entities and indexes them in ChromaDB.",
		phase: "Phase 2",
		available: false,
		needsPath: false,
		options: [],
	},
	{
		name: "mine",
		description: "Developer intelligence",
		detail:
			"Extracts git history, computes Degree of Authorship, and creates Developer nodes.",
		phase: "Phase 3",
		available: false,
		needsPath: false,
		options: [],
	},
	{
		name: "serve",
		description: "Launch web UI",
		detail:
			"Starts the CODEX frontend on localhost (requires prior ingest + embed).",
		phase: "Phase 4",
		available: false,
		needsPath: false,
		options: [],
	},
];

// ─── Stage 1: Command picker ──────────────────────────────────────────────────

interface PickerProps {
	onSelect: (cmd: CommandDef) => void;
	onExit: () => void;
}

function CommandPicker({ onSelect, onExit }: PickerProps) {
	const firstAvailable = COMMANDS.findIndex((c) => c.available);
	const [sel, setSel] = useState(firstAvailable >= 0 ? firstAvailable : 0);
	const active = COMMANDS[sel]!;

	function stepSel(from: number, dir: 1 | -1): number {
		let i = (from + dir + COMMANDS.length) % COMMANDS.length;
		let attempts = 0;
		while (!COMMANDS[i]!.available && attempts < COMMANDS.length) {
			i = (i + dir + COMMANDS.length) % COMMANDS.length;
			attempts++;
		}
		return i;
	}

	useInput((_, key) => {
		if (key.upArrow) setSel((s) => stepSel(s, -1));
		if (key.downArrow) setSel((s) => stepSel(s, 1));
		if (key.return) onSelect(active);
		if (key.escape) onExit();
	});

	return (
		<Box flexDirection="column" gap={1}>
			<Box flexDirection="column">
				{COMMANDS.map((cmd, i) => {
					const isSel = i === sel;
					return (
						<Box key={cmd.name} gap={2} paddingX={1}>
							<Text color={isSel ? "cyan" : "gray"}>{isSel ? "❯" : " "}</Text>
							<Box width={12}>
								<Text
									bold={isSel}
									color={!cmd.available ? "gray" : isSel ? "cyan" : "white"}
								>
									{cmd.name}
								</Text>
							</Box>
							<Box width={24}>
								<Text color={isSel ? "white" : "gray"}>{cmd.description}</Text>
							</Box>
							<Text
								color={cmd.available ? "green" : "gray"}
								dimColor={!cmd.available}
							>
								{cmd.phase}
							</Text>
							{!cmd.available && (
								<Text dimColor color="gray">
									[n/a]
								</Text>
							)}
						</Box>
					);
				})}
			</Box>

			{/* Detail panel */}
			<Box
				borderStyle="round"
				borderColor="gray"
				paddingX={2}
				paddingY={1}
				marginTop={1}
			>
				<Box flexDirection="column" gap={1}>
					<Box gap={1}>
						<Text bold color="cyan">
							codex {active.name}
						</Text>
						{active.needsPath && <Text color="gray">&lt;path&gt;</Text>}
						{!active.available && (
							<Text color="yellow"> · not yet implemented</Text>
						)}
					</Box>
					<Text color="gray">{active.detail}</Text>
				</Box>
			</Box>

			<Box gap={3} marginTop={1}>
				<Text dimColor>↑↓ navigate</Text>
				<Text dimColor>↵ select</Text>
				<Text dimColor>esc quit</Text>
			</Box>
		</Box>
	);
}

// ─── Stage 2: Configuration ───────────────────────────────────────────────────

type OptionValues = Record<string, boolean>;

/** Which config "row" is focused: "path" input or one of the option toggles. */
type FocusTarget = "path" | number; // number = option index

interface ConfigStageProps {
	cmd: CommandDef;
	onConfirm: (path: string, opts: OptionValues) => void;
	onBack: () => void;
}

function ConfigStage({ cmd, onConfirm, onBack }: ConfigStageProps) {
	const [path, setPath] = useState(".");
	const [opts, setOpts] = useState<OptionValues>(
		Object.fromEntries(cmd.options.map((o) => [o.key, o.default])),
	);
	const [pathError, setPathError] = useState<string | null>(null);

	// Focus order: "path" (if needed) then available option indices only
	const focusOrder: FocusTarget[] = [
		...(cmd.needsPath ? (["path"] as FocusTarget[]) : []),
		...cmd.options
			.map((_, i) => i as FocusTarget)
			.filter((i) => cmd.options[i as number]!.available !== false),
	];
	const [focusIdx, setFocusIdx] = useState(0);
	const focused = focusOrder[focusIdx] ?? (cmd.needsPath ? "path" : 0);

	function validatePath(p: string): string | null {
		const expanded = p.replace(/^~/, os.homedir());
		return fs.existsSync(expanded) ? null : "path not found";
	}

	function advanceFromPath() {
		if (cmd.needsPath) {
			const err = validatePath(path);
			if (err) {
				setPathError(err);
				return;
			}
			setPathError(null);
		}
		if (focusOrder.length > 1) setFocusIdx(1);
		else onConfirm(path, opts);
	}

	// Suppress our own arrow-key handler while typing in the text input
	const isTyping = focused === "path";

	useInput((input, key) => {
		if (key.escape) {
			onBack();
			return;
		}

		if (!isTyping) {
			if (key.upArrow) setFocusIdx((i) => Math.max(0, i - 1));
			if (key.downArrow)
				setFocusIdx((i) => Math.min(focusOrder.length - 1, i + 1));
		}

		if (input === " " && typeof focused === "number") {
			const opt = cmd.options[focused];

			if (!opt) {
				console.warn(`No option found for index ${focused}`);
				process.exit(1);
			}

			setOpts((o) => ({ ...o, [opt.key]: !o[opt.key] }));
		}

		if (key.return && !isTyping) {
			if (focusIdx === focusOrder.length - 1) {
				if (cmd.needsPath) {
					const err = validatePath(path);
					if (err) {
						setPathError(err);
						return;
					}
				}
				onConfirm(path, opts);
			} else {
				setFocusIdx((i) => i + 1);
			}
		}
	});

	return (
		<Box flexDirection="column" gap={1}>
			<Box gap={1}>
				<Text bold color="cyan">
					codex {cmd.name}
				</Text>
				<Text dimColor>— configure</Text>
			</Box>

			{/* Path input */}
			{cmd.needsPath && (
				<Box flexDirection="column">
					<Box gap={2} paddingX={1}>
						<Text color={focused === "path" ? "cyan" : "gray"}>
							{focused === "path" ? "❯" : " "}
						</Text>
						<Text color="gray" dimColor>
							path
						</Text>
						{focused === "path" ? (
							<PathInput
								value={path}
								onChange={(v) => {
									setPath(v);
									setPathError(null);
								}}
								onSubmit={advanceFromPath}
							/>
						) : (
							<Text color="white">{path}</Text>
						)}
					</Box>
					{pathError && (
						<Box paddingLeft={5}>
							<Text color="red">{pathError}</Text>
						</Box>
					)}
				</Box>
			)}

			{/* Option toggles */}
			{cmd.options.map((opt, i) => {
				const isAvailable = opt.available !== false;
				const isFocused = focused === i;
				const val = opts[opt.key] ?? false;
				return (
					<Box key={opt.key} gap={2} paddingX={1}>
						<Text color={isFocused ? "cyan" : "gray"}>
							{isFocused ? "❯" : " "}
						</Text>
						<Box width={16}>
							<Text
								color={!isAvailable ? "gray" : isFocused ? "cyan" : "gray"}
								dimColor={!isAvailable}
							>
								{opt.flag}
							</Text>
						</Box>
						<Box width={34}>
							<Text
								color={!isAvailable ? "gray" : isFocused ? "white" : "gray"}
								dimColor={!isAvailable}
							>
								{opt.description}
							</Text>
						</Box>
						{/* Toggle widget / n/a badge */}
						{isAvailable ? (
							<Box gap={1}>
								<Text color={val ? "cyan" : "gray"}>{val ? "◉" : "○"}</Text>
								<Text color={val ? "cyan" : "gray"}>{val ? "on" : "off"}</Text>
							</Box>
						) : (
							<Text dimColor color="gray">
								[n/a]
							</Text>
						)}
					</Box>
				);
			})}

			{/* Confirm row hint */}
			<Box gap={3} marginTop={1}>
				<Text dimColor>↑↓ navigate</Text>
				{isTyping ? (
					<Text dimColor>↵ next field</Text>
				) : (
					<Text dimColor>[space] toggle</Text>
				)}
				<Text dimColor>
					↵ {focusIdx === focusOrder.length - 1 ? "run" : "next"}
				</Text>
				<Text dimColor>esc back</Text>
			</Box>
		</Box>
	);
}

// ─── Root orchestrator ────────────────────────────────────────────────────────

type Stage = "pick" | "config" | "run";

function InitUI() {
	const { exit } = useApp();
	const [stage, setStage] = useState<Stage>("pick");
	const [chosenCmd, setChosenCmd] = useState<CommandDef | null>(null);

	function handleSelect(cmd: CommandDef) {
		if (!cmd.available) {
			// Jump straight to config to show the "not implemented" stub
			setChosenCmd(cmd);
			setStage("config");
			return;
		}
		setChosenCmd(cmd);
		setStage("config");
	}

	function handleConfirm(targetPath: string, opts: OptionValues) {
		if (!chosenCmd) return;
		setStage("run");

		// Small tick so Ink flushes the stage change before the command
		// takes over the render tree
		setTimeout(() => {
			switch (chosenCmd.name) {
				case "ingest":
					runIngest(targetPath, { clean: !!opts["clean"] });
					break;
				case "analyze":
					runAnalyze(targetPath);
					break;
				case "mine":
					runMine();
					break;
				case "embed":
					runEmbed();
					break;
				case "serve":
					runServe();
					break;
				default:
					exit();
			}
		}, 50);
	}

	return (
		<Layout showTokenTicker={false}>
			{stage === "pick" && (
				<CommandPicker onSelect={handleSelect} onExit={() => process.exit(0)} />
			)}
			{stage === "config" && chosenCmd && (
				<ConfigStage
					cmd={chosenCmd}
					onConfirm={handleConfirm}
					onBack={() => setStage("pick")}
				/>
			)}
			{stage === "run" && (
				<Box paddingY={1}>
					<Text color="cyan">⟳ launching…</Text>
				</Box>
			)}
		</Layout>
	);
}

export function runInit() {
	render(<InitUI />);
}
