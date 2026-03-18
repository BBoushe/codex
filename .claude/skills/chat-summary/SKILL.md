---
name: chat-summary
description: Generate a concise markdown summary of the implementation steps completed in a session, including config decisions and caveats for future developers.
---


I'm building CODEX, a codebase analysis tool (bachelor's thesis). I have a running implementation progress document (.md) that tracks everything completed so far. I'll paste it at the start of each session as context in new chats.
When I finish a set of implementation steps in a session, generate a concise markdown block I can append to the progress document. 

Include: what was implemented, any config or code decisions made, and caveats that would trip up someone continuing the work. Do not include debugging history or errors — only the final working outcome. Keep it terse and precise, written for a developer picking up the project cold.

- Always use markdown formatting for the summary block.

# Expected Output Format

```md
Summary here
```