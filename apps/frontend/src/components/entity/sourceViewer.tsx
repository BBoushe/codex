/**
 * @fileoverview Syntax-highlighted source code block using Shiki.
 *
 * Shiki is lazy-loaded on first render to avoid blocking the initial page load.
 * The highlighter instance is cached in module scope — it is initialised once
 * and reused for all subsequent highlights.
 */

import { useState, useEffect, useRef } from "react";
import { getHighlighter, normaliseLang } from "@/lib/shiki";

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
		const lang = normaliseLang(language);

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
