/**
 * @fileoverview Main area — graph canvas container.
 *
 * Renders one of:
 *   "placeholder" — landing state with a "Load Graph" CTA
 *   "heb"         — Hierarchical Edge Bundling visualization (Week 12)
 *   "force"       — Force-directed subgraph explorer (Week 13, placeholder)
 */

import { Network, Loader2 } from "lucide-react";
import { useUiStore } from "@/stores/uiStore";
import { useGraphStore } from "@/stores/graphStore";
import { HebContainer } from "@/components/graph/hebContainer";
import { cn } from "@/lib/utils";

function GraphPlaceholder() {
	const { setMainAreaMode } = useUiStore();
	const { fetchHierarchy, isLoading, error } = useGraphStore();

	function handleLoad() {
		fetchHierarchy();
		setMainAreaMode("heb");
	}

	return (
		<div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
			<Network size={48} className="text-[--color-border]" />
			<div>
				<h2 className="text-base font-semibold text-[--color-text] mb-1">
					Codebase Graph
				</h2>
				<p className="text-sm text-[--color-text-muted]">
					Visualize the architecture of your ingested codebase as a hierarchical
					edge-bundling diagram.
				</p>
			</div>
			{error && (
				<p className="text-sm text-red-400">{error}</p>
			)}
			<button
				onClick={handleLoad}
				disabled={isLoading}
				className={cn(
					"flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium",
					"bg-[--color-accent] text-white",
					"hover:bg-[--color-accent-hover] transition-colors",
					"disabled:opacity-60 disabled:cursor-not-allowed",
				)}
			>
				{isLoading ? (
					<>
						<Loader2 size={14} className="animate-spin" /> Loading…
					</>
				) : (
					<>
						<Network size={14} /> Load Graph
					</>
				)}
			</button>
		</div>
	);
}

function ForcePlaceholder() {
	return (
		<div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
			<p className="text-sm text-[--color-text-muted]">
				Force-directed graph — coming in Week 13.
			</p>
		</div>
	);
}

export function MainArea() {
	const mainAreaMode = useUiStore((s) => s.mainAreaMode);

	return (
		<main className="relative flex-1 h-full overflow-hidden bg-[--color-background]">
			{mainAreaMode === "placeholder" && <GraphPlaceholder />}
			{mainAreaMode === "heb" && <HebContainer />}
			{mainAreaMode === "force" && <ForcePlaceholder />}
		</main>
	);
}
