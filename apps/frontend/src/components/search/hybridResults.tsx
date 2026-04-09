/**
 * @fileoverview Renders hybrid RAG results: LLM prose answer + anchor entities.
 */

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, BarChart3 } from "lucide-react";
import { ShikiCodeBlock } from "./shikiCodeBlock";
import { StatRow } from "./statCard";
import type { HybridSearchResult } from "@/types/api";
import { useEntityStore } from "@/stores/entityStore";
import { useUiStore } from "@/stores/uiStore";
import { LabelBadge } from "./labelBadge";
import { cn } from "@/lib/utils";

interface HybridResultsProps {
	result: HybridSearchResult;
}

export function HybridResults({ result }: HybridResultsProps) {
	const [anchorsOpen, setAnchorsOpen] = useState(false);
	const [showStats, setShowStats] = useState(false);
	const selectEntity = useEntityStore((s) => s.selectEntity);
	const setSidePanelMode = useUiStore((s) => s.setSidePanelMode);

	function handleAnchorClick(nodeId: string) {
		selectEntity(nodeId);
		setSidePanelMode("entity");
	}

	return (
		<div className="flex flex-col gap-0">
			{/* Answer — rendered as markdown */}
			<div className="px-4 py-3 prose prose-sm prose-invert max-w-none text-[var(--color-text)] [&_a]:text-[var(--color-accent)] [&_a]:no-underline [&_a:hover]:underline">
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					components={{ code: ShikiCodeBlock }}
				>
					{result.answer}
				</ReactMarkdown>
			</div>

			{/* Collapsible model + token stats */}
			<div className="flex items-center px-4 py-1 border-t border-[var(--color-border)]">
				<button
					onClick={() => setShowStats((v) => !v)}
					className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
					title={showStats ? "Hide details" : "Show details"}
				>
					<BarChart3 size={12} />
					<span>{showStats ? "Hide" : "Details"}</span>
				</button>
			</div>
			{showStats && (
				<StatRow
					stats={[
						{ label: "model", value: result.model.split("/").pop() ?? result.model, key: "hybrid-model" },
						{ label: "in", value: `${result.usage.inputTokens} tok`, key: "hybrid-tok-in" },
						{ label: "out", value: `${result.usage.outputTokens} tok`, key: "hybrid-tok-out" },
						{ label: "anchors", value: result.anchors.length, key: "hybrid-anchors" },
					]}
				/>
			)}

			{/* Anchors */}
			{result.anchors.length > 0 && (
				<div className="border-t border-[var(--color-border)]">
					<button
						onClick={() => setAnchorsOpen((v) => !v)}
						className="w-full flex items-center gap-2 px-4 py-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
					>
						{anchorsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
						{result.anchors.length} anchor{result.anchors.length !== 1 ? "s" : ""}
					</button>

					{anchorsOpen && (
						<ul>
							{result.anchors.map((anchor) => (
								<li key={anchor.nodeId}>
									<button
										onClick={() => handleAnchorClick(anchor.nodeId)}
										className={cn(
											"w-full text-left px-4 py-2 border-b border-[var(--color-border)]",
											"hover:bg-[var(--color-surface-2)] transition-colors",
										)}
									>
										<div className="flex items-center gap-2 mb-0.5">
											<LabelBadge label={anchor.label} />
											<span className="text-xs text-[var(--color-text)] font-medium truncate">
												{anchor.name}
											</span>
											<span className="ml-auto text-[10px] text-[var(--color-text-muted)] font-mono shrink-0">
												{(1 - anchor.distance).toFixed(2)}
											</span>
										</div>
										<p className="text-[11px] text-[var(--color-text-muted)] font-mono truncate">
											{anchor.filePath}:{anchor.startLine}
										</p>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}
