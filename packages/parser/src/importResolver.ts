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
const TRY_EXTENSIONS_TS = [".ts", ".tsx", ".js", ".jsx"];

/**
 * Index file variants to try when the specifier points to a directory.
 */
const TRY_INDEX_FILES_TS = TRY_EXTENSIONS_TS.map((ext) => `/index${ext}`);

/** Python index files. */
const TRY_INDEX_FILES_PY = ["/__init__.py"];

/** Java has no extensionless imports — the class name IS the file name. */
const TRY_EXTENSIONS_JAVA = [".java"];

/**
 * JDK package prefixes — imports starting with these are external.
 */
const JDK_PREFIXES = [
	"java.",
	"javax.",
	"sun.",
	"com.sun.",
	"jdk.",
	"org.w3c.",
	"org.xml.",
	"org.ietf.",
];

/**
 * Common Python standard library top-level modules (subset).
 * Used by isBareSpecifier to identify stdlib imports.
 */
const PYTHON_STDLIB = new Set([
	"abc", "argparse", "ast", "asyncio", "base64", "bisect", "builtins",
	"calendar", "cmath", "codecs", "collections", "concurrent", "configparser",
	"contextlib", "copy", "csv", "ctypes", "dataclasses", "datetime",
	"decimal", "difflib", "dis", "email", "enum", "errno", "fcntl",
	"fileinput", "fnmatch", "fractions", "functools", "gc", "getpass", "glob",
	"gzip", "hashlib", "heapq", "hmac", "html", "http", "importlib",
	"inspect", "io", "ipaddress", "itertools", "json", "keyword", "linecache",
	"locale", "logging", "lzma", "math", "mimetypes", "multiprocessing",
	"numbers", "operator", "os", "pathlib", "pdb", "pickle", "platform",
	"pprint", "queue", "random", "re", "readline", "reprlib", "secrets",
	"select", "shelve", "shlex", "shutil", "signal", "site", "socket",
	"sqlite3", "ssl", "stat", "statistics", "string", "struct", "subprocess",
	"sys", "sysconfig", "tempfile", "textwrap", "threading", "time",
	"timeit", "token", "tokenize", "traceback", "types", "typing",
	"unicodedata", "unittest", "urllib", "uuid", "venv", "warnings",
	"wave", "weakref", "webbrowser", "xml", "xmlrpc", "zipfile", "zipimport",
]);

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
		// Detect language from the importing file's extension
		const ext = this.getExtension(fromFile);

		if (ext === ".java") {
			return this.resolveJava(specifier);
		}
		if (ext === ".py") {
			return this.resolvePython(specifier, fromFile);
		}

		// ── TypeScript / JavaScript ─────────────────────────────────────

		// 1. Relative imports
		if (specifier.startsWith(".")) {
			const fromDir = dirname(fromFile);
			const candidate = normalize(join(fromDir, specifier));
			return this.tryResolveFile(candidate);
		}

		// 2. tsconfig path aliases
		const aliasResult = this.tryResolveAlias(specifier);
		if (aliasResult) return aliasResult;

		// 3. Bare specifier (external package) → skip
		return null;
	}

	/**
	 * Returns true if the specifier looks like a bare module specifier
	 * (i.e., an npm package, not a relative or aliased import).
	 *
	 * Useful for the linker to distinguish "couldn't resolve" from
	 * "intentionally external."
	 */
	/**
	 * Returns true if the specifier is external (npm package, JDK, stdlib).
	 * Accepts optional `fromFile` for language-aware detection.
	 */
	isBareSpecifier(specifier: string, fromFile?: string): boolean {
		const ext = fromFile ? this.getExtension(fromFile) : "";

		// Java: JDK packages are bare
		if (ext === ".java") {
			return JDK_PREFIXES.some((p) => specifier.startsWith(p));
		}

		// Python: stdlib top-level modules are bare, relative (.) are not
		if (ext === ".py") {
			if (specifier.startsWith(".")) return false;
			const topLevel = specifier.split(".")[0] ?? specifier;
			return PYTHON_STDLIB.has(topLevel);
		}

		// TypeScript/JavaScript
		if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
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

	/** Extracts file extension including the dot. */
	private getExtension(filePath: string): string {
		const lastDot = filePath.lastIndexOf(".");
		return lastDot >= 0 ? filePath.slice(lastDot) : "";
	}

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
		for (const ext of TRY_EXTENSIONS_TS) {
			const withExt = normalized + ext;
			if (this.knownFiles.has(withExt)) return withExt;
		}

		// Try index files: ./foo → ./foo/index.ts, ./foo/index.tsx, etc.
		for (const indexFile of TRY_INDEX_FILES_TS) {
			const withIndex = normalized + indexFile;
			if (this.knownFiles.has(withIndex)) return withIndex;
		}

		return null;
	}

	// ── Java resolution ──────────────────────────────────────────────

	/**
	 * Resolves a Java import specifier to a file path.
	 *
	 * Java imports are package-qualified: `com.example.models.Dog`
	 * maps to `com/example/models/Dog.java` (or under a `src/` prefix).
	 *
	 * Wildcard imports (`com.example.models.*`) resolve to the package
	 * directory but cannot be mapped to individual files.
	 */
	private resolveJava(specifier: string): string | null {
		// Skip JDK / external imports
		if (JDK_PREFIXES.some((p) => specifier.startsWith(p))) return null;

		// Strip wildcard suffix: `com.example.models.*` → `com.example.models`
		// Wildcard imports can't resolve to a specific file
		if (specifier.endsWith(".*")) return null;

		// Convert dots to path separators: com.example.models.Dog → com/example/models/Dog
		const pathFromPackage = specifier.replace(/\./g, "/");

		// Try with .java extension directly
		for (const ext of TRY_EXTENSIONS_JAVA) {
			const candidate = normalize(pathFromPackage + ext);
			if (this.knownFiles.has(candidate)) return candidate;
		}

		// Try with common source root prefixes
		const srcPrefixes = ["src/", "src/main/java/", "main/java/"];
		for (const prefix of srcPrefixes) {
			for (const ext of TRY_EXTENSIONS_JAVA) {
				const candidate = normalize(prefix + pathFromPackage + ext);
				if (this.knownFiles.has(candidate)) return candidate;
			}
		}

		return null;
	}

	// ── Python resolution ────────────────────────────────────────────

	/**
	 * Resolves a Python import specifier to a file path.
	 *
	 * Handles:
	 *   - Relative imports: `from .animal import Animal` → sibling file
	 *   - Parent-relative: `from ..util.formatter import capitalize`
	 *   - Absolute (project-internal): `from models.animal import Animal`
	 *
	 * Python module resolution:
	 *   - `foo.bar` → try `foo/bar.py` then `foo/bar/__init__.py`
	 *   - `.foo` (from `pkg/sub/mod.py`) → `pkg/sub/foo.py` or `pkg/sub/foo/__init__.py`
	 *   - `..foo` → `pkg/foo.py` or `pkg/foo/__init__.py`
	 */
	private resolvePython(specifier: string, fromFile: string): string | null {
		// Skip stdlib imports
		if (!specifier.startsWith(".")) {
			const topLevel = specifier.split(".")[0] ?? specifier;
			if (PYTHON_STDLIB.has(topLevel)) return null;
		}

		let basePath: string;

		if (specifier.startsWith(".")) {
			// Relative import: count leading dots for parent traversal
			let dots = 0;
			while (dots < specifier.length && specifier[dots] === ".") dots++;

			const modulePart = specifier.slice(dots); // e.g. "models.animal" or ""
			const fromDir = dirname(fromFile);

			// Each dot after the first goes up one directory
			// 1 dot = current package, 2 dots = parent, etc.
			let baseDir = fromDir;
			for (let i = 1; i < dots; i++) {
				baseDir = dirname(baseDir);
			}

			if (modulePart) {
				basePath = normalize(
					join(baseDir, modulePart.replace(/\./g, "/")),
				);
			} else {
				// `from . import X` → the __init__.py of the current package
				basePath = baseDir;
			}
		} else {
			// Absolute import within the project: `models.animal`
			basePath = normalize(specifier.replace(/\./g, "/"));
		}

		return this.tryResolvePythonFile(basePath);
	}

	/**
	 * Given a base path, tries to find a matching Python file:
	 *   1. Exact `.py` file
	 *   2. Package directory with `__init__.py`
	 */
	private tryResolvePythonFile(basePath: string): string | null {
		const normalized = normalize(basePath);

		// Exact match (already has .py extension)
		if (this.knownFiles.has(normalized)) return normalized;

		// Try foo.py
		const withPy = normalized + ".py";
		if (this.knownFiles.has(withPy)) return withPy;

		// Try foo/__init__.py (package)
		for (const indexFile of TRY_INDEX_FILES_PY) {
			const withInit = normalized + indexFile;
			if (this.knownFiles.has(withInit)) return withInit;
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
