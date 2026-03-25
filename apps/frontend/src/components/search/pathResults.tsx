/**
 * @fileoverview Renders path search results as a horizontal node chain.
 */

import { ArrowRight } from "lucide-react";
import type { PathQueryResult } from "@/types/api";
import { useEntityStore } from "@/stores/entityStore";
import { useUiStore } from "@/stores/uiStore";
import { LabelBadge } from "./labelBadge";
import { cn } from "@/lib/utils";

interface PathResultsProps {
	result: PathQueryResult;
}

export function PathResults({ result }: PathResultsProps) {
	const selectEntity = useEntityStore((s) => s.selectEntity);
	const setSidePanelMode = useUiStore((s) => s.setSidePanelMode);

	function handleNodeClick(nodeId: string) {
		selectEntity(nodeId);
		setSidePanelMode("entity");
	}

	return (
		<div className="px-4 py-4">
			<p className="text-[11px] text-[--color-text-muted] mb-3">
				{result.hops} hop{result.hops !== 1 ? "s" : ""} ·{" "}
				{result.edgeTypes.join(" → ")}
			</p>

			<div className="flex flex-col gap-1">
				{result.path.map((node, idx) => (
					<div key={node.nodeId} className="flex flex-col gap-1">
						<button
							onClick={() => handleNodeClick(node.nodeId)}
							className={cn(
								"text-left px-3 py-2 rounded-lg border border-[--color-border]",
								"hover:border-[--color-accent] hover:bg-[--color-surface-2]",
								"transition-colors",
							)}
						>
							<div className="flex items-center gap-2">
								<LabelBadge label={node.label} />
								<span className="text-sm text-[--color-text] font-medium truncate">
									{node.name}
								</span>
							</div>
							<p className="text-[11px] text-[--color-text-muted] font-mono truncate mt-0.5">
								{node.filePath}
							</p>
						</button>

						{idx < result.path.length - 1 && (
							<div className="flex items-center gap-2 pl-3 text-[11px] text-[--color-text-muted]">
								<ArrowRight size={12} />
								<span className="font-mono">{result.edgeTypes[idx]}</span>
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
