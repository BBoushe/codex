# zustand fixture

This folder holds a clone of the official [zustand](https://github.com/pmndrs/zustand) codebase, used as a real-world fixture for parsing and RAG benchmarks. The clone itself is not committed; only this README is tracked.

To set it up, from the repo root:

```bash
rm packages/parser/fixtures/zustand/README.md   # git clone needs an empty folder
git clone https://github.com/pmndrs/zustand.git packages/parser/fixtures/zustand
# optional: pin the commit the benchmarks were written against
git -C packages/parser/fixtures/zustand checkout 00f96a389d4015ecf4eadb42aa1e4e0efe14bb95
```

Everything in this folder except this README is ignored by the parent repo's `.gitignore`.
