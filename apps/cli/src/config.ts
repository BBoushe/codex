/**
 * @fileoverview Persistent CLI configuration stored at ~/.codex/config.json.
 *
 * Saves the user's last-used project path so commands don't require re-typing it.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export interface CodexConfig {
	/** Absolute path to the last-used project directory. */
	projectPath?: string;
}

const CONFIG_DIR = join(os.homedir(), ".codex");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export const configFilePath = CONFIG_FILE;

export function loadConfig(): CodexConfig {
	try {
		const raw = readFileSync(CONFIG_FILE, "utf-8");
		return JSON.parse(raw) as CodexConfig;
	} catch {
		return {};
	}
}

export function saveConfig(update: Partial<CodexConfig>): void {
	mkdirSync(CONFIG_DIR, { recursive: true });
	const existing = loadConfig();
	writeFileSync(
		CONFIG_FILE,
		JSON.stringify({ ...existing, ...update }, null, 2),
	);
}
