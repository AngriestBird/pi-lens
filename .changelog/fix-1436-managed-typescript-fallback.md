---
section: Fixed
---

- **Managed TypeScript self-heals the classic LSP fallback (closes [#1436](https://github.com/apmantza/pi-lens/issues/1436))** — Pi Lens now pins its managed classic compiler to TypeScript 5.9 and repairs existing managed TypeScript 7 trees when `tsserver.js` is absent, while leaving project-local TypeScript 7 on the native `tsc --lsp --stdio` path.
