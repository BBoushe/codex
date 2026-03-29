/**
 * @fileoverview Renders property ranking query results as a sorted list.
 */

import type { PropertySearchResult } from "@/types/api";
import { useEntityStore } from "@/stores/entityStore";
import { useUiStore } from "@/stores/uiStore";
import { LabelBadge } from "./labelBadge";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface PropertyResultsProps {
	result: PropertySearchResult;
}

export function PropertyResults({ result }: PropertyResultsProps) {
	const selectEntity = useEntityStore((s) => s.selectEntity);
	const setSidePanelMode = useUiStore((s) => s.setSidePanelMode);

	function handleEntityClick(nodeId: string) {
		if (!nodeId) return;
		selectEntity(nodeId);
		setSidePanelMode("entity");
	}

	return (
		<div className="flex flex-col">
			{/* Prose answer */}
			<div className="px-4 py-3 border-b border-[--color-border]">
				<div className="prose prose-sm prose-invert max-w-none [&_code]:text-[--color-accent] [&_code]:bg-[--color-surface-2] [&_code]:px-1 [&_code]:rounded [&_pre]:bg-[--color-surface-2] [&_pre]:rounded-lg [&_a]:text-[--color-accent]">
					<ReactMarkdown remarkPlugins={[remarkGfm]}>
						{result.answer}
					</ReactMarkdown>
				</div>
			</div>

			{/* Header */}
			<div className="px-4 py-2 text-[11px] text-[--color-text-muted] border-b border-[--color-border]">
				<span className="font-mono text-[--color-accent]">{result.property}</span>
				{" · "}
				<span>{result.entities.length} result{result.entities.length !== 1 ? "s" : ""}</span>
				{result.unit && (
					<>
						{" · "}
						<span>unit: {result.unit}</span>
					</>
				)}
			</div>

			{/* Ranked list */}
			{result.entities.length === 0 ? (
				<p className="px-4 py-6 text-sm text-[--color-text-muted] text-center">
					No entities found with this property.
				</p>
			) : (
				<ul>
					{result.entities.map((entity, idx) => (
						<li key={entity.nodeId || idx}>
							<button
								onClick={() => handleEntityClick(entity.nodeId)}
								disabled={!entity.nodeId}
								className={cn(
									"w-full text-left px-4 py-2.5 border-b border-[--color-border]",
									"hover:bg-[--color-surface-2] transition-colors",
									"disabled:cursor-default disabled:hover:bg-transparent",
								)}
							>
								<div className="flex items-center gap-2 mb-0.5">
									<span className="text-[11px] text-[--color-text-muted] font-mono w-5 shrink-0 text-right">
										{idx + 1}.
									</span>
									<LabelBadge label={entity.label} />
									<span className="text-sm text-[--color-text] font-medium truncate">
										{entity.name || entity.filePath}
									</span>
									<span className="ml-auto text-sm font-mono text-[--color-accent] shrink-0">
										{entity.value} {result.unit}
									</span>
								</div>
								<p className="text-[11px] text-[--color-text-muted] font-mono truncate pl-7">
									{entity.filePath}
								</p>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
