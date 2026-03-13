/**
 * @fileoverview Tree-sitter initialization and language grammar management.
 *
 * Loads the `web-tree-sitter` WASM runtime and provides pre-configured
 * parsers for each supported language. All consumers go through
 * `LanguageService` rather than initializing Tree-sitter directly.
 *
 * ## Usage
 * ```ts
 * const service = await LanguageService.create();
 * const tree = service.parse("const x = 1;", ".ts");
 * ```
 *
 * ## WASM Loading
 * Grammar `.wasm` files are resolved relative to this source file's directory
 * using `import.meta.dir` (Bun built-in). The expected layout:
 *
 *   packages/parser/
 *   ├── grammars/
 *   │   ├── tree-sitter-typescript.wasm
 *   │   ├── tree-sitter-tsx.wasm
 *   │   ├── tree-sitter-javascript.wasm
 *   │   ├── tree-sitter-python.wasm
 *   │   └── tree-sitter-java.wasm
 *   └── src/
 *       └── language-service.ts   ← this file
 *
 * TODO: In the future, we might want to support concurrent parsing. Use a pool.
 */

import { join, resolve } from "node:path";
import { Parser, Language, type Tree } from "web-tree-sitter";
import { Language as CodexLanguage } from "@codex/shared";

export type { Tree, Node, Point } from "web-tree-sitter";

// ─────────────────────────────────────────────────────────────────────────────
// Grammar file mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps file extensions to the CODEX language enum and grammar WASM filename.
 *
 * TSX gets its own grammar (not the same as TypeScript) because JSX
 * introduces additional CST node types (`jsx_element`, `jsx_fragment`, etc.)
 * that the plain TypeScript grammar doesn't recognize.
 */
interface GrammarMapping {
	language: CodexLanguage;
	wasmFile: string;
}

const EXTENSION_TO_GRAMMAR: Record<string, GrammarMapping> = {
	".ts": {
		language: CodexLanguage.TypeScript,
		wasmFile: "tree-sitter-typescript.wasm",
	},
	".tsx": {
		language: CodexLanguage.TypeScript,
		wasmFile: "tree-sitter-tsx.wasm",
	},
	".js": {
		language: CodexLanguage.JavaScript,
		wasmFile: "tree-sitter-javascript.wasm",
	},
	".jsx": {
		language: CodexLanguage.JavaScript,
		wasmFile: "tree-sitter-javascript.wasm",
	},
	".py": {
		language: CodexLanguage.Python,
		wasmFile: "tree-sitter-python.wasm",
	},
	".java": { language: CodexLanguage.Java, wasmFile: "tree-sitter-java.wasm" },
};

/** All file extensions we can parse. Used by the file walker to filter. */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_TO_GRAMMAR);

/**
 * Returns true if the file extension is one we have a grammar for.
 * @param ext - Extension including the dot, e.g. ".tsx"
 */
export function isSupportedExtension(ext: string): boolean {
	return ext in EXTENSION_TO_GRAMMAR;
}

/**
 * Returns the `Language` enum value for a given file extension.
 * @throws If the extension is not supported.
 */
export function languageFromExtension(ext: string): CodexLanguage {
	const mapping = EXTENSION_TO_GRAMMAR[ext];
	if (!mapping) {
		throw new Error(`Unsupported file extension: "${ext}"`);
	}
	return mapping.language;
}

// ─────────────────────────────────────────────────────────────────────────────
// LanguageService
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages Tree-sitter parser instances for all supported languages.
 *
 * Use the async `create()` factory — the constructor is private because
 * `web-tree-sitter` requires an async `init()` call before any parsing.
 */
export class LanguageService {
	/** Cached Tree-sitter Language objects, keyed by WASM filename. */
	private readonly languages = new Map<string, Language>();
	/** Reusable parser instance (Tree-sitter parsers are stateful but can switch languages). */
	private readonly parser: Parser;
	/** Absolute path to the grammars/ directory. */
	private readonly grammarsDir: string;

	private constructor(parser: Parser, grammarsDir: string) {
		this.parser = parser;
		this.grammarsDir = grammarsDir;
	}

	/**
	 * Creates and initializes a `LanguageService`.
	 *
	 * @param grammarsDir - Optional override for the grammars directory path.
	 *   Defaults to `../grammars/` relative to this source file.
	 */
	static async create(grammarsDir?: string): Promise<LanguageService> {
		await Parser.init();

		const resolvedDir =
			grammarsDir ?? resolve(join(import.meta.dir, "..", "grammars"));
		const parser = new Parser();

		return new LanguageService(parser, resolvedDir);
	}

	/**
	 * Parses source code using the grammar appropriate for the given file extension.
	 *
	 * @param sourceCode - The full file contents as a string.
	 * @param extension  - File extension including the dot (e.g. ".tsx", ".py").
	 * @returns The Tree-sitter parse tree.
	 * @throws If the extension is not supported, the grammar fails to load,
	 *   or Tree-sitter returns null (e.g. no language set).
	 */
	async parse(sourceCode: string, extension: string): Promise<Tree> {
		const mapping = EXTENSION_TO_GRAMMAR[extension];
		if (!mapping) {
			throw new Error(
				`LanguageService.parse: unsupported extension "${extension}". ` +
					`Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
			);
		}

		const language = await this.loadLanguage(mapping.wasmFile);
		this.parser.setLanguage(language);

		const tree = this.parser.parse(sourceCode);
		if (!tree) {
			throw new Error(
				`LanguageService.parse: Tree-sitter returned null for extension "${extension}". ` +
					`This typically means the language was not set correctly.`,
			);
		}

		return tree;
	}

	/**
	 * Returns the CODEX `Language` enum value for a given file extension.
	 * Convenience wrapper around the module-level function.
	 */
	languageFor(extension: string): CodexLanguage {
		return languageFromExtension(extension);
	}

	/**
	 * Loads a Tree-sitter Language from a WASM file, with caching.
	 * Each grammar is loaded at most once per `LanguageService` lifetime.
	 */
	private async loadLanguage(wasmFile: string): Promise<Language> {
		const cached = this.languages.get(wasmFile);
		if (cached) return cached;

		const wasmPath = join(this.grammarsDir, wasmFile);
		const language = await Language.load(wasmPath);
		this.languages.set(wasmFile, language);

		return language;
	}
}
