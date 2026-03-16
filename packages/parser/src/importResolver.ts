/**
 * @fileoverview Import specifier resolution.
 *
 * Resolves JavaScript/TypeScript import specifiers to actual file paths
 * within the parsed codebase. Handles:
 *
 *   1. **Relative paths** — `./foo`, `../bar/baz`
 *   2. **tsconfig path aliases** — `@/components/Button`, `@utils/format`
 *   3. **Extension resolution** — `./foo` → `foo.ts`, `foo.tsx`, `foo/index.ts`, etc.
 *   4. **Barrel files** — `./api` → `api/index.ts`
 *
 * Bare specifiers (npm packages like `"react"`, `"lodash"`) are identified
 * and skipped — they don't resolve to files in the codebase.
 *
 * ## Design
 * Resolution is performed against an in-memory `Set<string>` of known file
 * paths (from the file walker), not the filesystem. This is fast, deterministic,
 * and avoids redundant I/O.
 *
 * ## tsconfig handling
 * The resolver reads `tsconfig.json` from the repo root (following `extends`
 * chains up to a depth limit) and compiles `compilerOptions.paths` into a
 * list of prefix patterns. Resolution attempts alias substitution before
 * falling back to "unresolvable."
 */

import { readFileSync } from "node:fs";
import { join, dirname, resolve, relative, normalize } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A compiled tsconfig path alias rule. */
interface PathAlias {
	/** The prefix to match (e.g. `"@/"` from `"@/*"`). */
	prefix: string;
	/** The suffix to match (e.g. `""` from `"@/*"`, or `""` from `"@utils"`). */
	suffix: string;
	/**
	 * Replacement prefixes (e.g. `["src/"]` from `["src/*"]`).
	 * Multiple entries = multiple resolution candidates (tried in order).
	 */
	replacements: string[];
}

export interface ImportResolverConfig {
	/** Absolute path to the repository root. */
	rootDir: string;
	/** Relative paths of all known source files (from the file walker). */
	knownFiles: Set<string>;
	/**
	 * Whether to load and apply tsconfig path aliases.
	 * @default true
	 */
	useTsconfigPaths?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extensions to try when resolving extensionless imports.
 * Order matters — `.ts` before `.js` reflects TypeScript project conventions.
 */
const TRY_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/**
 * Index file variants to try when the specifier points to a directory.
 */
const TRY_INDEX_FILES = TRY_EXTENSIONS.map((ext) => `/index${ext}`);

/** Maximum depth for following tsconfig `extends` chains. */
const MAX_EXTENDS_DEPTH = 5;

// ─────────────────────────────────────────────────────────────────────────────
// ImportResolver
// ─────────────────────────────────────────────────────────────────────────────

export class ImportResolver {
	private readonly rootDir: string;
	private readonly knownFiles: Set<string>;
	private readonly pathAliases: PathAlias[];
	private readonly baseUrl: string;

	constructor(config: ImportResolverConfig) {
		this.rootDir = config.rootDir;
		this.knownFiles = config.knownFiles;

		if (config.useTsconfigPaths !== false) {
			const tsconfig = this.loadTsconfig(join(config.rootDir, "tsconfig.json"));
			this.pathAliases = tsconfig.aliases;
			this.baseUrl = tsconfig.baseUrl;
		} else {
			this.pathAliases = [];
			this.baseUrl = config.rootDir;
		}
	}

	/**
	 * Resolves an import specifier to a relative file path within the codebase.
	 *
	 * @param specifier - The raw import specifier (e.g. `"./api/user"`, `"@/utils/format"`).
	 * @param fromFile  - The relative path of the file containing the import.
	 * @returns The resolved relative file path, or `null` if the import cannot
	 *   be resolved (external package, missing file, etc.).
	 *
	 * @example
	 * ```ts
	 * resolver.resolve("./api/user", "src/components/UserCard.tsx")
	 * // => "src/api/user.ts"
	 *
	 * resolver.resolve("react", "src/components/UserCard.tsx")
	 * // => null (external package)
	 *
	 * resolver.resolve("@/utils/format", "src/components/UserCard.tsx")
	 * // => "src/utils/format.ts" (via tsconfig alias)
	 * ```
	 */
	resolve(specifier: string, fromFile: string): string | null {
		// ── 1. Relative imports ─────────────────────────────────────────
		if (specifier.startsWith(".")) {
			const fromDir = dirname(fromFile);
			const candidate = normalize(join(fromDir, specifier));
			return this.tryResolveFile(candidate);
		}

		// ── 2. tsconfig path aliases ────────────────────────────────────
		const aliasResult = this.tryResolveAlias(specifier);
		if (aliasResult) return aliasResult;

		// ── 3. Bare specifier (external package) → skip ─────────────────
		return null;
	}

