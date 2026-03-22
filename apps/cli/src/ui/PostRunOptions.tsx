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

export type PostRunAction = "next" | "main";

interface PostRunOptionsProps {
	/** Display label for the next phase option, e.g. "embed — Semantic indexing". */
	nextPhaseLabel?: string;
	onComplete: (action: PostRunAction) => void;
}

export function PostRunOptions({
	nextPhaseLabel,
	onComplete,
}: PostRunOptionsProps) {
	// 0 = next phase (default), 1 = main menu
	// If no next phase, only option 1 exists, start there
	const hasNext = !!nextPhaseLabel;
	const [sel, setSel] = useState<0 | 1>(hasNext ? 0 : 1);

	useInput((_, key) => {
		if (key.upArrow || key.leftArrow) setSel(hasNext ? 0 : 1);
		if (key.downArrow || key.rightArrow) setSel(1);

		if (key.return) {
			if (sel === 0 && hasNext) onComplete("next");
			else onComplete("main");
		}
	});

	return (
		<Box flexDirection="column" marginTop={1} gap={1}>
			<Box gap={2} paddingX={1}>
				{hasNext && (
					<Box flexDirection="column" gap={0}>
						<Box gap={2}>
							<Text color={sel === 0 ? "green" : "gray"}>
								{sel === 0 ? "❯" : " "}
							</Text>
							<Text bold={sel === 0} color={sel === 0 ? "green" : "gray"}>
								→ Continue to{" "}
								<Text bold color={sel === 0 ? "green" : "gray"}>
									{nextPhaseLabel}
								</Text>
							</Text>
						</Box>
					</Box>
				)}
			</Box>
			<Box gap={2} paddingX={1}>
				<Text color={sel === 1 ? "cyan" : "gray"}>{sel === 1 ? "❯" : " "}</Text>
				<Text bold={sel === 1} color={sel === 1 ? "cyan" : "gray"}>
					← Return to main menu
				</Text>
			</Box>
			<Box gap={3} marginTop={1} paddingX={1}>
				<Text dimColor>↑↓ navigate</Text>
				<Text dimColor>↵ confirm</Text>
			</Box>
		</Box>
	);
}
