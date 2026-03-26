/**
 * @fileoverview Controls overlay for the force-directed subgraph explorer.
 *
 * Same styling pattern as hebControls.tsx — absolute top-right overlay panel.
 * Receives fgRef for programmatic zoom/center actions.
 */

import type { ForceGraphMethods } from "react-force-graph-2d";
import { useForceStore } from "@/stores/forceStore";
import type { SizingMetric } from "@/types/api";
import { cn } from "@/lib/utils";

interface ForceControlsProps {
	fgRef: React.MutableRefObject<ForceGraphMethods | undefined>;
}

const SIZING_METRICS: { value: SizingMetric; label: string }[] = [
	{ value: "loc", label: "LOC" },
	{ value: "doa", label: "DOA" },
	{ value: "churn", label: "Churn" },
];

export function ForceControls({ fgRef }: ForceControlsProps) {
	const { sizingMetric, showDevelopers, setSizingMetric, toggleDevelopers } = useForceStore();

	return (
		<div
			className={cn(
				"absolute top-3 right-3 w-40 rounded-lg border border-[--color-border]",
				"bg-[--color-surface]/90 backdrop-blur-sm p-3",
				"text-xs flex flex-col gap-3",
			)}
		>
			{/* Size by */}
			<div>
				<p className="font-medium text-[--color-text-muted] uppercase tracking-wider mb-1.5">
					Size by
				</p>
				<div className="flex gap-1">
					{SIZING_METRICS.map((m) => (
						<button
							key={m.value}
							onClick={() => setSizingMetric(m.value)}
							className={cn(
								"flex-1 py-0.5 rounded text-[10px] transition-colors",
								sizingMetric === m.value
									? "bg-[--color-accent] text-white"
									: "text-[--color-text-muted] hover:text-[--color-text] border border-[--color-border]",
							)}
						>
							{m.label}
						</button>
					))}
				</div>
			</div>

			{/* Show developers */}
			<label className="flex items-center gap-2 cursor-pointer">
				<input
					type="checkbox"
					checked={showDevelopers}
					onChange={toggleDevelopers}
					className="hidden"
				/>
				<span
					className={cn(
						"w-3 h-3 rounded-sm border shrink-0 transition-colors",
						showDevelopers
							? "bg-[--color-accent] border-transparent"
							: "border-[--color-border] bg-transparent",
					)}
				/>
				<span className="text-[--color-text-muted]">Developers</span>
			</label>

			{/* Zoom controls */}
			<div className="flex flex-col gap-1">
				<button
					onClick={() => fgRef.current?.zoomToFit(400)}
					className="py-0.5 px-1 rounded text-[10px] text-[--color-text-muted] hover:text-[--color-text] border border-[--color-border] transition-colors"
				>
					Zoom to Fit
				</button>
				<button
					onClick={() => fgRef.current?.centerAt(0, 0, 400)}
					className="py-0.5 px-1 rounded text-[10px] text-[--color-text-muted] hover:text-[--color-text] border border-[--color-border] transition-colors"
				>
					Recenter
				</button>
			</div>
		</div>
	);
}
