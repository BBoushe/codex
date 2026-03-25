/**
 * @fileoverview Top navigation bar with search and view mode toggle.
 */

import { GitBranch, Network, FolderTree } from "lucide-react";
import { SearchBar } from "@/components/search/searchBar";
import { useUiStore, type MainAreaMode } from "@/stores/uiStore";
import { useGraphStore } from "@/stores/graphStore";
import { cn } from "@/lib/utils";

interface ViewToggleProps {
	/** The mode this button activates. */
	mode: MainAreaMode;
	label: string;
	icon: React.ReactNode;
}

function ViewToggle({ mode, label, icon }: ViewToggleProps) {
	const { mainAreaMode, setMainAreaMode } = useUiStore();
	const fetchHierarchy = useGraphStore((s) => s.fetchHierarchy);
	const hierarchyData = useGraphStore((s) => s.hierarchyData);

	function handleClick() {
		if (mode === "heb" && !hierarchyData) {
			fetchHierarchy();
		}
		setMainAreaMode(mode);
	}

	return (
		<button
			onClick={handleClick}
			className={cn(
				"flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors",
				mainAreaMode === mode
					? "bg-[--color-accent]/20 text-[--color-accent]"
					: "text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2]",
			)}
			title={label}
		>
			{icon}
			<span className="hidden sm:inline">{label}</span>
		</button>
	);
}

export function TopBar() {
	return (
		<header className="flex items-center gap-3 px-4 h-full border-b border-[--color-border] bg-[--color-surface]">
			{/* Logo */}
			<div className="flex items-center gap-2 shrink-0">
				<GitBranch size={16} className="text-[--color-accent]" />
				<span className="font-semibold text-sm text-[--color-text]">CODEX</span>
			</div>

			<div className="w-px h-5 bg-[--color-border] shrink-0" />

			{/* Search bar */}
			<div className="flex-1 flex justify-center">
				<SearchBar />
			</div>

			{/* View mode toggles */}
			<div className="flex items-center gap-1 shrink-0">
				<ViewToggle mode="placeholder" label="Home" icon={<FolderTree size={14} />} />
				<ViewToggle mode="heb" label="Graph" icon={<Network size={14} />} />
			</div>
		</header>
	);
}
