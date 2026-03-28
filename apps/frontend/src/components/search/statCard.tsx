/**
 * @fileoverview Toggleable stat card for displaying RAG pipeline metadata.
 *
 * Visibility is persisted in localStorage by `storageKey`.
 * Used inside hybrid/social/structural result views for model, token, and timing info.
 */

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface StatCardProps {
	label: string;
	value: string | number;
	/** Unique key for localStorage persistence. If omitted, visibility is not persisted. */
	storageKey?: string;
	className?: string;
}

export function StatCard({ label, value, storageKey, className }: StatCardProps) {
	const [visible, setVisible] = useState(() => {
		if (!storageKey) return true;
		return localStorage.getItem(`stat-vis:${storageKey}`) !== "false";
	});

	function toggle() {
		const next = !visible;
		setVisible(next);
		if (storageKey) localStorage.setItem(`stat-vis:${storageKey}`, String(next));
	}

	return (
		<Card
			className={cn(
				"flex items-center gap-2 px-3 py-1.5 rounded-lg",
				className,
			)}
		>
			<span className="text-[10px] text-[--color-text-muted] shrink-0">{label}</span>
			{visible ? (
				<span className="text-[11px] font-mono text-[--color-text] flex-1 truncate">
					{value}
				</span>
			) : (
				<span className="text-[10px] text-[--color-text-muted] flex-1 italic">hidden</span>
			)}
			<button
				onClick={toggle}
				className="shrink-0 text-[--color-text-muted] hover:text-[--color-text] transition-colors focus:outline-none"
				aria-label={visible ? "Hide" : "Show"}
			>
				{visible ? <EyeOff size={10} /> : <Eye size={10} />}
			</button>
		</Card>
	);
}

interface StatRowProps {
	stats: Array<{ label: string; value: string | number; key: string }>;
	className?: string;
}

/** Renders a horizontal row of StatCards. */
export function StatRow({ stats, className }: StatRowProps) {
	return (
		<div className={cn("flex flex-wrap gap-1.5 px-4 py-2 border-t border-[--color-border]", className)}>
			{stats.map((s) => (
				<StatCard key={s.key} label={s.label} value={s.value} storageKey={s.key} />
			))}
		</div>
	);
}
