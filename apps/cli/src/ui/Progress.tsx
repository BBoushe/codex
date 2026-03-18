import React from "react";
import { Box, Text } from "ink";

// ─── Spinner ──────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner() {
	const [f, setF] = React.useState(0);
	React.useEffect(() => {
		const id = setInterval(() => setF((n) => (n + 1) % FRAMES.length), 80);
		return () => clearInterval(id);
	}, []);
	return <Text color="cyan">{FRAMES[f]}</Text>;
}

// ─── Step ─────────────────────────────────────────────────────────────────────

export type StepStatus = "pending" | "running" | "done" | "failed";

interface StepProps {
	label: string;
	status: StepStatus;
	detail?: string;
}

export function Step({ label, status, detail }: StepProps) {
	const icon =
		status === "done" ? (
			<Text color="green">✔</Text>
		) : status === "failed" ? (
			<Text color="red">✘</Text>
		) : status === "running" ? (
			<Spinner />
		) : (
			<Text color="gray">○</Text>
		);

	const labelColor =
		status === "done"
			? "green"
			: status === "failed"
				? "red"
				: status === "running"
					? "white"
					: "gray";

	return (
		<Box gap={1}>
			{icon}
			<Text color={labelColor}>{label}</Text>
			{detail ? <Text dimColor>{detail}</Text> : null}
		</Box>
	);
}

// ─── ProgressBar ──────────────────────────────────────────────────────────────

interface ProgressBarProps {
	value: number; // 0–1
	width?: number;
	color?: string;
}

export function ProgressBar({
	value,
	width = 30,
	color = "cyan",
}: ProgressBarProps) {
	const filled = Math.round(Math.min(1, Math.max(0, value)) * width);
	return (
		<Box>
			<Text color={color}>{"█".repeat(filled)}</Text>
			<Text dimColor>{"░".repeat(width - filled)}</Text>
		</Box>
	);
}

// ─── SummaryTable ─────────────────────────────────────────────────────────────

interface SummaryRow {
	label: string;
	value: string | number;
}

export function SummaryTable({
	title,
	rows,
}: {
	title: string;
	rows: SummaryRow[];
}) {
	const w = Math.max(...rows.map((r) => r.label.length)) + 2;
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text bold color="cyan">
				{title}
			</Text>
			{rows.map(({ label, value }) => (
				<Box key={label} gap={1}>
					<Text dimColor>{label.padEnd(w)}</Text>
					<Text>{String(value)}</Text>
				</Box>
			))}
		</Box>
	);
}
