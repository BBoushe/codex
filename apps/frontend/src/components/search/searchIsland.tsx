/**
 * @fileoverview Floating search island fixed at the bottom-center of the screen.
 *
 * Contains the search input and a settings popover (provider, context budget).
 * The settings popover opens upward from the island via Radix Popover.
 */

import { useRef, useState, useEffect } from "react";
import { Search, Loader2, Settings2 } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { useSearchStore } from "@/stores/searchStore";
import { useSettingsStore, type LlmProvider } from "@/stores/settingsStore";
import { fetchModels } from "@/api/client";
import type { ContextBudget, ModelInfo } from "@/types/api";
import { cn } from "@/lib/utils";

const PROVIDERS: { value: LlmProvider; label: string }[] = [
	{ value: "siliconflow", label: "SiliconFlow" },
	{ value: "openai", label: "OpenAI" },
	{ value: "anthropic", label: "Anthropic" },
	{ value: "gemini", label: "Gemini" },
];

const BUDGETS: { value: ContextBudget; label: string; desc: string }[] = [
	{ value: "compact", label: "Compact", desc: "8K chars" },
	{ value: "standard", label: "Standard", desc: "24K chars" },
	{ value: "full", label: "Full", desc: "Unlimited" },
];

export function SearchIsland() {
	const inputRef = useRef<HTMLInputElement>(null);
	const [localQuery, setLocalQuery] = useState("");
	const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
	const [activeModel, setActiveModel] = useState("");
	const { isLoading, executeSearch } = useSearchStore();
	const { provider, budget, model, setProvider, setBudget, setModel } = useSettingsStore();

	useEffect(() => {
		fetchModels().then((res) => {
			if (res.ok) {
				setAvailableModels(res.data.models);
				if (res.data.activeModel) {
					setActiveModel(res.data.activeModel);
					if (!model) setModel(res.data.activeModel);
				}
			}
		});
	}, []);

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const q = localQuery.trim();
		if (!q || isLoading) return;
		executeSearch(q);
		setLocalQuery("");
	}

	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey) {
			handleSubmit(e as unknown as React.FormEvent);
		}
	}

	return (
		<div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 w-full max-w-2xl px-4">
			<form
				onSubmit={handleSubmit}
				className={cn(
					"flex items-center gap-2 px-4 py-3 rounded-2xl",
					"border border-[--color-border]",
					"bg-[--color-surface]/90 backdrop-blur-xl",
					"shadow-2xl shadow-black/40",
				)}
			>
				{/* Settings popover */}
				<Popover.Root>
					<Popover.Trigger asChild>
						<button
							type="button"
							className="shrink-0 p-1.5 rounded-md text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2] focus:outline-none focus:ring-2 focus:ring-[--color-accent] transition-all"
							title="Search settings"
						>
							<Settings2 size={16} />
						</button>
					</Popover.Trigger>

					<Popover.Portal>
						<Popover.Content
							side="top"
							align="start"
							sideOffset={12}
							className={cn(
								"z-50 w-72 rounded-xl border border-[--color-border]",
								"p-4 shadow-xl flex flex-col gap-4",
							)}
							style={{ background: "var(--color-surface)" }}
						>
							{/* Provider */}
							<div>
								<p className="text-[11px] font-medium text-[--color-text-muted] uppercase tracking-wider mb-2">
									Provider
								</p>
								<div className="grid grid-cols-2 gap-1">
									{PROVIDERS.map((p) => (
										<button
											key={p.value}
											type="button"
											onClick={() => setProvider(p.value)}
											className={cn(
												"px-2 py-1.5 rounded-md text-xs transition-all text-left focus:outline-none focus:ring-2 focus:ring-[--color-accent]",
												provider === p.value
													? "bg-[--color-accent] text-white shadow-sm"
													: "text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2] border border-[--color-border]",
											)}
										>
											{p.label}
										</button>
									))}
								</div>
							</div>

							{/* Context budget */}
							<div>
								<p className="text-[11px] font-medium text-[--color-text-muted] uppercase tracking-wider mb-2">
									Context Budget
								</p>
								<div className="flex flex-col gap-1">
									{BUDGETS.map((b) => (
										<button
											key={b.value}
											type="button"
											onClick={() => setBudget(b.value)}
											className={cn(
												"flex items-center justify-between px-3 py-2 rounded-md text-xs transition-all focus:outline-none focus:ring-2 focus:ring-[--color-accent]",
												budget === b.value
													? "bg-[--color-accent] text-white shadow-sm"
													: "text-[--color-text-muted] hover:text-[--color-text] hover:bg-[--color-surface-2] border border-[--color-border]",
											)}
										>
											<span>{b.label}</span>
											<span className="opacity-70">{b.desc}</span>
										</button>
									))}
								</div>
							</div>

							{/* Model */}
							<div>
								<p className="text-[11px] font-medium text-[--color-text-muted] uppercase tracking-wider mb-2">
									Model
								</p>
								{availableModels.length > 0 && (
									<select
										value={model}
										onChange={(e) => setModel(e.target.value)}
										className="w-full py-1.5 px-2 rounded-md text-xs bg-[--color-surface-2] border border-[--color-border] text-[--color-text] outline-none focus:ring-2 focus:ring-[--color-accent] mb-2"
									>
										<option value="">
											Default{activeModel ? ` (${activeModel.split("/").pop()})` : ""}
										</option>
										{availableModels.map((m) => (
											<option key={m.id} value={m.id}>
												{m.name}
											</option>
										))}
									</select>
								)}
								<input
									type="text"
									value={model}
									onChange={(e) => setModel(e.target.value)}
									placeholder="Custom model ID…"
									className="w-full px-3 py-1.5 rounded-md text-xs bg-[--color-surface-2] border border-[--color-border] text-[--color-text] placeholder:text-[--color-text-muted] outline-none focus:ring-2 focus:ring-[--color-accent]"
								/>
							</div>

							<Popover.Arrow className="fill-[--color-border]" />
						</Popover.Content>
					</Popover.Portal>
				</Popover.Root>

				{/* Input */}
				<input
					ref={inputRef}
					type="text"
					value={localQuery}
					onChange={(e) => setLocalQuery(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="Ask about your codebase…"
					disabled={isLoading}
					className={cn(
						"flex-1 bg-transparent outline-none text-sm text-[--color-text]",
						"placeholder:text-[--color-text-muted]",
						"disabled:opacity-60",
					)}
				/>

				{/* Submit */}
				<button
					type="submit"
					disabled={!localQuery.trim() || isLoading}
					className={cn(
						"shrink-0 flex items-center justify-center w-7 h-7 rounded-lg transition-all focus:outline-none focus:ring-2 focus:ring-[--color-accent] focus:ring-offset-1 focus:ring-offset-[--color-surface]",
						localQuery.trim() && !isLoading
							? "bg-[--color-accent] text-white hover:bg-[--color-accent-hover] shadow-sm transform hover:scale-105 active:scale-95"
							: "text-[--color-text-muted] bg-[--color-surface-2] opacity-50 cursor-not-allowed",
					)}
				>
					{isLoading ? (
						<Loader2 size={14} className="animate-spin" />
					) : (
						<Search size={14} />
					)}
				</button>
			</form>
		</div>
	);
}
