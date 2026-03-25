/**
 * @fileoverview Renders social/developer query results.
 */

import type { SocialSearchResult } from "@/types/api";
import { formatDoa, formatChurnRate } from "@/lib/formatters";
import { cn } from "@/lib/utils";

interface SocialResultsProps {
	result: SocialSearchResult;
}

export function SocialResults({ result }: SocialResultsProps) {
	return (
		<div className="flex flex-col">
			{/* LLM answer */}
			{result.answer && (
				<div className="px-4 py-3 border-b border-[--color-border]">
					<p className="text-sm text-[--color-text] leading-relaxed">{result.answer}</p>
					<p className="mt-1 text-[10px] text-[--color-text-muted] font-mono">
						{result.model.split("/").pop()} · {result.usage.inputTokens}↑{" "}
						{result.usage.outputTokens}↓ tokens
					</p>
				</div>
			)}

			{/* Developers */}
			{result.developers.length > 0 && (
				<div>
					<p className="px-4 py-2 text-[11px] font-medium text-[--color-text-muted] uppercase tracking-wider">
						Developers
					</p>
					<ul>
						{result.developers.map((dev) => (
							<li
								key={dev.email}
								className="px-4 py-3 border-b border-[--color-border]"
							>
								<div className="flex items-center justify-between mb-1">
									<div>
										<span className="text-sm text-[--color-text] font-medium">
											{dev.name}
										</span>
										{dev.isFirstAuthor && (
											<span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-300">
												first author
											</span>
										)}
									</div>
									<span className="text-xs font-mono text-[--color-accent]">
										{formatDoa(dev.doaScore)}
									</span>
								</div>

								{/* DOA bar */}
								<div className="h-1 rounded-full bg-[--color-border] mb-1.5">
									<div
										className="h-full rounded-full bg-[--color-accent]"
										style={{ width: `${Math.round(dev.doaScore * 100)}%` }}
									/>
								</div>

								<p className="text-[11px] text-[--color-text-muted] font-mono">
									{dev.email}
								</p>
								{dev.topFiles.length > 0 && (
									<p className="text-[10px] text-[--color-text-muted] mt-0.5 truncate">
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
					<p className="px-4 py-2 text-[11px] font-medium text-[--color-text-muted] uppercase tracking-wider">
						File Churn
					</p>
					<table className="w-full text-xs">
						<thead>
							<tr className="border-b border-[--color-border] text-[--color-text-muted]">
								<th className={cn("px-4 py-1.5 text-left font-normal")}>File</th>
								<th className="px-2 py-1.5 text-right font-normal">Commits</th>
								<th className="px-4 py-1.5 text-right font-normal">Rate</th>
							</tr>
						</thead>
						<tbody>
							{result.files.map((f) => (
								<tr
									key={f.path}
									className="border-b border-[--color-border] hover:bg-[--color-surface-2]"
								>
									<td className="px-4 py-1.5 font-mono text-[11px] text-[--color-text] truncate max-w-[160px]">
										{f.path.split("/").pop()}
									</td>
									<td className="px-2 py-1.5 text-right text-[--color-text-muted]">
										{f.totalCommits}
									</td>
									<td className="px-4 py-1.5 text-right text-[--color-text-muted]">
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
