/**
 * @fileoverview Shared Shiki highlighter singleton.
 *
 * Lazy-loaded on first use and cached for all subsequent renders.
 * Supports languages used across the codebase (TS, JS, Python, Java, etc.).
 */

import type { Highlighter } from "shiki";

let cache: Highlighter | null = null;
let loading: Promise<Highlighter> | null = null;

const SUPPORTED_LANGS = [
	"typescript",
	"javascript",
	"python",
	"java",
	"bash",
	"shell",
	"json",
	"yaml",
	"text",
] as const;

export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

export async function getHighlighter(): Promise<Highlighter> {
	if (cache) return cache;
	if (loading) return loading;

	loading = (async () => {
		const { createHighlighter } = await import("shiki");
		const h = await createHighlighter({
			themes: ["github-dark"],
			langs: [...SUPPORTED_LANGS],
		});
		cache = h;
		return h;
	})();

	return loading;
}

/** Normalise a raw language string to one Shiki knows. Falls back to "text". */
export function normaliseLang(raw: string | undefined): SupportedLang {
	if (!raw) return "text";
	const lower = raw.toLowerCase().replace("language-", "");
	const MAP: Record<string, SupportedLang> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		py: "python",
		sh: "bash",
		zsh: "bash",
		yml: "yaml",
	};
	if (MAP[lower]) return MAP[lower];
	if ((SUPPORTED_LANGS as readonly string[]).includes(lower))
		return lower as SupportedLang;
	return "text";
}
