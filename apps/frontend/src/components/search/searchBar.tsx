/**
 * @fileoverview Search input bar with loading state and intent badge.
 */

import { useState, type KeyboardEvent, type FormEvent } from "react";
import { Search, Loader2 } from "lucide-react";
import { useSearchStore } from "@/stores/searchStore";
import { cn } from "@/lib/utils";

const INTENT_LABELS: Record<string, { label: string; color: string }> = {
	structural: { label: "structural", color: "text-blue-400 bg-blue-400/10" },
	social: { label: "social", color: "text-orange-400 bg-orange-400/10" },
	hybrid: { label: "semantic", color: "text-violet-400 bg-violet-400/10" },
};

export function SearchBar() {
	const [localQuery, setLocalQuery] = useState("");
	const { isLoading, result, executeSearch } = useSearchStore();

	const intent = result?.intent.kind;
	const intentBadge = intent ? INTENT_LABELS[intent] : null;

	function handleSubmit(e: FormEvent) {
		e.preventDefault();
		const trimmed = localQuery.trim();
		if (!trimmed || isLoading) return;
		executeSearch(trimmed);
	}

	function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Enter") {
			handleSubmit(e);
		}
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="relative flex items-center w-full max-w-2xl"
		>
			<div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none z-10 [&>svg]:block [&>svg]:shrink-0">
				{isLoading ? (
					<Loader2 size={16} className="animate-spin" />
				) : (
					<Search size={16} strokeWidth={2.5} />
				)}
			</div>
			<input
				type="text"
				value={localQuery}
				onChange={(e) => setLocalQuery(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Ask anything about the codebase…"
				disabled={isLoading}
				className={cn(
					"w-full pl-9 pr-32 py-2 rounded-lg border text-sm shadow-sm",
					"bg-surface border-border",
					"text-text placeholder:text-text-muted",
					"focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent",
					"disabled:opacity-60 transition-all hover:border-text-muted",
				)}
			/>
			{intentBadge && !isLoading && (
				<span
					className={cn(
						"absolute right-10 text-xs px-2 py-0.5 rounded-md font-medium",
						intentBadge.color,
					)}
				>
					{intentBadge.label}
				</span>
			)}
			<button
				type="submit"
				disabled={isLoading || !localQuery.trim()}
				className={cn(
					"absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 p-0 gap-0 border-0 leading-none rounded-md flex items-center justify-center [&>svg]:shrink-0",
					"text-text hover:text-text hover:bg-surface-2",
					"focus:outline-none focus:ring-2 focus:ring-accent",
					"disabled:text-text-muted",
					"disabled:opacity-60 transition-all",
				)}
				aria-label="Search"
			>
				<Search size={16} strokeWidth={2.5} />
			</button>
		</form>
	);
}
