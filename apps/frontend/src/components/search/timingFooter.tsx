/**
 * @fileoverview Pipeline timing summary shown below search results.
 */

import type { PipelineTimings } from "@/types/api";
import { formatMs } from "@/lib/formatters";

interface TimingFooterProps {
	timings: PipelineTimings;
}

export function TimingFooter({ timings }: TimingFooterProps) {
	const phases = [
		{ label: "classify", value: timings.classifierMs },
		{ label: "embed", value: timings.embeddingMs },
		{ label: "vector", value: timings.vectorSearchMs },
		{ label: "graph", value: timings.graphExpansionMs },
		{ label: "synth", value: timings.synthesisMs },
	].filter((p) => p.value > 0);

	return (
		<div className="px-4 py-2 border-t border-[--color-border] text-[10px] text-[--color-text-muted] flex flex-wrap gap-2">
			<span className="font-medium text-[--color-text]">
				{formatMs(timings.totalMs)}
			</span>
			{phases.map((p) => (
				<span key={p.label}>
					{p.label}: {formatMs(p.value)}
				</span>
			))}
		</div>
	);
}
