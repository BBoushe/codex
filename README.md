# codex

Code Organization and Developer EXplorer

To install dependencies:

```bash
bun install
```

To start neo4j and chromaDB:

```bash
bun run infra:up
# verify it's working
docker compose ps
```

To run:

```bash
bun run dev:backend    # API server (watch mode)
bun run dev:frontend   # web UI
bun run cli            # CLI (watch mode)
```

## Fixtures

The small fixtures in `packages/parser/fixtures/` (`mini-app`, `mini-java`, `mini-python`) are committed. The `zustand` fixture is a clone of the official zustand repo and is not committed. See [packages/parser/fixtures/zustand/README.md](packages/parser/fixtures/zustand/README.md) to set it up.

This project was created using `bun init` in bun v1.3.10. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
