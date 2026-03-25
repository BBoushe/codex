/**
 * @fileoverview Root layout — three-zone grid: TopBar / MainArea / SidePanel.
 *
 * Grid layout:
 *   Rows:    56px (top bar) | 1fr (content)
 *   Columns: 1fr (graph canvas) | 380px (side panel)
 */

import { TopBar } from "@/components/layout/topBar";
import { MainArea } from "@/components/layout/mainArea";
import { SidePanel } from "@/components/layout/sidePanel";

export function App() {
	return (
		<div
			style={{
				display: "grid",
				gridTemplateRows: "56px 1fr",
				gridTemplateColumns: "1fr 380px",
				height: "100vh",
				overflow: "hidden",
			}}
		>
			{/* Row 1 — full width */}
			<div style={{ gridColumn: "1 / -1" }}>
				<TopBar />
			</div>

			{/* Row 2 col 1 */}
			<MainArea />

			{/* Row 2 col 2 */}
			<SidePanel />
		</div>
	);
}
