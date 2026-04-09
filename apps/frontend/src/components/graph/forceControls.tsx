/**
 * @fileoverview Controls overlay for the force-directed subgraph explorer.
 *
 * Absolute top-right overlay panel. Receives fgRef for programmatic zoom actions.
 */

import { ZoomIn, ZoomOut, Maximize2, RotateCcw } from "lucide-react";
import { type RefObject } from "react";
import type { ForceGraphMethods } from "react-force-graph-2d";
import { useForceStore } from "@/stores/forceStore";
import { useUiStore } from "@/stores/uiStore";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { SizingMetric } from "@/types/api";
import { cn } from "@/lib/utils";

interface ForceControlsProps {
	fgRef: RefObject<ForceGraphMethods | undefined>;
	/** Called when sizing metric changes so the graph can reheat. */
	onSizingChange: () => void;
}

const SIZING_METRICS: { value: SizingMetric; label: string }[] = [
	{ value: "loc", label: "LOC" },
	{ value: "doa", label: "DOA" },
	{ value: "churn", label: "Churn" },
];

function Toggle({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: () => void;
	label: string;
}) {
	return (
		<label className="flex items-center gap-2 cursor-pointer select-none group">
			<input
				type="checkbox"
				checked={checked}
				onChange={onChange}
				className="hidden"
			/>
			<span
				className={cn(
					"w-3.5 h-3.5 rounded-[3px] border shrink-0 transition-all duration-150 flex items-center justify-center",
					checked
						? "bg-[var(--color-accent)] border-[var(--color-accent)]"
						: "border-[var(--color-border)] bg-transparent group-hover:border-[var(--color-text-muted)]",
				)}
			>
				{checked && (
					<svg width="8" height="6" viewBox="0 0 8 6" fill="none">
						<path
							d="M1 3L3 5L7 1"
							stroke="white"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				)}
			</span>
			<span
				className={cn(
					"text-[11px] transition-colors",
					checked
						? "text-[var(--color-text)]"
						: "text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]",
				)}
			>
				{label}
			</span>
		</label>
	);
}

export function ForceControls({ fgRef, onSizingChange }: ForceControlsProps) {
	const {
		sizingMetric,
		showDevelopers,
		showFiles,
		groupByDirectory,
		groupByLabel,
		setSizingMetric,
		toggleDevelopers,
		toggleFiles,
		toggleGroupByDirectory,
		toggleGroupByLabel,
	} = useForceStore();

	function handleMetricChange(metric: SizingMetric) {
		setSizingMetric(metric);
		onSizingChange();
	}

	return (
		<div
			className={cn(
				"absolute z-20 top-3 right-3 w-75 rounded-lg border border-[var(--color-border)]",
				"bg-[var(--color-surface)]/95 backdrop-blur-md",
				"shadow-(--shadow-md) p-3",
				"text-xs flex flex-col gap-3",
			)}
		>
			{/* Size by */}
			<div>
				<p className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
					Size by
				</p>
				<div className="flex gap-1">
					{SIZING_METRICS.map((m) => (
						<button
							key={m.value}
							onClick={() => handleMetricChange(m.value)}
							className={cn(
								"flex-1 py-1 rounded-[3px] text-[10px] font-medium transition-all duration-150",
								sizingMetric === m.value
									? "bg-[var(--color-accent)] text-white shadow-(--shadow-xs)"
									: "text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]",
							)}
						>
							{m.label}
						</button>
					))}
				</div>
			</div>

			<Separator />

			{/* Visibility toggles */}
			<div className="flex flex-col gap-2">
				<Toggle
					checked={showDevelopers}
					onChange={toggleDevelopers}
					label="Developers"
				/>
				<Toggle checked={showFiles} onChange={toggleFiles} label="Files" />
				<Toggle
					checked={groupByDirectory}
					onChange={toggleGroupByDirectory}
					label="Group dirs"
				/>
				<Toggle
					checked={groupByLabel}
					onChange={toggleGroupByLabel}
					label="Group labels"
				/>
			</div>

			<Separator />

			{/* Zoom controls */}
			<div className="flex flex-col gap-1.5">
				<div className="flex gap-1">
					<Button
						variant="secondary"
						size="sm"
						className="flex-1 text-[10px] h-6 px-1"
						onClick={() => {
							const fg = fgRef.current;
							if (fg) {
								const z = (fg.zoom?.() as number | undefined) ?? 1;
								fg.zoom?.(z * 1.3, 200);
							}
						}}
					>
						<ZoomIn size={10} /> In
					</Button>
					<Button
						variant="secondary"
						size="sm"
						className="flex-1 text-[10px] h-6 px-1"
						onClick={() => {
							const fg = fgRef.current;
							if (fg) {
								const z = (fg.zoom?.() as number | undefined) ?? 1;
								fg.zoom?.(z / 1.3, 200);
							}
						}}
					>
						<ZoomOut size={10} /> Out
					</Button>
				</div>
				<Button
					variant="secondary"
					size="sm"
					className="w-full text-[10px] h-6 px-1"
					onClick={() => fgRef.current?.zoomToFit(400, 40)}
				>
					<Maximize2 size={10} /> Fit All
				</Button>
			</div>

			<Separator />

			{/* Reset */}
			<Button
				variant="ghost"
				size="sm"
				className="w-full text-[10px] h-6 px-1 text-red-400 hover:text-red-300"
				onClick={() => {
					useForceStore.getState().reset();
					useUiStore.getState().setMainAreaMode("placeholder");
				}}
			>
				<RotateCcw size={10} /> Reset Explorer
			</Button>
		</div>
	);
}
