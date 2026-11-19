# codex

Code Organization and Developer EXplorer

CODEX helps you understand an unfamiliar codebase by combining three views of it in one queryable system:

- **Structural**: Tree-sitter parses TypeScript/TSX, Java and Python into a code graph in Neo4j (files, functions, classes, components and their `CALLS`, `IMPORTS`, `RENDERS`, `DEFINED_IN`… edges).
- **Semantic**: graph entities are embedded into ChromaDB. A hybrid RAG pipeline finds anchors by vector search, then expands them with graph context.
- **Social**: Git history is mined for blame, Degree of Authorship (DOA), developer expertise, churn and truck factor.

Ask a question in plain language ("What renders `App`?", "Where is `useShallow` used?", "Who should I ask about the store?"). An intent classifier routes it to the structural, social or hybrid path, and an LLM writes the answer from the retrieved context. Graph and vector stores are linked by deterministic SHA-256 `nodeId`s.

It started as a bachelor thesis project.

## Layout

Bun/TypeScript monorepo:

| Path | What it is |
|---|---|
| `apps/cli` | `codex` CLI (Ink): ingest, mine, embed, query, launch the UI |
| `apps/backend` | ElysiaJS API (search, hybrid RAG, graph, entity routes) |
| `apps/frontend` | React UI: force graph, hierarchical edge bundling, file browser, chat, risk panel |
| `packages/parser` | Tree-sitter parsing, import resolution, cross-file linking |
| `packages/graph-client` | Neo4j schema, insertion, retrieval |
| `packages/vector-client` | Embedding pipeline and ChromaDB search |
| `packages/git-miner` | Blame mapping, DOA, truck factor, churn |
| `packages/rag` | Intent classifier, hybrid pipeline, context assembly, synthesis, benchmarks |
| `packages/shared` | Node IDs, schema types, LLM/embedding providers, token tracking |

## Getting started

Install dependencies and configure providers:

```bash
bun install
cp .env.example .env   # add an API key for SiliconFlow, OpenAI, Anthropic or Gemini
```

Start Neo4j and ChromaDB:

```bash
bun run infra:up
# verify it's working
docker compose ps
```

Analyze a repo and open the UI:

```bash
bun run apps/cli/src/index.ts analyze <path-to-repo> --serve   # ingest → mine → embed → serve
bun run apps/cli/src/index.ts query "What does App render?"
```

Or run the pieces separately:

```bash
bun run dev:backend    # API server (watch mode)
bun run dev:frontend   # web UI
bun run cli            # CLI (watch mode)
```

## Fixtures

The small fixtures in `packages/parser/fixtures/` (`mini-app`, `mini-java`, `mini-python`) are committed. The `zustand` fixture is a clone of the official zustand repo and is not committed. See [packages/parser/fixtures/zustand/README.md](packages/parser/fixtures/zustand/README.md) to set it up.

This project was created using `bun init` in bun v1.3.10. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
