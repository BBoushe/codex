#!/usr/bin/env bash
# test-real-world.sh — Clone a real-world repo and run the full CODEX pipeline.
#
# Usage:
#   ./scripts/test-real-world.sh [repo-url] [repo-name]
#
# Defaults to pmndrs/zustand (~12k LOC, pure TypeScript/React).
# Results are captured to scripts/test-results/<repo-name>-<timestamp>.log
#
# Requirements: git, bun, running Neo4j + ChromaDB (docker compose up -d)

set -euo pipefail

REPO_URL="${1:-https://github.com/delenov/Mabis.Frontend.git}"
REPO_NAME="${2:-Mabis.Frontend}"
WORK_DIR="/tmp/codex-test-${REPO_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/test-results"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${RESULTS_DIR}/${REPO_NAME}-${TIMESTAMP}.log"

mkdir -p "${RESULTS_DIR}"

echo "══════════════════════════════════════════════════════"
echo "  CODEX real-world pipeline test"
echo "  Repo:    ${REPO_URL}"
echo "  Target:  ${WORK_DIR}"
echo "  Log:     ${LOG_FILE}"
echo "══════════════════════════════════════════════════════"
echo ""

# ── Clone ──────────────────────────────────────────────────────────────────────
if [ -d "${WORK_DIR}/.git" ]; then
  echo "▶ Repo already cloned at ${WORK_DIR} — skipping clone"
else
  echo "▶ Cloning ${REPO_URL}…"
  git clone --depth=100 "${REPO_URL}" "${WORK_DIR}"
fi

# Count LOC for reference
LOC=$(find "${WORK_DIR}/src" -name "*.ts" -o -name "*.tsx" 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}' || echo "unknown")
echo "▶ Source LOC (src/): ${LOC}"
echo ""

# ── Run full pipeline ──────────────────────────────────────────────────────────
echo "▶ Running: codex analyze ${WORK_DIR} --clean"
echo ""

START_TIME=$(date +%s)

# Tee output to log file and terminal
# Use the CLI entrypoint directly (avoid the --watch root script).
bun run --cwd "${REPO_ROOT}" apps/cli/src/index.ts analyze "${WORK_DIR}" --clean 2>&1 | tee "${LOG_FILE}"

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "══════════════════════════════════════════════════════"
echo "  Wall-clock time: ${ELAPSED}s"
echo "  Full log: ${LOG_FILE}"
echo "══════════════════════════════════════════════════════"
echo ""

# ── Sample query to verify RAG ─────────────────────────────────────────────────
echo "▶ Running sample query to verify RAG pipeline…"
echo ""

bun run --cwd "${REPO_ROOT}" apps/cli/src/index.ts query "Explain the MBView architecture and its components" 2>&1 | tee -a "${LOG_FILE}"

echo ""
echo "▶ Done. Results saved to ${LOG_FILE}"
