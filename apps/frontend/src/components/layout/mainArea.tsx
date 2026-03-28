/**
 * @fileoverview Main canvas area.
 *
 * Renders one of:
 *   "placeholder" — landing screen with 3 action cards
 *   "heb"         — Hierarchical Edge Bundling visualization
 *   "force"       — Force-directed subgraph explorer
 */

import { Network, Share2, FolderOpen } from "lucide-react";
import { useUiStore } from "@/stores/uiStore";
import { useGraphStore } from "@/stores/graphStore";
import { HebContainer } from "@/components/graph/hebContainer";
import { ForceGraph } from "@/components/graph/forceGraph";
import { SearchIsland } from "@/components/search/searchIsland";
import { cn } from "@/lib/utils";

interface ActionCard {
	icon: React.ReactNode;
	title: string;
	description: string;
	onClick: () => void;
}

function LandingScreen() {
	const { setMainAreaMode, setLeftPanelOpen, setSidePanelMode } = useUiStore();
	const fetchHierarchy = useGraphStore((s) => s.fetchHierarchy);

	const cards: ActionCard[] = [
		{
			icon: <Network size={28} className="text-[--color-accent]" />,
			title: "Search Codebase",
			description: "Ask questions about your code using natural language",
			onClick: () => setLeftPanelOpen(true),
		},
		{
			icon: <Share2 size={28} className="text-emerald-400" />,
			title: "Explore Graph",
			description: "Visualise the full architecture as a hierarchical diagram",
			onClick: () => {
				fetchHierarchy();
				setMainAreaMode("heb");
			},
		},
		{
			icon: <FolderOpen size={28} className="text-amber-400" />,
			title: "Browse Files",
			description: "Navigate the ingested file tree and inspect entities",
			onClick: () => setSidePanelMode("browser"),
		},
	];

	return (
		<div className="flex flex-col items-center justify-center w-full h-full gap-10 text-center px-8 pb-24">
			{/* Heading */}
			<div className="flex flex-col items-center gap-2">
				<div className="w-10 h-10 rounded-lg bg-[--color-accent]/15 flex items-center justify-center mb-1">
					<Network size={20} className="text-[--color-accent]" />
				</div>
				<h1 className="text-2xl font-bold text-[--color-text] tracking-tight">
					CODEX
				</h1>
				<p className="text-sm text-[--color-text-muted] max-w-sm leading-relaxed">
					Codebase intelligence — search, explore and understand any repository.
				</p>
			</div>

			{/* Action cards */}
			<div className="flex flex-col sm:flex-row gap-4 w-full max-w-2xl">
				{cards.map((card) => (
					<button
						key={card.title}
						onClick={card.onClick}
						className={cn(
							"flex-1 flex flex-col items-center gap-4 p-6 text-center",
							"rounded-lg border border-[--color-border] bg-[--color-surface]",
							"shadow-(--shadow-sm)",
							"hover:shadow-(--shadow-md) hover:border-[--color-accent]/40 hover:bg-[--color-surface-2]",
							"transition-all duration-200 cursor-pointer",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-accent]",
						)}
					>
						<div className="p-2.5 rounded-lg bg-[--color-surface-2]">
							{card.icon}
						</div>
						<div>
							<p className="text-sm font-semibold text-[--color-text] mb-1.5">
								{card.title}
							</p>
							<p className="text-xs text-[--color-text-muted] leading-relaxed">
								{card.description}
							</p>
						</div>
					</button>
				))}
			</div>

			<p className="text-xs text-[--color-text-subtle]">
				Use the search bar below or pick an option above to get started.
			</p>
		</div>
	);
}

export function MainArea() {
	const mainAreaMode = useUiStore((s) => s.mainAreaMode);

	return (
		<main className="relative w-full h-full min-h-0 overflow-hidden bg-[--color-background]">
			{mainAreaMode === "placeholder" && <LandingScreen />}
			{mainAreaMode === "heb" && <HebContainer />}
			{mainAreaMode === "force" && <ForceGraph />}

			{/* Floating search island — positioned inside the center panel */}
			<SearchIsland />
		</main>
	);
}
