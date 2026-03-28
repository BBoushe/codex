/**
 * @fileoverview Right side panel with Entity and Browser tabs.
 *
 * Results have moved to the left ChatPanel. This panel handles:
 *   - Entity: full entity detail view
 *   - Browser: file tree navigation
 */

import { Code, FolderTree } from "lucide-react";
import { useUiStore, type SidePanelMode } from "@/stores/uiStore";
import { useEntityStore } from "@/stores/entityStore";
import { EntityDetail } from "@/components/entity/entityDetail";
import { FileBrowser } from "@/components/browser/fileBrowser";
import { cn } from "@/lib/utils";

interface Tab {
	mode: SidePanelMode;
	icon: React.ReactNode;
	label: string;
}

const TABS: Tab[] = [
	{ mode: "entity", icon: <Code size={14} />, label: "Entity" },
	{ mode: "browser", icon: <FolderTree size={14} />, label: "Browser" },
];

export function SidePanel() {
	const { sidePanelMode, setSidePanelMode } = useUiStore();
	const hasEntity = useEntityStore((s) => s.selectedNodeId !== null);

	return (
		<aside className="flex flex-col h-full min-h-0 border-l border-[--color-border] bg-[--color-surface]">
			{/* Tabs */}
			<div className="flex items-center border-b border-[--color-border] px-2">
				{TABS.map((tab) => {
					const showDot = tab.mode === "entity" && hasEntity;
					return (
						<button
							key={tab.mode}
							onClick={() => setSidePanelMode(tab.mode)}
							className={cn(
								"relative flex flex-1 justify-center items-center gap-1.5 px-3 py-3 text-xs transition-colors border-b-2 focus:outline-none focus-visible:bg-[--color-surface-2]",
								sidePanelMode === tab.mode
									? "border-[--color-accent] text-[--color-accent] bg-[--color-surface]"
									: "border-transparent text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2]",
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
			<div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
				{sidePanelMode === "entity" && <EntityDetail />}
				{sidePanelMode === "browser" && <FileBrowser />}
			</div>
		</aside>
	);
}
