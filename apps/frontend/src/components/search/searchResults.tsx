/**
 * @fileoverview Dispatcher that renders the correct result component
 * based on the discriminated SearchResult.kind field.
 */

import { Loader2 } from "lucide-react";
import { useSearchStore } from "@/stores/searchStore";
import { StructuralResults } from "./structuralResults";
import { HybridResults } from "./hybridResults";
import { SocialResults } from "./socialResults";
import { PathResults } from "./pathResults";
import { TimingFooter } from "./timingFooter";

export function SearchResults() {
	const { result, isLoading, error, query } = useSearchStore();

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-32 gap-2 text-sm text-[--color-text-muted]">
				<Loader2 size={16} className="animate-spin" />
				<span>Searching…</span>
			</div>
		);
	}

	if (error) {
		return (
			<div className="px-4 py-4">
				<p className="text-sm text-red-400">Error: {error}</p>
				<p className="text-xs text-[--color-text-muted] mt-1">Query: {query}</p>
			</div>
		);
	}

	if (!result) {
		return (
			<div className="flex items-center justify-center h-32 text-sm text-[--color-text-muted]">
				Submit a query to see results.
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			{/* Query as title */}
			{query && (
				<div className="px-4 py-2.5 border-b border-[--color-border] shrink-0">
					<p className="text-sm font-medium text-[--color-text] leading-snug">{query}</p>
				</div>
			)}
			<div className="flex-1 overflow-y-auto">
				{result.kind === "structural" && (
					<StructuralResults result={result.result} />
				)}
				{result.kind === "hybrid" && <HybridResults result={result.result} />}
				{result.kind === "social" && <SocialResults result={result.result} />}
				{result.kind === "path" && <PathResults result={result.result} />}
			</div>
			<TimingFooter timings={result.timings} intent={result.intent} />
		</div>
	);
}