	/**
	 * Returns true if the specifier looks like a bare module specifier
	 * (i.e., an npm package, not a relative or aliased import).
	 *
	 * Useful for the linker to distinguish "couldn't resolve" from
	 * "intentionally external."
	 */
	isBareSpecifier(specifier: string): boolean {
		if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
		// Check if it matches any tsconfig alias
		for (const alias of this.pathAliases) {
			if (
				specifier.startsWith(alias.prefix) &&
				specifier.endsWith(alias.suffix)
			) {
				return false;
			}
		}
		return true;
	}

	/** Returns the parsed path aliases for debugging/logging. */
	getPathAliases(): ReadonlyArray<Readonly<PathAlias>> {
		return this.pathAliases;
	}

	// ── Resolution helpers ────────────────────────────────────────────

	/**
	 * Given a base path (without extension), tries to find a matching
	 * known file by appending extensions or trying index files.
	 *
	 * @param basePath - Relative path without extension (e.g. `"src/api/user"`).
	 * @returns The matching relative file path, or `null`.
	 */
	private tryResolveFile(basePath: string): string | null {
		const normalized = normalize(basePath);

		// Exact match (import already includes extension)
		if (this.knownFiles.has(normalized)) return normalized;

		// Try appending extensions: ./foo → ./foo.ts, ./foo.tsx, etc.
		for (const ext of TRY_EXTENSIONS) {
			const withExt = normalized + ext;
			if (this.knownFiles.has(withExt)) return withExt;
		}

		// Try index files: ./foo → ./foo/index.ts, ./foo/index.tsx, etc.
		for (const indexFile of TRY_INDEX_FILES) {
			const withIndex = normalized + indexFile;
			if (this.knownFiles.has(withIndex)) return withIndex;
		}

		return null;
	}

	/**
	 * Attempts to resolve a specifier via tsconfig path aliases.
	 *
	 * For a paths config like `{ "@/*": ["src/*"] }`:
	 *   - `@/utils/format` → prefix `"@/"` matches → substitute → `"src/utils/format"`
	 *   - Then resolved like a normal file path via `tryResolveFile`
	 *
	 * Multiple replacement values are tried in order (first match wins).
	 */
	private tryResolveAlias(specifier: string): string | null {
		for (const alias of this.pathAliases) {
			if (!specifier.startsWith(alias.prefix)) continue;
			if (alias.suffix && !specifier.endsWith(alias.suffix)) continue;

			// Extract the wildcard portion from the specifier
			const wildcardStart = alias.prefix.length;
			const wildcardEnd = alias.suffix
				? specifier.length - alias.suffix.length
				: specifier.length;
			const wildcardValue = specifier.slice(wildcardStart, wildcardEnd);

			// Try each replacement pattern
			for (const replacement of alias.replacements) {
				const resolved = replacement + wildcardValue;
				// Resolve relative to baseUrl
				const fromRoot = relative(
					this.rootDir,
					resolve(this.baseUrl, resolved),
				);
				const result = this.tryResolveFile(fromRoot);
				if (result) return result;
			}
		}

		return null;
	}

	// ── tsconfig parsing ──────────────────────────────────────────────

