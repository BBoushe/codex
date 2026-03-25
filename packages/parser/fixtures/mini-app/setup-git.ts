/**
 * @fileoverview Creates a realistic git history for the mini-app fixture.
 *
 * Run once from the repo root:
 *   bun run packages/parser/fixtures/mini-app/setup-git.ts
 *
 * What it does:
 *   1. Initialises a git repo inside fixtures/mini-app/
 *   2. Creates commits from three fake authors across multiple files
 *   3. Leaves enough history for DOA, blame, and Truck Factor to be meaningful
 *
 * Safe to re-run — removes any existing .git dir first.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const FIXTURE_DIR = path.join(import.meta.dir);

function git(cmd: string, env?: Record<string, string>) {
	execSync(`git -C "${FIXTURE_DIR}" ${cmd}`, {
		stdio: "pipe",
		env: { ...process.env, ...env },
	});
}

/** Returns an ISO-8601 date string for N days before now. */
function daysAgo(n: number): string {
	return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function gitCommit(message: string, author: { name: string; email: string }, date: string) {
	git(`commit -m "${message}" --allow-empty-message`, {
		GIT_AUTHOR_NAME: author.name,
		GIT_AUTHOR_EMAIL: author.email,
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_NAME: author.name,
		GIT_COMMITTER_EMAIL: author.email,
		GIT_COMMITTER_DATE: date,
	});
}

// ── Authors ───────────────────────────────────────────────────────────────────

const ALICE = { name: "Alice", email: "alice@example.com" };
const BOB   = { name: "Bob",   email: "bob@example.com" };
const CAROL = { name: "Carol", email: "carol@example.com" };

// ── Setup ─────────────────────────────────────────────────────────────────────

console.log("Setting up git repo in", FIXTURE_DIR);

// Remove any existing .git dir
const gitDir = path.join(FIXTURE_DIR, ".git");
if (fs.existsSync(gitDir)) {
	fs.rmSync(gitDir, { recursive: true, force: true });
	console.log("Removed existing .git directory");
}

// Init
git("init");
git("config user.email 'setup@codex.local'");
git("config user.name 'setup'");

// ── Commit 1 — Alice creates the project skeleton ────────────────────────────
git("add tsconfig.json");
gitCommit("chore: initial project setup", ALICE, daysAgo(150));

// ── Commit 2 — Alice creates the API layer ────────────────────────────────────
git("add src/api/");
gitCommit("feat(api): add user and posts API", ALICE, daysAgo(140));

// ── Commit 3 — Bob creates the base components ───────────────────────────────
git("add src/components/Button.tsx src/components/Avatar.tsx");
gitCommit("feat(ui): add Button and Avatar components", BOB, daysAgo(130));

// ── Commit 4 — Bob adds the layout components ─────────────────────────────────
git("add src/components/Header.tsx src/components/App.tsx src/components/index.ts");
gitCommit("feat(ui): add Header and App components", BOB, daysAgo(128));

// ── Commit 5 — Alice adds the data display components ────────────────────────
git("add src/components/UserCard.tsx src/components/PostCard.tsx src/components/PostList.tsx src/components/Modal.tsx");
gitCommit("feat(ui): add data display components", ALICE, daysAgo(110));

// ── Commit 6 — Carol adds hooks and utilities ─────────────────────────────────
git("add src/hooks/ src/utils/");
gitCommit("feat(hooks): add useUser hook and utilities", CAROL, daysAgo(95));

// ── Commit 7 — Bob fixes the Button component ─────────────────────────────────
// Simulate a small modification to Button.tsx to give Bob an extra commit on that file
const buttonPath = path.join(FIXTURE_DIR, "src/components/Button.tsx");
const buttonContent = fs.readFileSync(buttonPath, "utf8");
// Append a blank line + comment to simulate a real edit
fs.writeFileSync(buttonPath, buttonContent + "\n// accessibility fix\n");
git("add src/components/Button.tsx");
gitCommit("fix(Button): improve accessibility attributes", BOB, daysAgo(80));
// Restore original content so the fixture stays clean
fs.writeFileSync(buttonPath, buttonContent);
git("add src/components/Button.tsx");
gitCommit("refactor(Button): revert accidental whitespace", BOB, daysAgo(79));

// ── Commit 8 — Carol improves the useUser hook ───────────────────────────────
const useUserPath = path.join(FIXTURE_DIR, "src/hooks/useUser.ts");
const useUserContent = fs.readFileSync(useUserPath, "utf8");
fs.writeFileSync(useUserPath, useUserContent + "\n// error handling\n");
git("add src/hooks/useUser.ts");
gitCommit("feat(hooks): add error handling to useUser", CAROL, daysAgo(60));
fs.writeFileSync(useUserPath, useUserContent);
git("add src/hooks/useUser.ts");
gitCommit("refactor(hooks): clean up useUser whitespace", CAROL, daysAgo(59));

// ── Commit 9 — Alice updates the posts API ───────────────────────────────────
const postsPath = path.join(FIXTURE_DIR, "src/api/posts.ts");
const postsContent = fs.readFileSync(postsPath, "utf8");
fs.writeFileSync(postsPath, postsContent + "\n// pagination support\n");
git("add src/api/posts.ts");
gitCommit("feat(api): add pagination to fetchPosts", ALICE, daysAgo(50));
fs.writeFileSync(postsPath, postsContent);
git("add src/api/posts.ts");
gitCommit("refactor(api): clean up posts.ts", ALICE, daysAgo(49));

// ── Commit 10 — Alice adds a new API export (updates api/index.ts) ───────────
const apiIndexPath = path.join(FIXTURE_DIR, "src/api/index.ts");
const apiIndexContent = fs.readFileSync(apiIndexPath, "utf8");
fs.writeFileSync(apiIndexPath, apiIndexContent + "export type { PostSummary as Summary } from './posts';\n");
git("add src/api/index.ts");
gitCommit("feat(api): re-export PostSummary as Summary alias", ALICE, daysAgo(40));
fs.writeFileSync(apiIndexPath, apiIndexContent);
git("add src/api/index.ts");
gitCommit("refactor(api): revert alias re-export, keep canonical name", ALICE, daysAgo(39));

// ── Commit 11 — Bob adds a new component export (updates components/index.ts) ──
const compIndexPath = path.join(FIXTURE_DIR, "src/components/index.ts");
const compIndexContent = fs.readFileSync(compIndexPath, "utf8");
fs.writeFileSync(compIndexPath, compIndexContent + "export { Spinner } from './Spinner';\n");
git("add src/components/index.ts");
gitCommit("feat(ui): export Spinner from components barrel", BOB, daysAgo(30));
fs.writeFileSync(compIndexPath, compIndexContent);
git("add src/components/index.ts");
gitCommit("refactor(ui): revert Spinner export (component not ready)", BOB, daysAgo(29));

// ── Commit 12 — Carol adds a new hook export (updates hooks/index.ts) ────────
const hooksIndexPath = path.join(FIXTURE_DIR, "src/hooks/index.ts");
const hooksIndexContent = fs.readFileSync(hooksIndexPath, "utf8");
fs.writeFileSync(hooksIndexPath, hooksIndexContent + "export * from './usePosts';\n");
git("add src/hooks/index.ts");
gitCommit("feat(hooks): export usePosts from hooks barrel", CAROL, daysAgo(20));
fs.writeFileSync(hooksIndexPath, hooksIndexContent);
git("add src/hooks/index.ts");
gitCommit("refactor(hooks): revert usePosts export (wip)", CAROL, daysAgo(19));

// ── Commit 13 — Bob updates utils/index.ts with new export ───────────────────
const utilsIndexPath = path.join(FIXTURE_DIR, "src/utils/index.ts");
const utilsIndexContent = fs.readFileSync(utilsIndexPath, "utf8");
fs.writeFileSync(utilsIndexPath, utilsIndexContent + "export * from './debounce';\n");
git("add src/utils/index.ts");
gitCommit("feat(utils): export debounce utility from barrel", BOB, daysAgo(10));
fs.writeFileSync(utilsIndexPath, utilsIndexContent);
git("add src/utils/index.ts");
gitCommit("refactor(utils): revert debounce export (not implemented yet)", BOB, daysAgo(9));

console.log("\nDone! Git history:");
execSync(`git -C "${FIXTURE_DIR}" log --oneline --all`, { stdio: "inherit" });

console.log("\nContributors:");
execSync(`git -C "${FIXTURE_DIR}" shortlog -sn --all`, { stdio: "inherit" });
