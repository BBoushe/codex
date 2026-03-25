/**
 * @fileoverview Renders hybrid RAG results: LLM prose answer + anchor entities.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
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
	const selectEntity = useEntityStore((s) => s.selectEntity);
	const setSidePanelMode = useUiStore((s) => s.setSidePanelMode);

	function handleAnchorClick(nodeId: string) {
		selectEntity(nodeId);
		setSidePanelMode("entity");
	}

	return (
		<div className="flex flex-col gap-0">
			{/* Answer */}
			<div className="px-4 py-3">
				<p className="text-sm text-[--color-text] leading-relaxed whitespace-pre-wrap">
					{result.answer}
				</p>
			</div>

			{/* Model + token info */}
			<div className="px-4 py-1.5 flex items-center gap-3 text-[10px] text-[--color-text-muted] border-t border-[--color-border]">
				<span className="font-mono">{result.model.split("/").pop()}</span>
				<span>{result.usage.inputTokens}↑ {result.usage.outputTokens}↓ tokens</span>
			</div>

			{/* Anchors */}
			{result.anchors.length > 0 && (
				<div className="border-t border-[--color-border]">
					<button
						onClick={() => setAnchorsOpen((v) => !v)}
						className="w-full flex items-center gap-2 px-4 py-2 text-xs text-[--color-text-muted] hover:text-[--color-text] transition-colors"
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
											"w-full text-left px-4 py-2 border-b border-[--color-border]",
											"hover:bg-[--color-surface-2] transition-colors",
										)}
									>
										<div className="flex items-center gap-2 mb-0.5">
											<LabelBadge label={anchor.label} />
											<span className="text-xs text-[--color-text] font-medium truncate">
												{anchor.name}
											</span>
											<span className="ml-auto text-[10px] text-[--color-text-muted] font-mono shrink-0">
												{(1 - anchor.distance).toFixed(2)}
											</span>
										</div>
										<p className="text-[11px] text-[--color-text-muted] font-mono truncate">
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
