/**
 * @fileoverview Root layout — three-zone grid: TopBar / ChatPanel / MainArea / SidePanel.
 *
 * Grid layout:
 *   Rows:    56px (top bar) | 1fr (content)
 *   Columns: auto (chat panel, 0 or 280px) | 1fr (graph canvas) | 380px (side panel)
 *
 * The chat panel column animates between 0px (closed) and 320px (open) via CSS transition.
 * The SearchIsland is fixed-position at the bottom-center of the viewport.
 */

import { useEffect } from "react";
import { TopBar } from "@/components/layout/topBar";
import { MainArea } from "@/components/layout/mainArea";
import { SidePanel } from "@/components/layout/sidePanel";
import { ChatPanel } from "@/components/layout/chatPanel";
import { useUiStore } from "@/stores/uiStore";

export function App() {
	const leftPanelOpen = useUiStore((s) => s.leftPanelOpen);
	const themeMode = useUiStore((s) => s.themeMode);

	useEffect(() => {
		function updateTheme() {
			const html = document.documentElement;
			const prefersDark = window.matchMedia(
				"(prefers-color-scheme: dark)",
			).matches;
			const isDark =
				themeMode === "dark" || (themeMode === "system" && prefersDark);
			html.classList.toggle("dark", isDark);
			html.classList.toggle("light", !isDark);
		}

		updateTheme();

		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		mediaQuery.addEventListener("change", updateTheme);
		return () => mediaQuery.removeEventListener("change", updateTheme);
	}, [themeMode]);

	return (
		<div
			style={{
				display: "grid",
				gridTemplateRows: "3rem 1fr",
				gridTemplateColumns: leftPanelOpen ? "20% 1fr 20%" : "0px 1fr 20%",
				height: "100vh",
				overflow: "hidden",
				minHeight: 0,
				transition: "grid-template-columns 300ms ease",
			}}
		>
			{/* Row 1 — full width */}
			<div style={{ gridColumn: "1 / -1" }}>
				<TopBar />
			</div>

			{/* Row 2 col 1 — left chat panel */}
			<ChatPanel />

			{/* Row 2 col 2 — main canvas */}
			<MainArea />

			{/* Row 2 col 3 — right side panel */}
			<SidePanel />

			{/* SearchIsland is now rendered inside MainArea */}
		</div>
	);
}
