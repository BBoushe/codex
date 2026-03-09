import { Elysia } from "elysia";

const app = new Elysia()
  .get("/health", () => ({ status: "ok" }))
  .listen(3000);

console.log(`CODEX backend running at http://localhost:3000`);