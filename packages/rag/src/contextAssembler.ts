/**
 * @fileoverview Context assembler for the hybrid RAG pipeline.
 *
 * Formats an ExpandedContext (graph expansion result) into structured text
 * suitable for LLM synthesis. Applies a character budget to prevent context
 * window overflow.
 *
 * Budget tiers:
 *   compact  — 8,000 chars  (~2K tokens)  Caller/callee names only, no neighbor source.
 *   standard — 24,000 chars (~6K tokens)  Target source + caller/callee source.
 *   full     — No limit.                  Everything included.
 *
 * Priority order (highest = included first, dropped last if over budget):
 *   1. Target entity source code (never dropped)
 *   2. Callers — name + file + source code
 *   3. Callees — name + file + source code
 *   4. Rendered components / hooks used — names + metadata
 *   5. Imported files — file paths only
 *   6. Developer context — names + DOA scores
 */

import type { ExpandedContext, RelatedEntity } from "@codex/graph-client";
import type {
	AssembledContext,
	ExpansionOptions,
	ContextBudget,
} from "./types.js";
import { BUDGET_LIMITS } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assembles a graph expansion into structured text for LLM synthesis.
 *
 * Applies the character budget from `options.budget` (default "standard").
 * Lower-priority sections are dropped entirely (not partially truncated)
 * when the budget is exceeded.
 */
export function assembleContext(
	expanded: ExpandedContext,
	options?: ExpansionOptions,
): AssembledContext {
	const budget: ContextBudget = options?.budget ?? "standard";
	const limit = BUDGET_LIMITS[budget];
	const referencedNodeIds: string[] = [expanded.target.nodeId];

	// ── 1. Target entity (always included) ───────────────────────────────────
	const targetSection = formatTarget(expanded);

	// ── 2-6. Optional sections in priority order ──────────────────────────────
	const callerSection = formatRelatedEntities(
		"Called by",
		expanded.callers,
		budget !== "compact",
		referencedNodeIds,
	);

	const calleeSection = formatRelatedEntities(
		"Calls",
		expanded.callees,
		budget !== "compact",
		referencedNodeIds,
	);

	const renderedSection = formatRelatedEntities(
		"Renders",
		expanded.renderedComponents,
		false, // names only
		referencedNodeIds,
	);

	const hooksSection = formatRelatedEntities(
		"Hooks Used",
		expanded.hooksUsed,
		false, // names only
		referencedNodeIds,
	);

	const importsSection = formatImports(expanded);
	const developerSection = formatDevelopers(expanded);

	// ── Assemble with budget enforcement ─────────────────────────────────────
	const sections: Array<{ text: string; priority: number }> = [
		{ text: callerSection, priority: 2 },
		{ text: calleeSection, priority: 3 },
		{ text: renderedSection, priority: 4 },
		{ text: hooksSection, priority: 4 },
		{ text: importsSection, priority: 5 },
		{ text: developerSection, priority: 6 },
	].sort((a, b) => a.priority - b.priority);

	let assembled = targetSection;
	let wasTruncated = false;

	const structuralParts: string[] = [];

	for (const { text } of sections) {
		if (!text) continue;
		const candidate = assembled + structuralParts.join("") + "\n" + text;
		if (candidate.length <= limit) {
			structuralParts.push("\n" + text);
		} else {
			wasTruncated = true;
			// Drop this entire section — no partial truncation
		}
	}

	if (structuralParts.length > 0) {
		assembled +=
			"\n\n=== STRUCTURAL CONTEXT ===\n" + structuralParts.join("").trimStart();
	}

	return {
		text: assembled,
		referencedNodeIds,
		charCount: assembled.length,
		wasTruncated,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Section formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatTarget(expanded: ExpandedContext): string {
	const { target, file } = expanded;
	const lang = file?.language ?? "Unknown";
	const filePath = file?.filePath ?? target.filePath ?? "Unknown";

	const lines: string[] = [
		"=== TARGET ENTITY ===",
		`Name: ${target.name}`,
		`Type: ${target.label}`,
		`File: ${filePath} (${lang})`,
		`Lines: ${target.startLine}-${target.endLine}`,
	];

	if (target.sourceCode) {
		lines.push("Source Code:");
		lines.push(target.sourceCode);
	}

	return lines.join("\n");
}

function formatRelatedEntities(
	heading: string,
	entities: RelatedEntity[],
	includeSource: boolean,
	referencedNodeIds: string[],
): string {
	if (entities.length === 0) {
		return `${heading}: (none)`;
	}

	const parts: string[] = [`${heading}:`];

	for (const entity of entities) {
		if (entity.nodeId) referencedNodeIds.push(entity.nodeId);

		const callSiteInfo =
			entity.callSiteLine != null ? ` [line ${entity.callSiteLine}]` : "";
		parts.push(
			`  - ${entity.name} (${entity.filePath}) [${entity.label}]${callSiteInfo}`,
		);

		if (includeSource && entity.sourceCode) {
			parts.push(`    Source: ${entity.sourceCode.split("\n")[0] ?? ""}`);
		}
	}

	return parts.join("\n");
}

function formatImports(expanded: ExpandedContext): string {
	const { importedFiles } = expanded;
	if (importedFiles.length === 0) return "";

	const paths = importedFiles.map((f) => f.filePath).join(", ");
	return `File Imports: ${paths}`;
}

function formatDevelopers(expanded: ExpandedContext): string {
	const { developers } = expanded;

	if (developers.length === 0) {
		return "=== DEVELOPER CONTEXT ===\n(No developer data available — run `codex mine` first)";
	}

	const lines: string[] = ["=== DEVELOPER CONTEXT ==="];

	const sorted = [...developers].sort((a, b) => b.doaScore - a.doaScore);
	for (const dev of sorted) {
		const firstAuthorTag = dev.isFirstAuthor ? " [first author]" : "";
		const lastContrib = dev.lastContribution
			? ` last: ${dev.lastContribution}`
			: "";
		lines.push(
			`  - ${dev.name} <${dev.email}> DOA=${dev.doaScore.toFixed(3)}${firstAuthorTag}${lastContrib}`,
		);
	}

	return lines.join("\n");
}
