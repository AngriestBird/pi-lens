---
section: Added
audience: user
---

- **Projects with `@effect/tsgo` get Effect's TypeScript-Go language server (refs #4914)** — when a project installs `@effect/tsgo` beside TypeScript 7 or newer, pi-lens launches the project's own `effect-tsgo tsc --lsp --stdio` for TypeScript files, so the Effect language service's diagnostics reach pi-lens. Installing the package is the opt-in; there is no pi-lens setting. Projects without it keep the native TypeScript 7 or classic launch, a malformed `@effect/tsgo` install falls back to the native launch, and the binary follows the same project-trust gate as the project's compiler. pi-lens never installs `@effect/tsgo` or runs its setup. Requested by @forge18.
