/**
 * @fileoverview File browser panel — shows a tree of ingested source files.
 *
 * Fetches GET /api/browse/tree on mount and renders a recursive tree view.
 * Clicking a file selects it; clicking an entity navigates to entity detail.
 */

import { useState, useEffect } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { fetchBrowseTree } from "@/api/client";
import type { FileTreeNode } from "@/types/api";
import { FileTreeItem } from "./fileTreeItem";

export function FileBrowser() {
	const [tree, setTree] = useState<FileTreeNode[] | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function loadTree() {
		setIsLoading(true);
		setError(null);

		const result = await fetchBrowseTree();

		setIsLoading(false);

		if (result.ok) {
			setTree(result.data);
		} else {
			setError(result.error.message);
		}
	}

	useEffect(() => {
		loadTree();
	}, []);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-32 gap-2 text-sm text-[var(--color-text-muted)]">
				<Loader2 size={16} className="animate-spin" />
				<span>Loading files…</span>
			</div>
		);
	}

	if (error) {
		return (
			<div className="px-4 py-4">
				<p className="text-sm text-red-400 mb-2">{error}</p>
				<button
					onClick={loadTree}
					className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
				>
					<RefreshCw size={12} /> Retry
				</button>
			</div>
		);
	}

	if (!tree || tree.length === 0) {
		return (
			<div className="px-4 py-6 text-center">
				<p className="text-sm text-[var(--color-text-muted)]">No files found.</p>
				<p className="text-xs text-[var(--color-text-muted)] mt-1">Run codex ingest first.</p>
			</div>
		);
	}

	return (
		<div className="py-2">
			<div className="flex items-center justify-between px-4 pb-2">
				<span className="text-[11px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
					Files
				</span>
				<button
					onClick={loadTree}
					className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
					title="Refresh"
				>
					<RefreshCw size={12} />
				</button>
			</div>
			<ul>
				{tree.map((node) => (
					<FileTreeItem key={node.path} node={node} depth={0} />
				))}
			</ul>
		</div>
	);
}
