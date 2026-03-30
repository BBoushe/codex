/**
 * @fileoverview Risk panel for ownership metrics.
 *
 * Displays Truck Factor, critical developers, and failure breakdowns for
 * missing/inconsistent expertise data.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ShieldAlert, Users } from "lucide-react";
import { fetchRiskMetrics } from "@/api/client";
import type { RiskMetricsResponse } from "@/types/api";
import { cn } from "@/lib/utils";

interface RiskLoadState {
	data: RiskMetricsResponse | null;
	error: string | null;
	isLoading: boolean;
}

export function RiskPanel() {
	const [state, setState] = useState<RiskLoadState>({
		data: null,
		error: null,
		isLoading: true,
	});

	async function loadRisk() {
		const result = await fetchRiskMetrics();
		if (result.ok) {
			setState({ data: result.data, error: null, isLoading: false });
			return;
		}
		setState({ data: null, error: result.error.message, isLoading: false });
	}

	function reloadRisk() {
		setState((prev) => ({ ...prev, isLoading: true, error: null }));
		void loadRisk();
	}

	useEffect(() => {
		let cancelled = false;
		void fetchRiskMetrics().then((result) => {
			if (cancelled) return;
			if (result.ok) {
				setState({ data: result.data, error: null, isLoading: false });
				return;
			}
			setState({ data: null, error: result.error.message, isLoading: false });
		});

		return () => {
			cancelled = true;
		};
	}, []);

	const failureItems = useMemo(() => {
		const breakdown = state.data?.diagnostics.failureBreakdown;
		if (!breakdown) return [];

		const items: string[] = [];
		if (breakdown.emptyExpertiseGraph) {
			items.push(
				"No HAS_EXPERTISE edges found. Run codex mine before risk analysis.",
			);
		}
		if (breakdown.staleMiningRun) {
			items.push(
				"Developers exist but expertise edges are missing. Mining data is stale.",
			);
		}
		if (breakdown.inconsistentDeveloperNodes > 0) {
			items.push(
				`${breakdown.inconsistentDeveloperNodes} Developer nodes missing name or email.`,
			);
		}
		if (breakdown.inconsistentExpertiseEdges > 0) {
			items.push(
				`${breakdown.inconsistentExpertiseEdges} HAS_EXPERTISE edges missing doaScore.`,
			);
		}
		return items;
	}, [state.data]);

	if (state.isLoading) {
		return (
			<div className="h-full p-4 flex items-center justify-center text-sm text-[--color-text-muted]">
				Loading risk metrics...
			</div>
		);
	}

	if (state.error) {
		return (
			<div className="h-full p-4 flex flex-col gap-3">
				<div className="flex items-center gap-2 text-red-300 text-sm">
					<AlertTriangle size={15} />
					<span>Failed to load risk metrics</span>
				</div>
				<p className="text-xs text-[--color-text-muted]">{state.error}</p>
				<button
					onClick={reloadRisk}
					className={cn(
						"w-fit px-2.5 py-1.5 rounded text-xs",
						"border border-[--color-border] text-[--color-text-muted]",
						"hover:text-[--color-text] hover:border-[--color-accent]/40",
					)}
				>
					Retry
				</button>
			</div>
		);
	}

	if (!state.data) {
		return null;
	}

	const { truckFactor, criticalDevelopers, ownership, diagnostics } =
		state.data;

	return (
		<div className="h-full p-4 flex flex-col gap-4">
			<header className="flex items-center justify-between">
				<div>
					<p className="text-xs uppercase tracking-wider text-[--color-text-muted]">
						Risk
					</p>
					<h3 className="text-sm font-semibold text-[--color-text]">
						Ownership Resilience
					</h3>
				</div>
				<button
					onClick={reloadRisk}
					className={cn(
						"text-[10px] px-2 py-1 rounded border border-[--color-border]",
						"text-[--color-text-muted] hover:text-[--color-text]",
					)}
				>
					Refresh
				</button>
			</header>

			<section className="rounded-md border border-[--color-border] bg-[--color-surface-2] p-3">
				<div className="flex items-center justify-between">
					<span className="text-xs text-[--color-text-muted]">
						Truck Factor
					</span>
					<span className="text-lg font-semibold text-[--color-text]">
						{truckFactor}
					</span>
				</div>
				<p className="text-[10px] text-[--color-text-subtle] mt-2">
					Critical departures required to orphan more than 50% of owned files.
				</p>
			</section>

			<section className="rounded-md border border-[--color-border] p-3">
				<p className="text-xs text-[--color-text-muted] uppercase tracking-wider mb-2">
					Critical Developers
				</p>
				{criticalDevelopers.length === 0 ? (
					<p className="text-xs text-[--color-text-subtle]">
						No critical developers identified yet.
					</p>
				) : (
					<ul className="flex flex-col gap-1.5">
						{criticalDevelopers.map((dev) => (
							<li
								key={dev.email}
								className="flex items-center justify-between text-xs"
							>
								<span className="text-[--color-text]">{dev.name}</span>
								<span className="text-[--color-text-muted]">
									{dev.ownedFiles} files
								</span>
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="rounded-md border border-[--color-border] p-3">
				<p className="text-xs text-[--color-text-muted] uppercase tracking-wider mb-2">
					Ownership Distribution
				</p>
				{ownership.length === 0 ? (
					<p className="text-xs text-[--color-text-subtle]">
						No ownership data available.
					</p>
				) : (
					<ul className="flex flex-col gap-1.5 max-h-44 overflow-y-auto pr-1">
						{ownership.map((dev) => (
							<li
								key={dev.email}
								className="flex items-center justify-between text-xs"
							>
								<span className="text-[--color-text] truncate">{dev.name}</span>
								<span className="text-[--color-text-muted]">
									{(dev.ownershipShare * 100).toFixed(1)}% ({dev.ownedFiles})
								</span>
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="rounded-md border border-[--color-border] p-3">
				<p className="text-xs text-[--color-text-muted] uppercase tracking-wider mb-2">
					Diagnostics
				</p>
				<div className="grid grid-cols-2 gap-2 text-[10px]">
					<DiagCell label="Developers" value={diagnostics.developerCount} />
					<DiagCell label="Files" value={diagnostics.fileCount} />
					<DiagCell
						label="Expertise Edges"
						value={diagnostics.expertiseEdgeCount}
					/>
					<DiagCell label="Orphaned Files" value={diagnostics.orphanedFiles} />
				</div>
			</section>

			{failureItems.length > 0 && (
				<section className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
					<div className="flex items-center gap-2 mb-2 text-amber-300">
						<ShieldAlert size={14} />
						<p className="text-xs uppercase tracking-wider">
							Failure Breakdown
						</p>
					</div>
					<ul className="flex flex-col gap-1.5">
						{failureItems.map((item) => (
							<li
								key={item}
								className="text-[11px] text-[--color-text-muted] flex items-start gap-1.5"
							>
								<Users size={11} className="mt-0.5 text-amber-300" />
								<span>{item}</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

interface DiagCellProps {
	label: string;
	value: number;
}

function DiagCell({ label, value }: DiagCellProps) {
	return (
		<div className="rounded border border-[--color-border] bg-[--color-surface-2] p-2">
			<p className="text-[--color-text-subtle]">{label}</p>
			<p className="text-[--color-text] font-medium mt-0.5">{value}</p>
		</div>
	);
}
