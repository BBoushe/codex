/**
 * @fileoverview Full entity detail view: source code, metadata, relationships, developers.
 */

import { ArrowLeft, Compass, Loader2, User } from "lucide-react";
import { useEntityStore } from "@/stores/entityStore";
import { useUiStore } from "@/stores/uiStore";
import { useForceStore } from "@/stores/forceStore";
import { LabelBadge } from "@/components/search/labelBadge";
import { SourceViewer } from "./sourceViewer";
import { RelationshipList } from "./relationshipList";
import { formatDoa } from "@/lib/formatters";
import type { RelatedEntity } from "@/types/api";

export function EntityDetail() {
	const { expandedContext, isLoading, error, clearSelection } = useEntityStore();
	const setSidePanelMode = useUiStore((s) => s.setSidePanelMode);
	const setMainAreaMode = useUiStore((s) => s.setMainAreaMode);

	function handleBack() {
		clearSelection();
		setSidePanelMode("results");
	}

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-32 gap-2 text-sm text-[--color-text-muted]">
				<Loader2 size={16} className="animate-spin" />
				<span>Loading entity…</span>
			</div>
		);
	}

	if (error) {
		return (
			<div className="px-4 py-4">
				<button
					onClick={handleBack}
					className="flex items-center gap-1 text-xs text-[--color-text-muted] hover:text-[--color-text] mb-3"
				>
					<ArrowLeft size={12} /> Back
				</button>
				<p className="text-sm text-red-400">{error}</p>
			</div>
		);
	}

	if (!expandedContext) {
		return (
			<div className="flex items-center justify-center h-32 text-sm text-[--color-text-muted]">
				Select an entity to view details.
			</div>
		);
	}

	const { target, file, callers, callees, renderedComponents, hooksUsed, importedFiles, developers } =
		expandedContext;

	return (
		<div className="flex flex-col">
			{/* Back button */}
			<div className="px-4 py-2 border-b border-[--color-border]">
				<button
					onClick={handleBack}
					className="flex items-center gap-1 text-xs text-[--color-text-muted] hover:text-[--color-text]"
				>
					<ArrowLeft size={12} /> Back to results
				</button>
			</div>

			{/* Header */}
			<div className="px-4 py-3 border-b border-[--color-border]">
				<div className="flex items-center gap-2 mb-1">
					<LabelBadge label={target.label} />
					<h2 className="text-sm font-semibold text-[--color-text] truncate">
						{target.name}
					</h2>
					<button
						onClick={() => {
							setMainAreaMode("force");
							useForceStore.getState().fetchSubgraph(target.nodeId, 2);
						}}
						className="ml-auto shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[--color-accent] border border-[--color-accent]/30 hover:bg-[--color-accent]/10 transition-colors"
						title="Explore neighborhood"
					>
						<Compass size={12} /> Explore
					</button>
				</div>
				<p className="text-[11px] text-[--color-text-muted] font-mono truncate">
					{target.filePath}
					{target.startLine > 0 && (
						<span className="opacity-60">
							:{target.startLine}
							{target.endLine > target.startLine ? `–${target.endLine}` : ""}
						</span>
					)}
				</p>
			</div>

			{/* Source code */}
			{target.sourceCode && (
				<div className="border-b border-[--color-border]">
					<p className="px-4 py-1.5 text-[11px] font-medium text-[--color-text-muted] uppercase tracking-wider">
						Source
					</p>
					<SourceViewer
						sourceCode={target.sourceCode}
						language={file?.language ?? "TypeScript"}
						startLine={target.startLine}
					/>
				</div>
			)}

			{/* Relationships */}
			<RelationshipList label="Callers" entities={callers as RelatedEntity[]} />
			<RelationshipList label="Callees" entities={callees as RelatedEntity[]} />
			<RelationshipList label="Renders" entities={renderedComponents as RelatedEntity[]} />
			<RelationshipList label="Hooks Used" entities={hooksUsed as RelatedEntity[]} />

			{/* Imports */}
			{importedFiles.length > 0 && (
				<div className="border-b border-[--color-border]">
					<p className="px-4 py-1.5 text-[11px] font-medium text-[--color-text-muted] uppercase tracking-wider">
						Imports ({importedFiles.length})
					</p>
					<ul>
						{importedFiles.map((f) => (
							<li
								key={f.filePath}
								className="px-4 py-1.5 text-[11px] font-mono text-[--color-text-muted] border-b border-[--color-border] truncate"
							>
								{f.filePath}
							</li>
						))}
					</ul>
				</div>
			)}

			{/* Developers */}
			{developers.length > 0 && (
				<div>
					<p className="px-4 py-1.5 text-[11px] font-medium text-[--color-text-muted] uppercase tracking-wider">
						Authors
					</p>
					<ul>
						{developers.map((dev) => (
							<li
								key={dev.email}
								className="flex items-center gap-3 px-4 py-2 border-b border-[--color-border]"
							>
								<User size={14} className="text-[--color-text-muted] shrink-0" />
								<div className="flex-1 min-w-0">
									<p className="text-xs text-[--color-text] font-medium truncate">
										{dev.name}
									</p>
									<p className="text-[10px] text-[--color-text-muted] font-mono truncate">
										{dev.email}
									</p>
								</div>
								<div className="text-right shrink-0">
									<p className="text-xs font-mono text-[--color-accent]">
										{formatDoa(dev.doaScore)}
									</p>
									{dev.isFirstAuthor && (
										<p className="text-[9px] text-yellow-400">first</p>
									)}
								</div>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
