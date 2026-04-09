/**
 * @fileoverview Floating context menu for right-clicking nodes in the force graph.
 *
 * Appears at the click position with options to expand, recenter, or view details.
 * Dismisses on click-outside or Escape.
 */

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface NodeContextMenuProps {
	x: number;
	y: number;
	nodeId: string;
	nodeName: string;
	isExpanded: boolean;
	onExpand: () => void;
	onRecenter: () => void;
	onViewDetails: () => void;
	onClose: () => void;
}

export function NodeContextMenu({
	x,
	y,
	nodeName,
	isExpanded,
	onExpand,
	onRecenter,
	onViewDetails,
	onClose,
}: NodeContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		function handleClickOutside(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		}
		document.addEventListener("keydown", handleKeyDown);
		document.addEventListener("mousedown", handleClickOutside);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [onClose]);

	const itemClass = cn(
		"w-full text-left px-3 py-1.5 text-xs text-[var(--color-text-muted)]",
		"hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors",
		"disabled:opacity-40 disabled:cursor-not-allowed",
	);

	return (
		<div
			ref={menuRef}
			style={{ left: x, top: y }}
			className={cn(
				"absolute z-9999 w-44 rounded-lg border border-[var(--color-border)]",
				"bg-[var(--color-surface)] backdrop-blur-xl",
				"shadow-xl py-1 flex flex-col",
			)}
		>
			<p className="px-3 py-1 text-[10px] text-[var(--color-text-muted)] font-mono truncate border-b border-[var(--color-border)] mb-1">
				{nodeName}
			</p>
			<button
				className={itemClass}
				onClick={() => {
					onExpand();
					onClose();
				}}
				disabled={isExpanded}
			>
				Expand neighbors
			</button>
			<button
				className={itemClass}
				onClick={() => {
					onRecenter();
					onClose();
				}}
			>
				Recenter here
			</button>
			<div className="border-t border-[var(--color-border)] my-1" />
			<button
				className={itemClass}
				onClick={() => {
					onViewDetails();
					onClose();
				}}
			>
				View details
			</button>
		</div>
	);
}
