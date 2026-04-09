/**
 * @fileoverview Renders social/developer query results.
 */

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BarChart3 } from "lucide-react";
import type { SocialSearchResult } from "@/types/api";
import { ShikiCodeBlock } from "./shikiCodeBlock";
import { StatRow } from "./statCard";
import { Progress } from "@/components/ui/progress";
import { formatDoa, formatChurnRate } from "@/lib/formatters";
import { cn } from "@/lib/utils";

interface SocialResultsProps {
	result: SocialSearchResult;
}

export function SocialResults({ result }: SocialResultsProps) {
	const [showStats, setShowStats] = useState(false);

	return (
		<div className="flex flex-col">
			{/* LLM answer */}
			{result.answer && (
				<div className="px-4 py-3 border-b border-[var(--color-border)]">
					<div className="prose prose-sm prose-invert max-w-none text-[var(--color-text)] [&_a]:text-[var(--color-accent)] [&_a]:no-underline [&_a:hover]:underline">
						<ReactMarkdown
							remarkPlugins={[remarkGfm]}
							components={{ code: ShikiCodeBlock }}
						>
							{result.answer}
						</ReactMarkdown>
					</div>
					<div className="flex items-center pt-2">
						<button
							onClick={() => setShowStats((v) => !v)}
							className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
							title={showStats ? "Hide details" : "Show details"}
						>
							<BarChart3 size={12} />
							<span>{showStats ? "Hide" : "Details"}</span>
						</button>
					</div>
					{showStats && (
						<StatRow
							stats={[
								{ label: "model", value: result.model.split("/").pop() ?? result.model, key: "social-model" },
								{ label: "in", value: `${result.usage.inputTokens} tok`, key: "social-tok-in" },
								{ label: "out", value: `${result.usage.outputTokens} tok`, key: "social-tok-out" },
							]}
							className="px-0 pt-2 pb-0 border-0"
						/>
					)}
				</div>
			)}

			{/* Developers */}
			{result.developers.length > 0 && (
				<div>
					<p className="px-4 py-2 text-[11px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider border-b border-[var(--color-border)]">
						Developers
					</p>
					<ul>
						{result.developers.map((dev) => (
							<li
								key={dev.email}
								className="px-4 py-3 border-b border-[var(--color-border)] hover:bg-[var(--color-surface-2)] transition-colors"
							>
								<div className="flex items-center justify-between mb-1.5">
									<div className="min-w-0">
										<span className="text-sm text-[var(--color-text)] font-medium">
											{dev.name}
										</span>
										{dev.isFirstAuthor && (
											<span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-xs bg-amber-500/15 text-amber-300">
												first author
											</span>
										)}
									</div>
									<span className="text-xs font-mono text-[var(--color-accent)] shrink-0 ml-2">
										{formatDoa(dev.doaScore)}
									</span>
								</div>

								<Progress value={dev.doaScore} variant="doa" className="mb-1.5" />

								<p className="text-[11px] text-[var(--color-text-muted)] font-mono truncate">
									{dev.email}
								</p>
								{dev.topFiles.length > 0 && (
									<p className="text-[10px] text-[var(--color-text-subtle)] mt-0.5 truncate">
										{dev.topFiles.slice(0, 3).join(", ")}
									</p>
								)}
							</li>
						))}
					</ul>
				</div>
			)}

			{/* Churn table */}
			{result.files.length > 0 && (
				<div>
					<p className="px-4 py-2 text-[11px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider border-b border-[var(--color-border)]">
						File Churn
					</p>
					<table className="w-full text-xs">
						<thead>
							<tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)]">
								<th className={cn("px-4 py-1.5 text-left font-medium text-[var(--color-text-muted)]")}>File</th>
								<th className="px-2 py-1.5 text-right font-medium text-[var(--color-text-muted)]">Commits</th>
								<th className="px-4 py-1.5 text-right font-medium text-[var(--color-text-muted)]">Rate</th>
							</tr>
						</thead>
						<tbody>
							{result.files.map((f, i) => (
								<tr
									key={f.path}
									className={cn(
										"border-b border-[var(--color-border)] hover:bg-[var(--color-surface-2)] transition-colors",
										i % 2 === 0 ? "bg-transparent" : "bg-[var(--color-surface)]/50",
									)}
								>
									<td className="px-4 py-1.5 font-mono text-[11px] text-[var(--color-text)] truncate max-w-40">
										{f.path.split("/").pop()}
									</td>
									<td className="px-2 py-1.5 text-right text-[var(--color-text-muted)]">
										{f.totalCommits}
									</td>
									<td className="px-4 py-1.5 text-right text-[var(--color-text-muted)]">
										{formatChurnRate(f.churnRate)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
