/**
 * @fileoverview Post-run navigation prompt shown after a phase completes.
 *
 * Renders two options below the summary table:
 *   → Continue to <next phase>   (highlighted, recommended action)
 *   ← Return to main menu
 *
 * Arrow keys / enter to select. If `nextPhaseLabel` is omitted, only the
 * "return to main menu" option is shown.
 */

import { useState } from "react";
import { Box, Text, useInput } from "ink";

export type PostRunAction = "next" | "main" | "repeat";

interface PostRunOptionsProps {
	/** Display label for the next phase option, e.g. "embed — Semantic indexing". */
	nextPhaseLabel?: string;
	/** Display label for a repeat option, e.g. "Ask another question". */
	repeatLabel?: string;
	onComplete: (action: PostRunAction) => void;
}

export function PostRunOptions({
	nextPhaseLabel,
	repeatLabel,
	onComplete,
}: PostRunOptionsProps) {
	// Build ordered list of options
	type Opt = { action: PostRunAction; label: string; color: string; prefix: string };
	const options: Opt[] = [];
	if (nextPhaseLabel) options.push({ action: "next", label: `→ Continue to ${nextPhaseLabel}`, color: "green", prefix: "→" });
	if (repeatLabel) options.push({ action: "repeat", label: `↺ ${repeatLabel}`, color: "yellow", prefix: "↺" });
	options.push({ action: "main", label: "← Return to main menu", color: "cyan", prefix: "←" });

	const [sel, setSel] = useState(0);

	useInput((_, key) => {
		if (key.upArrow || key.leftArrow) setSel((s) => Math.max(0, s - 1));
		if (key.downArrow || key.rightArrow) setSel((s) => Math.min(options.length - 1, s + 1));
		if (key.return) onComplete(options[sel]!.action);
	});

	return (
		<Box flexDirection="column" marginTop={1} gap={0}>
			{options.map((opt, i) => (
				<Box key={opt.action} gap={2} paddingX={1}>
					<Text color={sel === i ? opt.color : "gray"}>{sel === i ? "❯" : " "}</Text>
					<Text bold={sel === i} color={sel === i ? opt.color : "gray"}>
						{opt.label}
					</Text>
				</Box>
			))}
			<Box gap={3} marginTop={1} paddingX={1}>
				<Text dimColor>↑↓ navigate</Text>
				<Text dimColor>↵ confirm</Text>
			</Box>
		</Box>
	);
}
