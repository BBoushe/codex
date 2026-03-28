/**
 * @fileoverview `codex ui` — launch the CODEX web UI (backend + frontend dev servers).
 *
 * Flow:
 *   1. Spawn `bun run dev:backend` (from repo root)
 *   2. Spawn `bun run dev:frontend` (from repo root)
 *   3. Poll GET /health on backend until ready (max 30s)
 *   4. Open browser to http://localhost:5173
 *   5. Show live status; Ctrl+C gracefully kills both processes
 */

import { useState, useEffect, useRef } from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Text, render, useApp } from "ink";
import { Layout } from "../ui/Layout.js";

// Resolve repo root (4 levels up from apps/cli/src/commands/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";
const HEALTH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

type Phase = "spawning" | "waiting" | "open" | "error";

function UiCommand() {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("spawning");
	const [statusLine, setStatusLine] = useState("Starting servers…");
	const [backendPid, setBackendPid] = useState<number | null>(null);
	const [frontendPid, setFrontendPid] = useState<number | null>(null);

	// Keep references for cleanup on exit
	const procsRef = useRef<ReturnType<typeof Bun.spawn>[]>([]);

	function cleanup() {
		for (const proc of procsRef.current) {
			try { proc.kill(); } catch { /* already dead */ }
		}
		exit();
	}

	useEffect(() => {
		// Register cleanup on SIGINT (Ctrl+C)
		const handler = () => cleanup();
		process.on("SIGINT", handler);

		run().catch((err) => {
			setStatusLine(err instanceof Error ? err.message : String(err));
			setPhase("error");
		});

		return () => {
			process.off("SIGINT", handler);
			for (const proc of procsRef.current) {
				try { proc.kill(); } catch { /* noop */ }
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function run() {
		setPhase("spawning");

		// Spawn backend
		const backend = Bun.spawn(["bun", "run", "dev:backend"], {
			cwd: REPO_ROOT,
			stdout: "ignore",
			stderr: "ignore",
		});
		procsRef.current.push(backend);
		setBackendPid(backend.pid);

		// Spawn frontend
		const frontend = Bun.spawn(["bun", "run", "dev:frontend"], {
			cwd: REPO_ROOT,
			stdout: "ignore",
			stderr: "ignore",
		});
		procsRef.current.push(frontend);
		setFrontendPid(frontend.pid);

		// Poll backend health
		setPhase("waiting");
		setStatusLine("Waiting for backend to start…");

		const deadline = Date.now() + HEALTH_TIMEOUT_MS;
		let ready = false;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`${BACKEND_URL}/health`, {
					signal: AbortSignal.timeout(1000),
				});
				if (res.ok) { ready = true; break; }
			} catch { /* not ready yet */ }
			await Bun.sleep(POLL_INTERVAL_MS);
		}

		if (!ready) {
			setStatusLine(`Backend did not respond within ${HEALTH_TIMEOUT_MS / 1000}s`);
			setPhase("error");
			return;
		}

		// Open browser
		Bun.spawn(["open", FRONTEND_URL], { stdout: "ignore", stderr: "ignore" });

		setPhase("open");
		setStatusLine("Running — press Ctrl+C to stop both servers");
	}

	return (
		<Layout showHeader={false} command="ui" showTokenTicker={false}>
			<Box flexDirection="column" paddingY={1} gap={1}>
				<Box gap={2}>
					<Text bold color="cyan">CODEX UI</Text>
					{phase === "spawning" && <Text color="yellow">⟳ spawning…</Text>}
					{phase === "waiting" && <Text color="yellow">⟳ waiting for backend…</Text>}
					{phase === "open" && <Text color="green">✓ ready</Text>}
					{phase === "error" && <Text color="red">✗ error</Text>}
				</Box>

				{(backendPid !== null || frontendPid !== null) && (
					<Box flexDirection="column" gap={0} paddingLeft={2}>
						{backendPid !== null && (
							<Text dimColor>backend  pid {backendPid}  →  {BACKEND_URL}</Text>
						)}
						{frontendPid !== null && (
							<Text dimColor>frontend pid {frontendPid}  →  {FRONTEND_URL}</Text>
						)}
					</Box>
				)}

				{phase === "open" && (
					<Box gap={2} paddingLeft={2}>
						<Text color="green">→</Text>
						<Text bold>{FRONTEND_URL}</Text>
					</Box>
				)}

				<Box marginTop={1}>
					<Text dimColor>{statusLine}</Text>
				</Box>
			</Box>
		</Layout>
	);
}

export function runUi() {
	render(<UiCommand />);
}
