/**
 * @fileoverview Colored badge for node label types.
 */

import { cn } from "@/lib/utils";

const LABEL_COLORS: Record<string, string> = {
	Function: "bg-blue-500/15 text-blue-300",
	Component: "bg-green-500/15 text-green-300",
	Class: "bg-purple-500/15 text-purple-300",
	Hook: "bg-orange-500/15 text-orange-300",
	Interface: "bg-slate-500/15 text-slate-300",
	Decorator: "bg-pink-500/15 text-pink-300",
	File: "bg-zinc-500/15 text-zinc-300",
	Developer: "bg-yellow-500/15 text-yellow-300",
};

interface LabelBadgeProps {
	label: string;
}

export function LabelBadge({ label }: LabelBadgeProps) {
	const color = LABEL_COLORS[label] ?? "bg-gray-500/15 text-gray-300";
	return (
		<span className={cn("text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0", color)}>
			{label}
		</span>
	);
}
