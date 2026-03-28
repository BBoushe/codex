/**
 * @fileoverview Top navigation bar.
 *
 * Contains: logo, left-panel toggle, view mode toggles (Graph / Explorer).
 * The search bar has been moved to SearchIsland (fixed bottom center).
 */

import { useState, useEffect } from "react";
import {
	GitBranch,
	Network,
	Share2,
	MessageSquare,
	Sun,
	Moon,
} from "lucide-react";
import {
	useUiStore,
	type MainAreaMode,
	type ThemeMode,
} from "@/stores/uiStore";
import { useGraphStore } from "@/stores/graphStore";
import { cn } from "@/lib/utils";

interface ViewToggleProps {
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
				"flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all focus:outline-none focus:ring-2 focus:ring-[--color-accent]",
				mainAreaMode === mode
					? "bg-[--color-surface-2] text-[--color-accent] shadow-sm"
					: "text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2]/50",
			)}
			title={label}
		>
			{icon}
			<span className="hidden sm:inline">{label}</span>
		</button>
	);
}

function ThemeToggle() {
	const { themeMode, setThemeMode } = useUiStore();
	const [sysIsDark, setSysIsDark] = useState(
		window.matchMedia("(prefers-color-scheme: dark)").matches,
	);

	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = (e: MediaQueryListEvent) => setSysIsDark(e.matches);
		mq.addEventListener("change", handler);
		return () => mq.removeEventListener("change", handler);
	}, []);

	const isDark = themeMode === "dark" || (themeMode === "system" && sysIsDark);

	const CYCLE: ThemeMode[] = ["dark", "light", "system"];
	const next = CYCLE[(CYCLE.indexOf(themeMode) + 1) % CYCLE.length];

	return (
		<button
			onClick={() => setThemeMode(next)}
			className="flex items-center justify-center w-8 h-8 rounded-md text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2] focus:ring-2 focus:ring-[--color-accent] focus:outline-none transition-all"
			title={`Theme: ${themeMode} → ${next}`}
		>
			{isDark ? <Moon size={16} /> : <Sun size={16} />}
		</button>
	);
}

export function TopBar() {
	const { leftPanelOpen, toggleLeftPanel } = useUiStore();

	return (
		<header className="flex items-center gap-3 px-4 h-full border-b border-[--color-border] bg-[--color-surface]">
			{/* Left panel toggle */}
			<button
				onClick={toggleLeftPanel}
				className={cn(
					"flex items-center justify-center w-8 h-8 rounded-md transition-all focus:outline-none focus:ring-2 focus:ring-[--color-accent] shrink-0",
					leftPanelOpen
						? "bg-[--color-surface-2] text-[--color-accent] shadow-sm"
						: "text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2]/50",
				)}
				title={leftPanelOpen ? "Close chat" : "Open chat"}
			>
				<MessageSquare size={16} />
			</button>

			{/* Logo */}
			<div className="flex items-center gap-2 shrink-0">
				<GitBranch size={16} className="text-[--color-accent]" />
				<span className="font-semibold text-sm text-[--color-text]">CODEX</span>
			</div>

			<div className="flex-1" />

			{/* View mode toggles */}
			<div className="flex items-center gap-1 shrink-0">
				<ViewToggle
					mode="placeholder"
					label="Home"
					icon={<Network size={14} />}
				/>
				<ViewToggle mode="heb" label="Graph" icon={<Network size={14} />} />
				<ViewToggle mode="force" label="Explorer" icon={<Share2 size={14} />} />
			</div>

			<ThemeToggle />
		</header>
	);
}
