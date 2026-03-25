/**
 * @fileoverview Display formatting utilities.
 */

/** Formats a DOA score (0-1) as a percentage string. */
export function formatDoa(score: number): string {
	return `${Math.round(score * 100)}%`;
}

/** Formats a duration in milliseconds for display. */
export function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Formats a churn rate (commits/month) for display. */
export function formatChurnRate(rate: number): string {
	return `${rate.toFixed(1)}/mo`;
}

/** Returns a short label from a node label string (e.g. "Component" → "Comp"). */
export function shortLabel(label: string): string {
	const map: Record<string, string> = {
		Function: "Fn",
		Component: "Comp",
		Class: "Class",
		Hook: "Hook",
		Interface: "Iface",
		Decorator: "Deco",
		File: "File",
		Directory: "Dir",
		Developer: "Dev",
		Commit: "Commit",
		Prop: "Prop",
	};
	return map[label] ?? label;
}

/** Returns the language icon/emoji for a language string. */
export function languageIcon(language: string): string {
	const map: Record<string, string> = {
		TypeScript: "TS",
		JavaScript: "JS",
		Python: "PY",
		Java: "JV",
		TSX: "TSX",
		JSX: "JSX",
	};
	return map[language] ?? language.slice(0, 2).toUpperCase();
}
