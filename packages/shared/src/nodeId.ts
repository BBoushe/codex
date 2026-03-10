/**
 * @fileoverview Deterministic nodeId generation.
 *
 * `nodeId` is the stable cross-reference key between Neo4j and ChromaDB.
 * Every node in Neo4j and every vector in ChromaDB shares the same `nodeId`
 * for the same code entity, enabling lookups in either direction.
 *
 * ## Design decisions
 *
 * **Deterministic hash, not a UUID.**
 * Re-running the ingestion pipeline on the same codebase produces identical
 * nodeIds. This makes re-ingestion idempotent — Neo4j's MERGE and ChromaDB's
 * upsert both rely on the same stable key to update rather than duplicate.
 *
 * **Namespaced by NodeLabel.**
 * The label is included in the hash input so a `File` at `src/auth.ts` and a
 * `Function` named `src/auth.ts` (contrived but possible) never collide.
 *
 * **Typed factory functions, not a raw string hash.**
 * Each node type has its own factory that accepts exactly the fields that
 * uniquely identify it. This makes call sites self-documenting and prevents
 * the caller from forgetting a field.
 *
 * ## Collision probability
 * We use the first 16 hex characters of SHA-256 (64 bits of entropy).
 * For a codebase with 100,000 nodes the birthday-paradox collision
 * probability is ~2.7 × 10⁻¹⁰ — negligible.
 *
 * TODO: Add this in the thesis and how it compares to a UUIDv4's 122 bits of entropy.
 * And how it's calculated.
 */

import { createHash } from "node:crypto";
import { NodeLabel } from "./schema";

// -────────────────────────────────────────────────────────────────────────────
// Core hash primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Produces a 16-char (64bit) hex digest of the SHA-256 hash of
 * `label:field1:field2:...`
 */
function hashFields(label: NodeLabel, ...fields: string[]): string {
	const input = `${label}:${fields.join(":")}`;
	return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

// -────────────────────────────────────────────────────────────────────────────
// Typed factory functions
// -────────────────────────────────────────────────────────────────────────────

/**
 * nodeId for a `Directory` node.
 * @param path - relative path from repo root (e.g. "src/components")
 */
export function nodeIdForDirectory(path: string): string {
	return hashFields(NodeLabel.Directory, path);
}

/**
 * nodeId for "File" node.
 * @param filePath - relative path from repo root (e.g. "src/components/Button.tsx")
 */
export function nodeIdForFile(filePath: string): string {
	return hashFields(NodeLabel.File, filePath);
}

/**
 * nodeId for a `Function` node.
 * @param filePath - Relative path to the containing file.
 * @param name     - Function name as it appears in source.
 */
export function nodeIdForFunction(filePath: string, name: string): string {
	return hashFields(NodeLabel.Function, filePath, name);
}

/**
 * nodeId for a `Class` node.
 * @param filePath - Relative path to the containing file.
 * @param name     - Class name as it appears in source.
 */
export function nodeIdForClass(filePath: string, name: string): string {
	return hashFields(NodeLabel.Class, filePath, name);
}

/**
 * nodeId for a `Component` node.
 * @param filePath - Relative path to the containing file.
 * @param name     - Component name (PascalCase, as it appears in source).
 */
export function nodeIdForComponent(filePath: string, name: string): string {
	return hashFields(NodeLabel.Component, filePath, name);
}

/**
 * nodeId for a `Hook` node.
 *
 * Hooks are identified by the component that *uses* them plus their call-site
 * line, because the same hook (e.g. `useState`) may be called multiple times
 * in the same component.
 *
 * @param filePath      - Relative path to the containing file.
 * @param componentName - Name of the component that contains this hook call.
 * @param callSiteLine  - Line number of the hook invocation.
 */
export function nodeIdForHook(
	filePath: string,
	componentName: string,
	callSiteLine: number,
): string {
	return hashFields(
		NodeLabel.Hook,
		filePath,
		componentName,
		String(callSiteLine),
	);
}

/**
 * nodeId for a `Prop` node.
 *
 * Props are scoped to a component — two components can both accept a prop
 * named "onClick" and they must produce distinct nodeIds.
 *
 * @param filePath      - Relative path to the file where the component is defined.
 * @param componentName - Name of the component that declares this prop.
 * @param propName      - Prop name (e.g. "userId", "onClick").
 */
export function nodeIdForProp(
	filePath: string,
	componentName: string,
	propName: string,
): string {
	return hashFields(NodeLabel.Prop, filePath, componentName, propName);
}

/**
 * nodeId for a `Developer` node.
 * @param email - Git author email, used as the unique developer identifier.
 */
export function nodeIdForDeveloper(email: string): string {
	return hashFields(NodeLabel.Developer, email);
}

/**
 * nodeId for a `Commit` node.
 * @param sha - Full 40-character git commit SHA.
 */
export function nodeIdForCommit(sha: string): string {
	return hashFields(NodeLabel.Commit, sha);
}
