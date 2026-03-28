/**
 * @fileoverview Pipeline timing summary shown below search results.
 * Shows the classified intent and per-phase timing breakdown.
 */

import type { PipelineTimings, QueryIntent } from "@/types/api";
import { formatMs } from "@/lib/formatters";

function formatIntent(intent: QueryIntent): string {
	switch (intent.kind) {
		case "structural":
			return `structural → ${intent.spec.edge} (${intent.spec.direction})`;
		case "social":
			return `social → "${intent.extractedName || "…"}"`;
		case "hybrid":
			return `hybrid/${intent.subKind} K=${intent.topK}${intent.wasFallback ? " (fallback)" : ""}`;
	}
}

interface TimingFooterProps {
	timings: PipelineTimings;
	intent?: QueryIntent;
}

export function TimingFooter({ timings, intent }: TimingFooterProps) {
	const phases = [
		{ label: "classify", value: timings.classifierMs },
		{ label: "embed", value: timings.embeddingMs },
		{ label: "vector", value: timings.vectorSearchMs },
		{ label: "graph", value: timings.graphExpansionMs },
		{ label: "synth", value: timings.synthesisMs },
	].filter((p) => p.value > 0);

	return (
		<div className="px-4 py-2 border-t border-[--color-border] text-[10px] text-[--color-text-muted] flex flex-wrap gap-x-3 gap-y-1">
			<span className="font-medium text-[--color-text]">
				{formatMs(timings.totalMs)}
			</span>
			{intent && (
				<span className="text-[--color-accent]">
					{formatIntent(intent)}
				</span>
			)}
			{phases.map((p) => (
				<span key={p.label}>
					{p.label}: {formatMs(p.value)}
				</span>
			))}
		</div>
	);
}
