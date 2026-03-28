/**
 * @fileoverview Left-side collapsible chat panel.
 *
 * Contains two tabs: active results view and query history.
 * Auto-opens when a search is executed via uiStore.leftPanelOpen.
 * The panel width is driven by the parent CSS Grid column width.
 */

import { useState } from "react";
import { MessageSquare, Clock, X, Trash2 } from "lucide-react";
import { useUiStore } from "@/stores/uiStore";
import { useSearchStore, type HistoryEntry } from "@/stores/searchStore";
import { SearchResults } from "@/components/search/searchResults";
import type { SearchResult } from "@/types/api";
import { cn } from "@/lib/utils";

type PanelTab = "results" | "history";

function answerPreview(result: SearchResult): string {
	switch (result.kind) {
		case "hybrid":
			return result.result.answer.slice(0, 90).replace(/\n/g, " ");
		case "social":
			return result.result.answer.slice(0, 90).replace(/\n/g, " ");
		case "structural":
			return `${result.result.entities.length} entit${result.result.entities.length === 1 ? "y" : "ies"} — ${result.result.pattern}`;
		case "path":
			return `Path with ${result.result.hops} hop${result.result.hops === 1 ? "" : "s"}`;
	}
}

function HistoryList({ onSelect }: { onSelect: () => void }) {
	const { history, restoreHistoryEntry, removeHistoryEntry } = useSearchStore();

	if (history.length === 0) {
		return (
			<div className="flex items-center justify-center h-32 text-sm text-[--color-text-muted]">
				No history yet.
			</div>
		);
	}

	function formatTime(ts: number) {
		const d = new Date(ts);
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	function kindBadge(kind: string) {
		const colors: Record<string, string> = {
			hybrid: "bg-indigo-500/20 text-indigo-300",
			structural: "bg-emerald-500/20 text-emerald-300",
			social: "bg-amber-500/20 text-amber-300",
			path: "bg-purple-500/20 text-purple-300",
		};
		return (
			<span
				className={cn(
					"text-[9px] px-1.5 py-0.5 rounded font-medium uppercase",
					colors[kind] ?? "bg-gray-500/20 text-gray-300",
				)}
			>
				{kind}
			</span>
		);
	}

	function handleClick(entry: HistoryEntry) {
		restoreHistoryEntry(entry);
		onSelect();
	}

	return (
		<ul className="py-1">
			{history.map((entry) => (
				<li key={entry.id} className="group relative border-b border-[--color-border]">
					<button
						onClick={() => handleClick(entry)}
						className="w-full text-left px-4 py-2.5 pr-10 hover:bg-[--color-surface-2] transition-colors"
					>
						<div className="flex items-center gap-2 mb-0.5">
							{kindBadge(entry.result.kind)}
							<span className="text-[10px] text-[--color-text-muted] ml-auto">
								{formatTime(entry.timestamp)}
							</span>
						</div>
						<p className="text-xs text-[--color-text] truncate mb-0.5">
							{entry.query}
						</p>
						<p className="text-[11px] text-[--color-text-muted] truncate">
							{answerPreview(entry.result)}
						</p>
					</button>
					<button
						onClick={(e) => { e.stopPropagation(); removeHistoryEntry(entry.id); }}
						className={cn(
							"absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md transition-all",
							"text-[--color-text-muted] hover:text-red-400 hover:bg-[--color-surface-2]",
							"opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none",
						)}
						title="Delete entry"
					>
						<Trash2 size={12} />
					</button>
				</li>
			))}
		</ul>
	);
}

export function ChatPanel() {
	const [activeTab, setActiveTab] = useState<PanelTab>("results");
	const { leftPanelOpen, toggleLeftPanel } = useUiStore();
	const result = useSearchStore((s) => s.result);
	const historyCount = useSearchStore((s) => s.history.length);

	return (
		<aside
			className={cn(
				"flex flex-col h-full border-r border-[--color-border] bg-[--color-surface]",
				"transition-all duration-300 overflow-hidden min-h-0",
				leftPanelOpen ? "w-96" : "w-0",
			)}
		>
			{/* Header */}
			<div className="flex items-center border-b border-[--color-border] px-3 shrink-0">
				{/* Tabs */}
				<button
					onClick={() => setActiveTab("results")}
					className={cn(
						"relative flex flex-1 justify-center items-center gap-1.5 px-2 py-3 text-xs transition-colors border-b-2 focus:outline-none focus-visible:bg-[--color-surface-2]",
						activeTab === "results"
							? "border-[--color-accent] text-[--color-accent] bg-[--color-surface]"
							: "border-transparent text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2]",
					)}
				>
					<MessageSquare size={12} />
					Results
					{result && activeTab !== "results" && (
						<span className="absolute top-2 right-0 w-1.5 h-1.5 rounded-full bg-[--color-accent]" />
					)}
				</button>

				<button
					onClick={() => setActiveTab("history")}
					className={cn(
						"relative flex flex-1 justify-center items-center gap-1.5 px-2 py-3 text-xs transition-colors border-b-2 focus:outline-none focus-visible:bg-[--color-surface-2]",
						activeTab === "history"
							? "border-[--color-accent] text-[--color-accent] bg-[--color-surface]"
							: "border-transparent text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2]",
					)}
				>
					<Clock size={12} />
					History
					{historyCount > 0 && (
						<span className="ml-0.5 text-[9px] text-[--color-text-muted]">
							{historyCount}
						</span>
					)}
				</button>

				{/* Close */}
				<button
					onClick={toggleLeftPanel}
					className="ml-auto text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2] rounded-md transition-all p-1.5 focus:outline-none focus:ring-2 focus:ring-[--color-accent]"
				>
					<X size={14} />
				</button>
			</div>

			{/* Content */}
			<div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
				{activeTab === "results" && <SearchResults />}
				{activeTab === "history" && (
					<HistoryList onSelect={() => setActiveTab("results")} />
				)}
			</div>
		</aside>
	);
}
