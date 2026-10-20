---
section: Changed
audience: internal
---

- The commit gate's `tool_call` verdict cases now run through a real `AgentSession` with a scripted provider: each asserts the tool result the model actually received and that a blocked tool never ran.
