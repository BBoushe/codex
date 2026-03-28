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
import { runAnalyze } from "./analyze.js";
import { runUi } from "./ui.js";
import { runMine } from "./mine.js";
import { runEmbed } from "./embed.js";
import { runQuery } from "./query.js";
import type { PostRunAction } from "../ui/PostRunOptions.js";
import { loadConfig, saveConfig, configFilePath } from "../config.js";

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
	default: boolean | string;
	available?: boolean; // defaults to true if omitted
	choices?: string[]; // if present, renders as a string picker instead of boolean toggle
}

interface CommandDef {
	name: string;
	description: string;
	detail: string;
	phase: string;
	available: boolean;
	needsPath: boolean; // whether to prompt for a <path> argument
	pathIsText?: boolean; // if true, skip filesystem validation on the path input
	pathLabel?: string; // display label for the path input (default: "path")
	options: OptionDef[];
}

const COMMANDS: CommandDef[] = [
	{
		name: "analyze",
		description: "Full pipeline",
		detail: "Runs ingest → mine → embed in sequence. Optionally launches the web UI.",
		phase: "All    ",
		available: true,
		needsPath: true,
		options: [
			{
				key: "clean",
				flag: "--clean",
				description: "Wipe graph + embeddings before running",
				default: false,
				available: true,
			},
			{
				key: "skipMine",
				flag: "--skip-mine",
				description: "Skip git mining phase",
				default: false,
				available: true,
			},
			{
				key: "serve",
				flag: "--serve",
				description: "Launch web UI after pipeline",
				default: false,
				available: true,
			},
			{
				key: "provider",
				flag: "--provider",
				description: "Embedding provider",
				default: "siliconflow",
				available: true,
				choices: ["siliconflow", "openai"],
			},
			{
				key: "model",
				flag: "--model",
				description: "Embedding model override",
				default: process.env["EMBEDDING_MODEL"] ?? "",
				available: true,
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
		available: true,
		needsPath: false,
		options: [
			{
				key: "clean",
				flag: "--clean",
				description: "Wipe existing embeddings before re-embedding",
				default: false,
				available: true,
			},
			{
				key: "provider",
				flag: "--provider",
				description: "Embedding provider",
				default: "siliconflow",
				available: true,
				choices: ["siliconflow", "openai"],
			},
			{
				key: "model",
				flag: "--model",
				description: "Embedding model",
				default: process.env["EMBEDDING_MODEL"] ?? "",
				available: true,
			},
		],
	},
	{
		name: "query",
		description: "Ask the codebase",
		detail:
			"Hybrid RAG search: classifies intent, runs vector + graph + LLM synthesis.",
		phase: "Phase 2",
		available: true,
		needsPath: true,
		pathIsText: true,
		pathLabel: "question",
		options: [
			{
				key: "budget",
				flag: "--budget",
				description: "Context budget",
				default: "standard",
				available: true,
				choices: ["compact", "standard", "full"],
			},
			{
				key: "provider",
				flag: "--provider",
				description: "LLM provider",
				default: "siliconflow",
				available: true,
				choices: ["siliconflow", "openai", "anthropic", "gemini"],
			},
			{
				key: "model",
				flag: "--model",
				description: "Synthesis model",
				default: process.env["LLM_MODEL"] ?? "Qwen/Qwen3-Coder-30B-A3B-Instruct",
				available: true,
			},
			{
				key: "classifierModel",
				flag: "--classifier",
				description: "Classifier model",
				default: process.env["CLASSIFIER_MODEL"] ?? "Qwen/Qwen3-14B",
				available: true,
			},
		],
	},
	{
		name: "mine",
		description: "Developer intelligence",
		detail:
			"Extracts git history, computes Degree of Authorship, and creates Developer nodes.",
		phase: "Phase 3",
		available: true,
		needsPath: true,
		options: [
			{
				key: "since",
				flag: "--since",
				description: "Only commits after this date (ISO 8601)",
				default: "",
				available: true,
			},
			{
				key: "clean",
				flag: "--clean",
				description: "Wipe existing Developer nodes before mining",
				default: false,
				available: true,
			},
		],
	},
	{
		name: "serve",
		description: "Launch web UI",
		detail:
			"Starts the CODEX backend + frontend on localhost and opens the browser.",
		phase: "Phase 4",
		available: true,
		needsPath: false,
		options: [],
	},
	{
		name: "settings",
		description: "Configure defaults",
		detail: `Edit default project path and other CLI settings stored in ${configFilePath}`,
		phase: "Config ",
		available: true,
		needsPath: true,
		pathLabel: "project path",
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
						{active.needsPath && (
							<Text color="gray">&lt;{active.pathLabel ?? "path"}&gt;</Text>
						)}
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

type OptionValues = Record<string, boolean | string>;

/** Which config "row" is focused: "path" input or one of the option toggles. */
type FocusTarget = "path" | number; // number = option index

interface ConfigStageProps {
	cmd: CommandDef;
	onConfirm: (path: string, opts: OptionValues) => void;
	onBack: () => void;
}

/** Cycles to the next value in a choices array. */
function cycleChoice(choices: string[], current: string, dir: 1 | -1): string {
	const idx = choices.indexOf(current);
	const next = (idx + dir + choices.length) % choices.length;
	return choices[next]!;
}

function ConfigStage({ cmd, onConfirm, onBack }: ConfigStageProps) {
	const savedPath = loadConfig().projectPath ?? "";
	const [path, setPath] = useState(
		cmd.pathIsText ? "" : savedPath || ".",
	);
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
		if (cmd.pathIsText) return null; // free-text input, skip filesystem check
		const expanded = p.replace(/^~/, os.homedir());
		return fs.existsSync(expanded) ? null : "path not found";
	}

	// When the only field is path (no options), require an explicit confirm step
	const [readyToRun, setReadyToRun] = useState(false);

	function advanceFromPath() {
		if (cmd.needsPath) {
			const err = validatePath(path);
			if (err) {
				setPathError(err);
				return;
			}
			setPathError(null);
		}
		if (focusOrder.length > 1) {
			setFocusIdx(1);
		} else {
			// Only field was path — show confirm prompt instead of running immediately
			setReadyToRun(true);
		}
	}

	/** True when the focused field is a free-text input (path or string option). */
	const isTextOption =
		typeof focused === "number" &&
		typeof cmd.options[focused]?.default === "string" &&
		!cmd.options[focused]?.choices;

	// Suppress arrow-key navigation while typing in any text input
	const isTyping = (focused === "path" || isTextOption) && !readyToRun;

	useInput((input, key) => {
		if (key.escape) {
			onBack();
			return;
		}

		// Backspace goes back to previous field when not typing,
		// or when a text option is already empty (nothing to delete).
		const textOptEmpty =
			isTextOption &&
			typeof focused === "number" &&
			String(opts[cmd.options[focused]!.key] ?? "") === "";
		if (key.backspace && (!isTyping || textOptEmpty)) {
			if (readyToRun) {
				setReadyToRun(false);
				return;
			}
			if (focusIdx > 0) {
				setFocusIdx((i) => i - 1);
				return;
			}
		}

		if (!isTyping) {
			if (key.upArrow) setFocusIdx((i) => Math.max(0, i - 1));
			if (key.downArrow)
				setFocusIdx((i) => Math.min(focusOrder.length - 1, i + 1));
		}

		if (typeof focused === "number") {
			const opt = cmd.options[focused];

			if (!opt) {
				console.warn(`No option found for index ${focused}`);
				process.exit(1);
			}

			if (opt.choices) {
				// String picker: left/right arrows cycle through choices
				if (key.leftArrow) {
					setOpts((o) => ({
						...o,
						[opt.key]: cycleChoice(
							opt.choices!,
							String(o[opt.key] ?? opt.default),
							-1,
						),
					}));
				}
				if (key.rightArrow) {
					setOpts((o) => ({
						...o,
						[opt.key]: cycleChoice(
							opt.choices!,
							String(o[opt.key] ?? opt.default),
							1,
						),
					}));
				}
			} else if (typeof opt.default === "string") {
				// Free-text string input: type characters, backspace to delete
				if (key.backspace || key.delete) {
					setOpts((o) => ({
						...o,
						[opt.key]: String(o[opt.key] ?? "").slice(0, -1),
					}));
				} else if (input && !key.ctrl && !key.meta && !key.return) {
					setOpts((o) => ({
						...o,
						[opt.key]: String(o[opt.key] ?? "") + input,
					}));
				}
			} else if (input === " ") {
				// Boolean toggle: space bar
				setOpts((o) => ({ ...o, [opt.key]: !o[opt.key] }));
			}
		}

		if (key.return && (!isTyping || isTextOption)) {
			if (readyToRun) {
				onConfirm(path, opts);
				return;
			}
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
							{cmd.pathLabel ?? "path"}
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
						{/* Toggle / picker / text input / n/a badge */}
						{isAvailable ? (
							opt.choices ? (
								<Box gap={1}>
									<Text color={isFocused ? "cyan" : "gray"}>{"‹"}</Text>
									<Text color={isFocused ? "cyan" : "white"}>
										{String(val)}
									</Text>
									<Text color={isFocused ? "cyan" : "gray"}>{"›"}</Text>
								</Box>
							) : typeof opt.default === "string" ? (
								// Free-text string input
								<Box gap={0}>
									<Text color={isFocused ? "white" : "gray"}>
										{String(val) || (isFocused ? "" : "(empty)")}
									</Text>
									{isFocused && (
										<Text backgroundColor="white" color="black">{" "}</Text>
									)}
								</Box>
							) : (
								<Box gap={1}>
									<Text color={val ? "cyan" : "gray"}>{val ? "◉" : "○"}</Text>
									<Text color={val ? "cyan" : "gray"}>
										{val ? "on" : "off"}
									</Text>
								</Box>
							)
						) : (
							<Text dimColor color="gray">
								[n/a]
							</Text>
						)}
					</Box>
				);
			})}

			{/* Ready-to-run confirmation */}
			{readyToRun && (
				<Box paddingX={1} marginTop={1}>
					<Text color="green" bold>
						Press ↵ to run · esc main menu · ⌫ edit
					</Text>
				</Box>
			)}

			{/* Keyboard hints — always visible */}
			{!readyToRun && (
				<Box gap={3} marginTop={1}>
					<Text dimColor>esc main menu</Text>
					{focusIdx > 0 && <Text dimColor>⌫ previous</Text>}
					<Text dimColor>↑↓ navigate</Text>
					{isTyping ? (
						<Text dimColor>↵ next</Text>
					) : typeof focused === "number" && cmd.options[focused]?.choices ? (
						<Text dimColor>‹› cycle</Text>
					) : typeof focused === "number" ? (
						<Text dimColor>[space] toggle</Text>
					) : null}
					<Text dimColor>
						↵ {focusIdx === focusOrder.length - 1 ? "run" : "next"}
					</Text>
				</Box>
			)}
		</Box>
	);
}

// ─── Phase progression ────────────────────────────────────────────────────────

/** Maps each command to the next command in the pipeline, and its display label. */
const PHASE_NEXT: Record<string, { name: string; label: string } | undefined> =
	{
		ingest: { name: "embed", label: "embed — Semantic indexing" },
		embed: { name: "mine", label: "mine — Developer intelligence" },
		mine: { name: "serve", label: "serve — Launch web UI" },
	};

// ─── Root orchestrator ────────────────────────────────────────────────────────

type Stage = "pick" | "config" | "run";

interface InitUIProps {
	/** Skip the picker and jump straight to the config stage for this command. */
	initialCmd?: CommandDef;
}

function InitUI({ initialCmd }: InitUIProps = {}) {
	const { exit } = useApp();
	const [stage, setStage] = useState<Stage>(initialCmd ? "config" : "pick");
	const [chosenCmd, setChosenCmd] = useState<CommandDef | null>(
		initialCmd ?? null,
	);

	function handleSelect(cmd: CommandDef) {
		if (!cmd.available) {
			// Jump straight to config to show the "not implemented" stub
			setChosenCmd(cmd);
			setStage("config");
			return;
		}
		setChosenCmd(cmd);
		// Skip config entirely for commands with nothing to configure
		const hasOptions = cmd.options?.some((o) => o.available !== false);
		if (!cmd.needsPath && !hasOptions) {
			setStage("run");
			setTimeout(() => launchCommand(cmd.name, "", {}), 50);
			return;
		}
		setStage("config");
	}

	function launchCommand(name: string, targetPath: string, opts: OptionValues) {
		// Persist project path for commands that take a filesystem path
		const cmd = COMMANDS.find((c) => c.name === name);
		if (cmd?.needsPath && !cmd.pathIsText && targetPath && targetPath !== ".") {
			saveConfig({ projectPath: nodePath.resolve(targetPath) });
		}

		const next = PHASE_NEXT[name];

		const onComplete = (action: PostRunAction) => {
			if (action === "next" && next) {
				// Go to the ConfigStage for the next command so the user can review
				// options before running it
				const nextCmd = COMMANDS.find((c) => c.name === next.name);
				render(<InitUI initialCmd={nextCmd} />);
			} else if (action === "repeat") {
				// Re-run the same command (e.g. ask another question)
				const sameCmd = COMMANDS.find((c) => c.name === name);
				if (sameCmd) render(<InitUI initialCmd={sameCmd} />);
				else render(<InitUI />);
			} else {
				// Return to the command picker
				render(<InitUI />);
			}
		};

		switch (name) {
			case "ingest":
				runIngest(targetPath, {
					clean: !!opts["clean"],
					onComplete,
					nextPhaseLabel: next?.label,
				});
				break;
			case "embed":
				runEmbed({
					clean: !!opts["clean"],
					provider: String(opts["provider"] ?? "siliconflow"),
					model: opts["model"] ? String(opts["model"]) : undefined,
					onComplete,
					nextPhaseLabel: next?.label,
				});
				break;
			case "query":
				runQuery(targetPath, {
					budget: String(opts["budget"] ?? "standard") as
						| "compact"
						| "standard"
						| "full",
					provider: String(opts["provider"] ?? "siliconflow"),
					model: opts["model"] ? String(opts["model"]) : undefined,
					classifierModel: opts["classifierModel"] ? String(opts["classifierModel"]) : undefined,
					onComplete,
					nextPhaseLabel: next?.label,
				});
				break;
			case "analyze":
				runAnalyze(targetPath, {
					clean: !!opts["clean"],
					skipMine: !!opts["skipMine"],
					serve: !!opts["serve"],
					provider: String(opts["provider"] ?? "siliconflow"),
					model: opts["model"] ? String(opts["model"]) : undefined,
					onComplete,
				});
				break;
			case "mine":
				runMine(targetPath, {
					since: opts["since"] ? String(opts["since"]) : undefined,
					onComplete,
					nextPhaseLabel: next?.label,
				});
				break;
			case "serve":
				runUi();
				break;
			case "settings": {
				const absPath = nodePath.resolve(targetPath.replace(/^~/, os.homedir()));
				saveConfig({ projectPath: absPath });
				render(
					<Box flexDirection="column" padding={1}>
						<Text color="green">✓ Default project path saved:</Text>
						<Text dimColor>  {absPath}</Text>
						<Text dimColor>  Config: {configFilePath}</Text>
					</Box>,
				);
				break;
			}
			default:
				exit();
		}
	}

	function handleConfirm(targetPath: string, opts: OptionValues) {
		if (!chosenCmd) return;
		setStage("run");

		// Small tick so Ink flushes the stage change before the command
		// takes over the render tree
		setTimeout(() => launchCommand(chosenCmd.name, targetPath, opts), 50);
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
