/**
 * @fileoverview Right side panel with tabbed content.
 *
 * Tabs:
 *   - Results: search result display (switched automatically on search)
 *   - Entity:  full entity detail view
 *   - Browser: file tree navigation
 */

import { Search, Code, FolderTree } from "lucide-react";
import { useUiStore, type SidePanelMode } from "@/stores/uiStore";
import { useSearchStore } from "@/stores/searchStore";
import { useEntityStore } from "@/stores/entityStore";
import { SearchResults } from "@/components/search/searchResults";
import { EntityDetail } from "@/components/entity/entityDetail";
import { FileBrowser } from "@/components/browser/fileBrowser";
import { cn } from "@/lib/utils";

interface Tab {
	mode: SidePanelMode;
	icon: React.ReactNode;
	label: string;
}

const TABS: Tab[] = [
	{ mode: "results", icon: <Search size={14} />, label: "Results" },
	{ mode: "entity", icon: <Code size={14} />, label: "Entity" },
	{ mode: "browser", icon: <FolderTree size={14} />, label: "Browser" },
];

export function SidePanel() {
	const { sidePanelMode, setSidePanelMode } = useUiStore();
	const hasResults = useSearchStore((s) => s.result !== null || s.isLoading || s.error !== null);
	const hasEntity = useEntityStore((s) => s.selectedNodeId !== null);

	return (
		<aside className="flex flex-col h-full border-l border-[--color-border] bg-[--color-surface]">
			{/* Tabs */}
			<div className="flex items-center border-b border-[--color-border] px-2">
				{TABS.map((tab) => {
					const showDot =
						(tab.mode === "results" && hasResults) ||
						(tab.mode === "entity" && hasEntity);
					return (
						<button
							key={tab.mode}
							onClick={() => setSidePanelMode(tab.mode)}
							className={cn(
								"relative flex items-center gap-1.5 px-3 py-3 text-xs transition-colors border-b-2",
								sidePanelMode === tab.mode
									? "border-[--color-accent] text-[--color-text]"
									: "border-transparent text-[--color-text-muted] hover:text-[--color-text]",
							)}
						>
							{tab.icon}
							{tab.label}
							{showDot && sidePanelMode !== tab.mode && (
								<span className="absolute top-2 right-1 w-1.5 h-1.5 rounded-full bg-[--color-accent]" />
							)}
						</button>
					);
				})}
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden">
				{sidePanelMode === "results" && <SearchResults />}
				{sidePanelMode === "entity" && <EntityDetail />}
				{sidePanelMode === "browser" && <FileBrowser />}
			</div>
		</aside>
	);
}
