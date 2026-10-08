---
section: Changed
audience: internal
---

- Failed handler-verdict tests when `handleToolCall` threw and production swallowed it: `runHandlerExpectingNoThrow` (`tests/support/handler-verdict.ts`) wraps every direct call and the pi mock's `tool_call` hooks, and a governance sweep rejects an unchecked call (#3518, recurrence #4182).
