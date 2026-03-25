/**
 * @fileoverview A collapsible list of related entities (callers, callees, etc.).
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { RelatedEntity } from "@/types/api";
import { useEntityStore } from "@/stores/entityStore";
import { LabelBadge } from "@/components/search/labelBadge";

interface RelationshipListProps {
	label: string;
	entities: RelatedEntity[];
}

export function RelationshipList({ label, entities }: RelationshipListProps) {
	const [open, setOpen] = useState(false);
	const selectEntity = useEntityStore((s) => s.selectEntity);

	if (entities.length === 0) return null;

	return (
		<div className="border-b border-[--color-border]">
			<button
				onClick={() => setOpen((v) => !v)}
				className="w-full flex items-center gap-2 px-4 py-2 text-xs text-[--color-text-muted] hover:text-[--color-text] transition-colors"
			>
				{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				<span className="font-medium uppercase tracking-wider">{label}</span>
				<span className="ml-auto">{entities.length}</span>
			</button>

			{open && (
				<ul>
					{entities.map((entity, idx) => (
						<li key={entity.nodeId || idx}>
							<button
								onClick={() => selectEntity(entity.nodeId)}
								className="w-full text-left px-4 py-2 border-t border-[--color-border] hover:bg-[--color-surface-2] transition-colors"
							>
								<div className="flex items-center gap-2">
									<LabelBadge label={entity.label} />
									<span className="text-xs text-[--color-text] truncate">
										{entity.name}
									</span>
									{entity.callSiteLine !== undefined && (
										<span className="ml-auto text-[10px] text-[--color-text-muted] font-mono shrink-0">
											:{entity.callSiteLine}
										</span>
									)}
								</div>
								<p className="text-[10px] text-[--color-text-muted] font-mono truncate mt-0.5">
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
