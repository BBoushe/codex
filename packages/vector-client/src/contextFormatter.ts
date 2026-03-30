/**
 * @fileoverview Language-agnostic context formatter for embedding.
 *
 * Formats entity data into strings optimized for code embedding models.
 * Operates on `CodexNode` property shapes from `schema.ts` which are
 * identical across all supported languages (TypeScript, Python, Java).
 *
 * Format uses `[key: value]` bracket syntax — not language-specific comment
 * syntax — so the metadata header is truly language-neutral. The `sourceCode`
 * field passes through unchanged in whatever language it was written in.
 */

import type {
	RawEntityRecord,
	RawFunctionRecord,
	RawClassRecord,
	RawComponentRecord,
	RawHookRecord,
	RawFileRecord,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Joins an array with `, ` or returns null if empty/null. */
function joinArray(arr: string[] | null): string | null {
	if (!arr || arr.length === 0) return null;
	return arr.join(", ");
}

/** Appends a metadata line if the value is non-null and non-empty. */
function line(key: string, value: string | number | boolean | null): string {
	if (value === null || value === undefined || value === "") return "";
	return `[${key}: ${String(value)}]`;
}

/** Collects non-empty lines and joins with newlines. */
function buildHeader(lines: string[]): string {
	return lines.filter((l) => l.length > 0).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a raw Neo4j entity record into a context string for embedding.
 *
 * The output has two parts separated by a blank line:
 * 1. Metadata header in `[key: value]` bracket format
 * 2. Raw source code (when available)
 *
 * For custom hooks without sourceCode, the header IS the entire context string.
 *
 * @returns The formatted context string, or null if the entity cannot be embedded
 *          (e.g. missing critical fields).
 */
export function formatContextString(record: RawEntityRecord): string | null {
	switch (record.label) {
		case "Function":
			return formatFunction(record);
		case "Class":
			return formatClass(record);
		case "Component":
			return formatComponent(record);
		case "Hook":
			return formatHook(record);
		case "File":
			return formatFile(record);
		default:
			return assertNever(record);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-label formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatFunction(r: RawFunctionRecord): string | null {
	if (!r.sourceCode) return null;

	const header = buildHeader([
		line("file", r.filePath),
		line("language", r.language),
		line("function", r.name),
		line("parameters", joinArray(r.parameters)),
		line("returns", r.returnType),
		line("exported", r.isExported ? "yes" : "no"),
	]);

	return `${header}\n\n${r.sourceCode}`;
}

function formatClass(r: RawClassRecord): string | null {
	if (!r.sourceCode) return null;

	const header = buildHeader([
		line("file", r.filePath),
		line("language", r.language),
		line("class", r.name),
		line("methods", joinArray(r.methods)),
		line("extends", r.parentClass),
		line("exported", r.isExported ? "yes" : "no"),
	]);

	return `${header}\n\n${r.sourceCode}`;
}

function formatComponent(r: RawComponentRecord): string | null {
	if (!r.sourceCode) return null;

	const header = buildHeader([
		line("file", r.filePath),
		line("language", r.language),
		line("component", r.name),
		line("props", joinArray(r.props)),
		line("renders", joinArray(r.renderedComponents)),
		line("kind", r.componentKind),
		line("exported", r.isExported ? "yes" : "no"),
	]);

	return `${header}\n\n${r.sourceCode}`;
}

function formatHook(r: RawHookRecord): string | null {
	// Only embed custom hooks — built-in hooks are instances, not definitions
	if (r.hookType !== "custom") return null;

	const header = buildHeader([
		line("file", r.filePath),
		line("language", r.language),
		line("hook", r.name),
		line("type", "custom"),
		line("returns", joinArray(r.returnBindings)),
		line("dependencies", joinArray(r.dependencies)),
	]);

	// Custom hooks have no sourceCode field — the header IS the context
	if (r.sourceCode) {
		return `${header}\n\n${r.sourceCode}`;
	}
	return header;
}

/**
 * Formats a File node as metadata-only context (no source code).
 * Enables hybrid queries to find files by properties like size and churn.
 */
function formatFile(r: RawFileRecord): string | null {
	if (!r.filePath) return null;

	return buildHeader([
		line("file", r.filePath),
		line("language", r.language),
		line("lines of code", r.loc),
		line("extension", r.extension),
		line("total commits", r.totalCommits),
		line("churn rate per month", r.churnRate),
		line("lines added", r.totalAdded),
		line("lines deleted", r.totalDeleted),
	]);
}

function assertNever(_record: never): null {
	return null;
}