	/**
	 * Loads a tsconfig.json file, following `extends` chains, and extracts
	 * `compilerOptions.baseUrl` and `compilerOptions.paths`.
	 *
	 * Uses a simple JSONC (JSON with comments) strip before parsing.
	 */
	private loadTsconfig(
		tsconfigPath: string,
		depth = 0,
	): { baseUrl: string; aliases: PathAlias[] } {
		const defaultResult = { baseUrl: this.rootDir, aliases: [] as PathAlias[] };

		if (depth > MAX_EXTENDS_DEPTH) {
			console.warn(
				`[import-resolver] tsconfig extends chain exceeded ${MAX_EXTENDS_DEPTH} levels, stopping`,
			);
			return defaultResult;
		}

		let raw: string;
		try {
			raw = readFileSync(tsconfigPath, "utf-8");
		} catch {
			// tsconfig.json doesn't exist — not an error
			if (depth === 0) {
				// Only warn at the root level; nested missing configs are fine
			}
			return defaultResult;
		}

		let parsed: TsconfigJson;
		try {
			parsed = JSON.parse(stripJsonComments(raw)) as TsconfigJson;
		} catch (err) {
			console.warn(
				`[import-resolver] Failed to parse ${tsconfigPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return defaultResult;
		}

		// ── Follow extends chain ────────────────────────────────────────
		let inherited = defaultResult;
		if (parsed.extends) {
			const parentPath = resolve(dirname(tsconfigPath), parsed.extends);
			// If the extends target doesn't have .json extension, try appending it
			const resolvedParent = parentPath.endsWith(".json")
				? parentPath
				: parentPath + ".json";
			inherited = this.loadTsconfig(resolvedParent, depth + 1);
		}

		// ── Extract compilerOptions ─────────────────────────────────────
		const compilerOptions = parsed.compilerOptions ?? {};
		const tsconfigDir = dirname(tsconfigPath);

		const baseUrl = compilerOptions.baseUrl
			? resolve(tsconfigDir, compilerOptions.baseUrl)
			: inherited.baseUrl;

		const paths = compilerOptions.paths ?? {};
		const aliases: PathAlias[] =
			Object.keys(paths).length > 0
				? this.compilePaths(paths)
				: inherited.aliases;

		return { baseUrl, aliases };
	}

	/**
	 * Compiles the `compilerOptions.paths` record into a list of `PathAlias`
	 * objects that can be efficiently matched against import specifiers.
	 *
	 * Handles both wildcard patterns (`"@/*": ["src/*"]`) and exact patterns
	 * (`"@utils": ["src/utils/index"]`).
	 */
	private compilePaths(paths: Record<string, string[]>): PathAlias[] {
		const aliases: PathAlias[] = [];

		for (const [pattern, targets] of Object.entries(paths)) {
			const starIndex = pattern.indexOf("*");

			if (starIndex === -1) {
				// Exact match: `"@utils": ["src/utils/index"]`
				aliases.push({
					prefix: pattern,
					suffix: "",
					replacements: targets.map((t) => t.replace(/\*/g, "")),
				});
			} else {
				// Wildcard: `"@/*": ["src/*"]`
				const prefix = pattern.slice(0, starIndex);
				const suffix = pattern.slice(starIndex + 1);
				const replacements = targets.map((t) => {
					const tStarIndex = t.indexOf("*");
					return tStarIndex === -1 ? t : t.slice(0, tStarIndex);
				});
				aliases.push({ prefix, suffix, replacements });
			}
		}

		// Sort by prefix length descending — more specific aliases first
		aliases.sort((a, b) => b.prefix.length - a.prefix.length);

		return aliases;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// tsconfig JSON shape (minimal, only the fields we care about)
// ─────────────────────────────────────────────────────────────────────────────

interface TsconfigJson {
	extends?: string;
	compilerOptions?: {
		baseUrl?: string;
		paths?: Record<string, string[]>;
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONC utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strips single-line (`//`) and multi-line comments from a JSON string.
 *
 * tsconfig.json officially supports JSONC (JSON with Comments), but
 * `JSON.parse` does not. This function handles the common cases without
 * pulling in a full JSONC parser.
 *
 * Handles comments inside strings correctly by tracking quote state.
 */
function stripJsonComments(jsonc: string): string {
	let result = "";
	let i = 0;
	let inString = false;
	let escapeNext = false;

	while (i < jsonc.length) {
		const char = jsonc[i]!;
		const next = jsonc[i + 1];

		if (escapeNext) {
			result += char;
			escapeNext = false;
			i++;
			continue;
		}

		if (inString) {
			if (char === "\\") {
				escapeNext = true;
				result += char;
			} else if (char === '"') {
				inString = false;
				result += char;
			} else {
				result += char;
			}
			i++;
			continue;
		}

		// Not in a string
		if (char === '"') {
			inString = true;
			result += char;
			i++;
		} else if (char === "/" && next === "/") {
			// Single-line comment: skip to end of line
			i += 2;
			while (i < jsonc.length && jsonc[i] !== "\n") i++;
		} else if (char === "/" && next === "*") {
			// Multi-line comment: skip to closing */
			i += 2;
			while (
				i < jsonc.length - 1 &&
				!(jsonc[i] === "*" && jsonc[i + 1] === "/")
			)
				i++;
			i += 2; // skip the closing */
		} else {
			result += char;
			i++;
		}
	}

	return result;
}
