/**
 * @fileoverview Syntax-highlighted source code block using Shiki.
 *
 * Shiki is lazy-loaded on first render to avoid blocking the initial page load.
 * The highlighter instance is cached in module scope — it is initialised once
 * and reused for all subsequent highlights.
 */

import { useState, useEffect, useRef } from "react";
import type { Highlighter } from "shiki";

type ShikiLanguage = "typescript" | "javascript" | "python" | "java";

const LANGUAGE_MAP: Record<string, ShikiLanguage> = {
	TypeScript: "typescript",
	JavaScript: "javascript",
	Python: "python",
	Java: "java",
	TSX: "typescript",
	JSX: "javascript",
};

/** Singleton Shiki highlighter — initialised once, shared across all instances. */
let highlighterCache: Highlighter | null = null;
let highlighterLoading: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
	if (highlighterCache) return highlighterCache;
	if (highlighterLoading) return highlighterLoading;

	highlighterLoading = (async () => {
		const { createHighlighter } = await import("shiki");
		const h = await createHighlighter({
			themes: ["github-dark"],
			langs: ["typescript", "javascript", "python", "java"],
		});
		highlighterCache = h;
		return h;
	})();

	return highlighterLoading;
}

interface SourceViewerProps {
	/** Raw source code to highlight. */
	sourceCode: string;
	/** Language string from the File node (e.g. "TypeScript"). */
	language: string;
	/** First line of the entity in the source file (for line number display). */
	startLine?: number;
}

export function SourceViewer({ sourceCode, language, startLine = 1 }: SourceViewerProps) {
	const [html, setHtml] = useState<string | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		const lang: ShikiLanguage = LANGUAGE_MAP[language] ?? "typescript";

		getHighlighter().then((h) => {
			if (!mountedRef.current) return;
			const highlighted = h.codeToHtml(sourceCode, {
				lang,
				theme: "github-dark",
			});
			setHtml(highlighted);
		});

		return () => {
			mountedRef.current = false;
		};
	}, [sourceCode, language]);

	if (!html) {
		return (
			<pre className="text-xs font-mono text-[--color-text-muted] overflow-x-auto p-4 leading-5">
				{sourceCode}
			</pre>
		);
	}

	return (
		<div
			className="text-xs overflow-x-auto [&_pre]:p-4 [&_pre]:leading-5 [&_pre]:bg-transparent! [&_code]:font-mono"
			style={{ counterReset: `line ${startLine - 1}` }}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is safe
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
