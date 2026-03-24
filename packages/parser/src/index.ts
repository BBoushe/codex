/**
 * @fileoverview Public API for the parser package.
 *
 * The main entry point is `parseProject()`, which orchestrates the full
 * two-pass pipeline: file discovery → per-file AST visiting → cross-file linking.
 *
 * ## Usage
 * ```ts
 * import { parseProject } from "@codex/parser";
 *
 * const result = await parseProject("/path/to/repo");
 * // result.files    — array of FileParseResult (ready for graph-client)
 * // result.stats    — summary of what was parsed and linked
 * ```
 */

import { readFile } from "node:fs/promises";
import type { FileParseResult } from "@codex/shared";
import { LanguageService } from "./languageService";
import { walkDirectory, type WalkOptions, type SourceFile } from "./fileWalker";
import { TypeScriptVisitor } from "./visitors/tsVisitor";
import { JavaVisitor } from "./visitors/javaVisitor";
import { PythonVisitor } from "./visitors/pyVisitor";
import { ImportResolver } from "./importResolver";
import { linkAll, type LinkStats } from "./linker";
import type { Visitor, VisitorFileResult } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ParseProjectOptions extends WalkOptions {
	/** Whether to resolve tsconfig path aliases. @default true */
	useTsconfigPaths?: boolean;
	/** Called after each file is processed during the AST-parsing phase. */
	onProgress?: (parsed: number, total: number) => void;
}

export interface ParseProjectResult {
	/** Fully linked parse results, one per file. Ready for graph-client insertion. */
	files: FileParseResult[];
	stats: ParseProjectStats;
}

export interface ParseProjectStats {
	/** Number of source files discovered. */
	filesFound: number;
	/** Number of files successfully parsed. */
	filesParsed: number;
	/** Number of files that failed to parse (logged as warnings). */
	filesFailed: number;
	/** Total entities (nodes) extracted across all files. */
	totalEntities: number;
	/** Total intra-file relationships extracted. */
	totalRelationships: number;
	/** Linking statistics (cross-file resolution). */
	linking: LinkStats;
	/** File walker timing. */
	walkDurationMs: number;
	/** AST parsing + visiting timing. */
	parseDurationMs: number;
	/** Linking timing. */
	linkDurationMs: number;
	/** Total pipeline timing. */
	totalDurationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visitor dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the appropriate visitor for a file extension.
 * Currently only TypeScript/JavaScript is implemented; Python and Java
 * visitors will be added here when ready.
 */
function getVisitor(extension: string): Visitor | null {
	switch (extension) {
		case ".ts":
		case ".tsx":
		case ".js":
		case ".jsx":
			return new TypeScriptVisitor();
		case ".py":
			return new PythonVisitor();
		case ".java":
			return new JavaVisitor();
		default:
			return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses an entire project: discovers files, extracts AST entities and
 * relationships, and resolves cross-file references.
 *
 * @param rootDir - Absolute path to the repository root.
 * @param options - Optional configuration for file walking and resolution.
 * @returns Fully linked parse results and summary statistics.
 */
export async function parseProject(
	rootDir: string,
	options?: ParseProjectOptions,
): Promise<ParseProjectResult> {
	const totalStart = Date.now();

	// ── Phase 1: File discovery ───────────────────────────────────────
	const walkResult = await walkDirectory(rootDir, options);
	const walkDurationMs = walkResult.durationMs;

	console.log(
		`[parser] Discovered ${walkResult.files.length} source files ` +
			`(${walkResult.directoriesVisited} dirs, ${walkResult.filesSkipped} skipped, ${walkDurationMs}ms)`,
	);

	// ── Phase 2: Per-file AST parsing & visiting ──────────────────────
	const parseStart = Date.now();
	const languageService = await LanguageService.create();
	const visitorResults: VisitorFileResult[] = [];
	let filesFailed = 0;

	for (const file of walkResult.files) {
		try {
			const result = await parseFile(file, languageService);
			if (result) visitorResults.push(result);
		} catch (err) {
			filesFailed++;
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[parser] Failed to parse ${file.relativePath}: ${msg}`);
		}
		options?.onProgress?.(visitorResults.length + filesFailed, walkResult.files.length);
	}

	const parseDurationMs = Date.now() - parseStart;
	const totalEntitiesBeforeLink = visitorResults.reduce(
		(sum, r) => sum + r.entities.length,
		0,
	);
	const totalRelsBeforeLink = visitorResults.reduce(
		(sum, r) => sum + r.relationships.length,
		0,
	);

	console.log(
		`[parser] Parsed ${visitorResults.length} files → ` +
			`${totalEntitiesBeforeLink} entities, ${totalRelsBeforeLink} relationships ` +
			`(${filesFailed} failed, ${parseDurationMs}ms)`,
	);

	// ── Phase 3: Cross-file linking ───────────────────────────────────
	const linkStart = Date.now();
	const knownFiles = new Set(walkResult.files.map((f) => f.relativePath));
	const resolver = new ImportResolver({
		rootDir,
		knownFiles,
		useTsconfigPaths: options?.useTsconfigPaths,
	});

	const { results: linkedResults, stats: linkStats } = linkAll(
		visitorResults,
		resolver,
	);
	const linkDurationMs = Date.now() - linkStart;

	const totalRelsFinal = linkedResults.reduce(
		(sum, r) => sum + r.relationships.length,
		0,
	);

	console.log(
		`[parser] Linked → ${linkStats.edgesCreated} cross-file edges ` +
			`(${totalRelsFinal} total relationships)`,
	);
	console.log(
		`[parser]   imports: ${linkStats.importsResolved} resolved, ${linkStats.importsFailed} failed`,
	);
	console.log(
		`[parser]   calls:   ${linkStats.callsResolved} resolved, ${linkStats.callsFailed} failed`,
	);
	console.log(
		`[parser]   renders: ${linkStats.rendersResolved} resolved, ${linkStats.rendersFailed} failed`,
	);

	return {
		files: linkedResults,
		stats: {
			filesFound: walkResult.files.length,
			filesParsed: visitorResults.length,
			filesFailed,
			totalEntities: totalEntitiesBeforeLink,
			totalRelationships: totalRelsFinal,
			linking: linkStats,
			walkDurationMs,
			parseDurationMs,
			linkDurationMs,
			totalDurationMs: Date.now() - totalStart,
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-file parsing helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses a single file: reads source, runs Tree-sitter, then visits the CST.
 *
 * @returns The visitor result, or `null` if no visitor exists for the language.
 */
async function parseFile(
	file: SourceFile,
	languageService: LanguageService,
): Promise<VisitorFileResult | null> {
	const visitor = getVisitor(file.extension);
	if (!visitor) return null;

	const sourceCode = await readFile(file.absolutePath, "utf-8");
	const tree = await languageService.parse(sourceCode, file.extension);

	return visitor.visit(tree, sourceCode, file);
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports for consumer convenience
// ─────────────────────────────────────────────────────────────────────────────

export { walkDirectory } from "./fileWalker";
export { LanguageService } from "./languageService";
export { TypeScriptVisitor } from "./visitors/tsVisitor";
export { JavaVisitor } from "./visitors/javaVisitor";
export { PythonVisitor } from "./visitors/pyVisitor";
export { ImportResolver } from "./importResolver";
export { linkAll } from "./linker";
export type { SourceFile, WalkResult } from "./fileWalker";
export type { Visitor, VisitorFileResult } from "./types";
export type { LinkResult, LinkStats } from "./linker";
