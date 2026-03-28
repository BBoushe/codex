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
import { Collapsible } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { formatDoa } from "@/lib/formatters";
import type { RelatedEntity } from "@/types/api";

export function EntityDetail() {
	const { expandedContext, isLoading, error, clearSelection } = useEntityStore();
	const setSidePanelMode = useUiStore((s) => s.setSidePanelMode);
	const setMainAreaMode = useUiStore((s) => s.setMainAreaMode);

	function handleBack() {
		clearSelection();
		setSidePanelMode("browser");
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
					className="flex items-center gap-1 text-xs text-[--color-text-muted] hover:text-[--color-text] mb-3 transition-colors"
				>
					<ArrowLeft size={12} /> Back
				</button>
				<p className="text-sm text-[--color-error]">{error}</p>
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

	const isFile = target.label === "File";

	return (
		<div className="flex flex-col animate-fade-in">
			{/* Back button */}
			<div className="px-4 py-2 border-b border-[--color-border]">
				<button
					onClick={handleBack}
					className="flex items-center gap-1 text-xs text-[--color-text-muted] hover:text-[--color-text] transition-colors"
				>
					<ArrowLeft size={12} /> Back to results
				</button>
			</div>

			{/* Header */}
			<div className="px-4 py-3 border-b border-[--color-border] bg-[--color-surface]">
				<div className="flex items-start gap-2 mb-1.5">
					<LabelBadge label={target.label} />
					<h2 className="text-sm font-semibold text-[--color-text] leading-snug flex-1 min-w-0">
						{target.name}
					</h2>
					<Button
						variant="accent"
						size="xs"
						onClick={() => {
							setMainAreaMode("force");
							useForceStore.getState().fetchSubgraph(target.nodeId, 2);
						}}
						title="Explore neighborhood"
						className="shrink-0"
					>
						<Compass size={11} /> Explore
					</Button>
				</div>
				<p className="text-[11px] text-[--color-text-muted] font-mono truncate">
					{target.filePath}
					{!isFile && target.startLine > 0 && (
						<span className="opacity-60">
							:{target.startLine}
							{target.endLine > target.startLine ? `–${target.endLine}` : ""}
						</span>
					)}
				</p>
				{isFile && file && (
					<p className="text-[10px] text-[--color-text-muted] mt-1">
						Language: {file.language}
					</p>
				)}
			</div>

			{/* Source code (not for File nodes — they have no sourceCode) */}
			{!isFile && target.sourceCode && (
				<Collapsible title="Source" defaultOpen>
					<SourceViewer
						sourceCode={target.sourceCode}
						language={file?.language ?? "TypeScript"}
						startLine={target.startLine}
					/>
				</Collapsible>
			)}

			{/* For File nodes: show entities defined in this file */}
			{isFile && callees.length > 0 && (
				<Collapsible title="Defined Entities" count={callees.length} defaultOpen>
					<RelationshipList label="" entities={callees as RelatedEntity[]} />
				</Collapsible>
			)}

			{/* Relationships (non-File nodes) */}
			{!isFile && callers.length > 0 && (
				<Collapsible title="Callers" count={callers.length} defaultOpen={callers.length <= 5}>
					<RelationshipList label="" entities={callers as RelatedEntity[]} />
				</Collapsible>
			)}
			{!isFile && callees.length > 0 && (
				<Collapsible title="Callees" count={callees.length} defaultOpen={callees.length <= 5}>
					<RelationshipList label="" entities={callees as RelatedEntity[]} />
				</Collapsible>
			)}
			{renderedComponents.length > 0 && (
				<Collapsible title="Renders" count={renderedComponents.length}>
					<RelationshipList label="" entities={renderedComponents as RelatedEntity[]} />
				</Collapsible>
			)}
			{hooksUsed.length > 0 && (
				<Collapsible title="Hooks Used" count={hooksUsed.length}>
					<RelationshipList label="" entities={hooksUsed as RelatedEntity[]} />
				</Collapsible>
			)}

			{/* Imports */}
			{importedFiles.length > 0 && (
				<Collapsible title="Imports" count={importedFiles.length}>
					<ul>
						{importedFiles.map((f) => (
							<li
								key={f.filePath}
								className="px-4 py-1.5 text-[11px] font-mono text-[--color-text-muted] border-b border-[--color-border] truncate last:border-0 hover:bg-[--color-surface-2] transition-colors"
							>
								{f.filePath}
							</li>
						))}
					</ul>
				</Collapsible>
			)}

			{/* Developers */}
			{developers.length > 0 && (
				<Collapsible title="Authors" count={developers.length} defaultOpen>
					<ul>
						{developers.map((dev) => (
							<li
								key={dev.email}
								className="flex items-center gap-3 px-4 py-2.5 border-b border-[--color-border] last:border-0 hover:bg-[--color-surface-2] transition-colors"
							>
								<div className="w-7 h-7 rounded-full bg-[--color-surface-2] border border-[--color-border] flex items-center justify-center shrink-0">
									<User size={13} className="text-[--color-text-muted]" />
								</div>
								<div className="flex-1 min-w-0">
									<p className="text-xs text-[--color-text] font-medium truncate">
										{dev.name}
									</p>
									<p className="text-[10px] text-[--color-text-muted] font-mono truncate mb-1">
										{dev.email}
									</p>
									<Progress value={dev.doaScore} variant="doa" />
								</div>
								<div className="text-right shrink-0">
									<p className="text-xs font-mono text-[--color-accent]">
										{formatDoa(dev.doaScore)}
									</p>
									{dev.isFirstAuthor && (
										<p className="text-[9px] text-amber-400 mt-0.5">first</p>
									)}
								</div>
							</li>
						))}
					</ul>
				</Collapsible>
			)}
		</div>
	);
}
