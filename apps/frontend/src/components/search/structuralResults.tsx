/**
 * @fileoverview Renders structural query results as a clickable entity table.
 */

import type { StructuralQueryResult } from "@/types/api";
import { useEntityStore } from "@/stores/entityStore";
import { useUiStore } from "@/stores/uiStore";
import { LabelBadge } from "./labelBadge";
import { cn } from "@/lib/utils";

interface StructuralResultsProps {
	result: StructuralQueryResult;
}

export function StructuralResults({ result }: StructuralResultsProps) {
	const selectEntity = useEntityStore((s) => s.selectEntity);
	const setSidePanelMode = useUiStore((s) => s.setSidePanelMode);

	function handleEntityClick(nodeId: string) {
		if (!nodeId) return;
		selectEntity(nodeId);
		setSidePanelMode("entity");
	}

	return (
		<div className="flex flex-col">
			<div className="px-4 py-2 text-[11px] text-[--color-text-muted] border-b border-[--color-border]">
				<span className="font-mono text-[--color-accent]">{result.pattern}</span>
				{" · "}
				<span>"{result.query}"</span>
				{" · "}
				<span>{result.entities.length} result{result.entities.length !== 1 ? "s" : ""}</span>
			</div>

			{result.entities.length === 0 ? (
				<p className="px-4 py-6 text-sm text-[--color-text-muted] text-center">
					No entities found.
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
									<LabelBadge label={entity.label} />
									<span className="text-sm text-[--color-text] font-medium truncate">
										{entity.name || entity.qualifiedName || entity.filePath}
									</span>
								</div>
								<p className="text-[11px] text-[--color-text-muted] font-mono truncate">
									{entity.filePath}
									{entity.startLine !== undefined && (
										<span className="ml-1 opacity-60">
											:{entity.startLine}
											{entity.endLine !== undefined && entity.endLine !== entity.startLine
												? `–${entity.endLine}`
												: ""}
										</span>
									)}
								</p>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
