/**
 * @fileoverview Shiki-powered code block for use inside ReactMarkdown.
 *
 * Usage in ReactMarkdown:
 *   <ReactMarkdown components={{ code: ShikiCodeBlock }}>
 *
 * Inline code (no `className`) renders as a plain styled <code> tag.
 * Block code (`className="language-*"`) is syntax-highlighted via Shiki.
 */

import { useState, useEffect, useRef } from "react";
import { getHighlighter, normaliseLang } from "@/lib/shiki";

interface ShikiCodeBlockProps {
	className?: string;
	children?: React.ReactNode;
}

export function ShikiCodeBlock({ className, children }: ShikiCodeBlockProps) {
	const isBlock = className?.startsWith("language-");
	const code = String(children ?? "").trim();
	const lang = normaliseLang(className);

	const [html, setHtml] = useState<string | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		if (!isBlock) return;
		mountedRef.current = true;

		getHighlighter().then((h) => {
			if (!mountedRef.current) return;
			const highlighted = h.codeToHtml(code, {
				lang,
				theme: "github-dark",
			});
			setHtml(highlighted);
		});

		return () => {
			mountedRef.current = false;
		};
	}, [code, lang, isBlock]);

	if (!isBlock) {
		return (
			<code className="bg-[--color-surface-2] px-1 py-0.5 rounded text-[11px] font-mono">
				{children}
			</code>
		);
	}

	if (!html) {
		return (
			<pre className="bg-[--color-surface-2] rounded-lg p-3 text-xs font-mono overflow-x-auto leading-5">
				<code>{code}</code>
			</pre>
		);
	}

	return (
		<div
			className="text-xs [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:leading-5 [&_pre]:bg-transparent! [&_code]:font-mono"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is safe
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
