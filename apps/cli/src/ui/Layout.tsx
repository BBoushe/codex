/**
 * Layout.tsx — persistent shell wrapping every CODEX command.
 *
 * Renders:
 *   ┌─ Header ───────────────────────────────────────────┐
 *   │  ASCII logo + figlet title                         │
 *   ├─ Body ─────────────────────────────────────────────┤
 *   │  {children}                                        │
 *   ├─ Footer ───────────────────────────────────────────┤
 *   │  token ticker (embedded / llm-in / llm-out)        │
 *   └────────────────────────────────────────────────────┘
 */

import React, { useState, useEffect, type ReactNode } from "react"; // useState/useEffect used by TokenTicker
import { Box, Text } from "ink";
// import figlet from "figlet"; // font files aren't available in compiled binary — title is pre-generated below
import { tokenStore } from "../../../../packages/shared/src/store/tokens.js";

// ─── ASCII logo (your X-with-nodes mark, navy + cyan) ────────────────────────

// Each character pair in LOGO_LINES is [char, color].
// We render column-by-column to get per-character colour without extra deps.

// The LOGO is designed to fit within the width of the Figlet title, think about it and make it.
const LOGO = [
	"◉─◉   ◉─◉",
	" ╲ ╲ ╱ ╱ ",
	"  ◉─◉─◉  ",
	"  ◉─◉─◉  ",
	" ╱ ╱ ╲ ╲ ",
	"◉─◉   ◉─◉",
];

// Columns that should be rendered in cyan; the rest in the dark navy-ish blue.
// Tweak these index ranges to match whichever characters you want highlighted.
function logoColor(char: string, col: number): string {
	if (char === " ") return "white";
	// Inner diamond (cols 2–6 in each half) and all ◉ nodes → cyan
	if (char === "◉") return "cyan";
	if (char === "─" && col >= 2 && col <= 6) return "cyan";
	if (char === "─" && col >= 14 && col <= 18) return "cyan";
	if ("╲╱│".includes(char)) return "cyan";
	return "blueBright";
}

function AsciiLogo() {
	return (
		<Box flexDirection="column" alignItems="center">
			{LOGO.map((line, row) => (
				<Box key={row}>
					{line.split("").map((ch, col) => (
						<Text key={col} color={logoColor(ch, col)}>
							{ch}
						</Text>
					))}
				</Box>
			))}
		</Box>
	);
}

// ─── Figlet title ─────────────────────────────────────────────────────────────

// Pre-generated with: figlet -f "ANSI Shadow" "CODEX"
// (figlet font files are not available inside a compiled bun binary)
const FIGLET_CODEX = `  ██████╗ ██████╗ ██████╗ ███████╗██╗  ██╗
 ██╔════╝██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝
██║     ██║   ██║██║  ██║█████╗   ╚███╔╝
██║     ██║   ██║██║  ██║██╔══╝   ██╔██╗
 ╚██████╗╚██████╔╝██████╔╝███████╗██╔╝ ██╗
  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝`;

const MIN_COLS_FOR_FIGLET = 70;

function FigletTitle() {
	const cols = process.stdout.columns;
	const isNarrow = typeof cols === "number" && cols < MIN_COLS_FOR_FIGLET;

	if (isNarrow)
		return (
			<Text bold color="cyan">
				CODEX
			</Text>
		);

	return (
		<Box flexDirection="column" alignItems="center">
			{FIGLET_CODEX.split("\n").map((line, i) => (
				<Text key={i} color={i % 2 === 0 ? "cyan" : "blueBright"}>
					{line}
				</Text>
			))}
		</Box>
	);
}

// ─── Token ticker footer ──────────────────────────────────────────────────────

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function TokenTicker() {
	const [stats, setStats] = useState(tokenStore.getState());

	useEffect(() => {
		return tokenStore.subscribe((s) => setStats({ ...s }));
	}, []);

	const sessionTotal = stats.embedded + stats.llmInput + stats.llmOutput;
	const queryTotal =
		stats.currentEmbedded + stats.currentLlmInput + stats.currentLlmOutput;

	return (
		<Box
			borderStyle="single"
			borderColor="gray"
			paddingX={1}
			gap={3}
			marginTop={1}
		>
			<Text dimColor>tokens</Text>

			{/* Per-query subtotal (only shown when a query is in progress or just finished) */}
			{queryTotal > 0 && (
				<Box gap={1}>
					<Text dimColor>query</Text>
					<Text color="yellow">{fmt(queryTotal)}</Text>
				</Box>
			)}

			<Box gap={1}>
				<Text dimColor>embed</Text>
				<Text color="cyan">{fmt(stats.embedded)}</Text>
			</Box>
			<Box gap={1}>
				<Text dimColor>llm↑</Text>
				<Text color="cyan">{fmt(stats.llmInput)}</Text>
			</Box>
			<Box gap={1}>
				<Text dimColor>llm↓</Text>
				<Text color="cyan">{fmt(stats.llmOutput)}</Text>
			</Box>
			<Box gap={1}>
				<Text dimColor>total</Text>
				<Text color={sessionTotal > 0 ? "white" : "gray"}>{fmt(sessionTotal)}</Text>
			</Box>
		</Box>
	);
}

// ─── Subtitle ─────────────────────────────────────────────────────────────────

function Subtitle() {
	return (
		<Box marginTop={1} gap={2} alignItems="center">
			<Text dimColor>────────────────</Text>
			<Text color="gray">CODEBASE COMPREHENSION TOOL</Text>
			<Text dimColor>────────────────</Text>
		</Box>
	);
}

// ─── Public Layout wrapper ────────────────────────────────────────────────────

interface LayoutProps {
	children: ReactNode;
	/** Pass false to hide the full header and show a compact banner instead. */
	showHeader?: boolean;
	/** Command name shown in the compact banner when showHeader=false. */
	command?: string;
	/** Pass false to hide the token ticker footer (e.g. for commands that don't use tokens). */
	showTokenTicker?: boolean;
}

export function Layout({
	children,
	showHeader = true,
	command,
	showTokenTicker = true,
}: LayoutProps) {
	return (
		<Box flexDirection="column" paddingX={2} paddingY={1}>
			{showHeader && (
				<Box flexDirection="column" alignItems="center" marginBottom={1}>
					<FigletTitle />
					{/* <AsciiLogo /> */}
					<Subtitle />
				</Box>
			)}

			{!showHeader && command && (
				<Box marginBottom={1} gap={1}>
					<Text bold color="cyan">
						CODEX
					</Text>
					<Text dimColor>—</Text>
					<Text color="white">{command}</Text>
				</Box>
			)}

			<Box flexDirection="column">{children}</Box>

			{showTokenTicker && <TokenTicker />}
		</Box>
	);
}
