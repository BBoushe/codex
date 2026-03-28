/**
 * @fileoverview Recursive tree node component for the file browser.
 */

import { useState } from "react";
import {
	ChevronRight,
	ChevronDown,
	Folder,
	FolderOpen,
	FileCode,
} from "lucide-react";
import type { FileTreeNode } from "@/types/api";
import { languageIcon } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { useEntityStore } from "@/stores/entityStore";
import { useUiStore } from "@/stores/uiStore";

interface FileTreeItemProps {
	node: FileTreeNode;
	/** Nesting depth for indent calculation. */
	depth: number;
}

export function FileTreeItem({ node, depth }: FileTreeItemProps) {
	const [open, setOpen] = useState(depth === 0);
	const indentPx = depth * 12 + 16;
	const selectEntity = useEntityStore((s) => s.selectEntity);
	const setSidePanelMode = useUiStore((s) => s.setSidePanelMode);

	if (node.type === "directory") {
		return (
			<li>
				<button
					onClick={() => setOpen((v) => !v)}
					style={{ paddingLeft: `${indentPx}px` }}
					className={cn(
						"w-full flex items-center gap-1.5 py-1 pr-4 text-xs",
						"text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2]",
						"transition-colors",
					)}
				>
					{open ? (
						<>
							<ChevronDown size={12} className="shrink-0" />
							<FolderOpen size={13} className="shrink-0 text-yellow-400/70" />
						</>
					) : (
						<>
							<ChevronRight size={12} className="shrink-0" />
							<Folder size={13} className="shrink-0 text-yellow-400/70" />
						</>
					)}
					<span className="truncate">{node.name}</span>
				</button>

				{open && node.children && (
					<ul>
						{node.children.map((child) => (
							<FileTreeItem key={child.path} node={child} depth={depth + 1} />
						))}
					</ul>
				)}
			</li>
		);
	}

	// File node — clickable when nodeId is available
	function handleFileClick() {
		if (node.nodeId) {
			selectEntity(node.nodeId);
			setSidePanelMode("entity");
		}
	}

	return (
		<li>
			<button
				onClick={handleFileClick}
				disabled={!node.nodeId}
				style={{ paddingLeft: `${indentPx}px` }}
				className={cn(
					"w-full flex items-center gap-1.5 py-1 pr-4 text-xs text-left",
					"text-[--color-text-muted] transition-colors",
					node.nodeId
						? "hover:text-[--color-text] hover:bg-[--color-surface-2] cursor-pointer"
						: "cursor-default",
				)}
			>
				<FileCode size={13} className="shrink-0 text-blue-400/70" />
				<span className="flex-1 truncate">{node.name}</span>
				{node.language && (
					<span className="text-[9px] text-[--color-text-muted] font-mono opacity-60">
						{languageIcon(node.language)}
					</span>
				)}
			</button>
		</li>
	);
}
