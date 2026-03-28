/**
 * Skeleton implementations for commands that will be fleshed out
 * in later phases. Each renders a short "not yet implemented" notice
 * so the CLI is already navigable end-to-end.
 *
 * analyze  — Phase 5  (orchestrates ingest + mine + embed + serve)
 * mine     — Phase 3  (Git mining / DOA)
 * embed    — Phase 2  (vector embedding) — IMPLEMENTED in embed.tsx
 * serve    — Phase 4  (launch web UI)
 */
import { Box, Text, render } from "ink";
import { Layout } from "../ui/Layout.js";

interface StubProps {
	command: string;
	phase: string;
	description: string;
}

function StubUI({ command, phase, description }: StubProps) {
	return (
		<Layout showHeader={false} command={command}>
			<Box flexDirection="column" paddingY={1}>
				<Box gap={1}>
					<Text color="yellow">⚠</Text>
					<Text>
						Not yet implemented — scheduled for <Text bold>{phase}</Text>.
					</Text>
				</Box>
				<Box marginTop={1}>
					<Text dimColor>{description}</Text>
				</Box>
			</Box>
		</Layout>
	);
}

export function runAnalyze(_targetPath: string) {
	render(
		<StubUI
			command="analyze"
			phase="Phase 5"
			description="Orchestrates the full pipeline: ingest → mine → embed → serve."
		/>,
	);
}


