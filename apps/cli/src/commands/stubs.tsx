/**
 * Skeleton implementations for commands that will be fleshed out
 * in later phases. Each renders a short "not yet implemented" notice
 * so the CLI is already navigable end-to-end.
 *
 * analyze  — Phase 5  (orchestrates ingest + mine + embed + serve)
 * mine     — Phase 3  (Git mining / DOA)
 * embed    — Phase 2  (vector embedding)
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

export function runMine() {
	render(
		<StubUI
			command="mine"
			phase="Phase 3 (Week 9)"
			description="Extracts git history, computes Degree of Authorship, and creates Developer nodes."
		/>,
	);
}

export function runEmbed() {
	render(
		<StubUI
			command="embed"
			phase="Phase 2 (Week 6)"
			description="Generates vector embeddings for all graph entities and indexes them in ChromaDB."
		/>,
	);
}

export function runServe() {
	render(
		<StubUI
			command="serve"
			phase="Phase 4 (Week 11)"
			description="Launches the CODEX web UI on localhost."
		/>,
	);
}
