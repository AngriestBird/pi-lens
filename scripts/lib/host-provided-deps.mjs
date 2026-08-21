/**
 * Single source of truth for the packages `scripts/bundle-dist.mjs` keeps out of
 * the dist bundle, split by the REASON they stay external. #1926.
 *
 * HOST_PROVIDED_PACKAGES
 *   pi ships these inside its own runtime (`@earendil-works/pi-coding-agent`'s
 *   node_modules). They must be declared as OPTIONAL peer dependencies plus dev
 *   dependencies, never as runtime `dependencies`, because a runtime dependency
 *   makes `npm install --omit=dev` — the command pi runs for a `git:` install —
 *   vendor a private second copy into the extension's own node_modules. Node
 *   then resolves the bare specifier to that copy and evaluates a whole extra
 *   module graph at import. That is #1926: vendoring `typebox` and
 *   `@earendil-works/pi-tui` cost 720ms of the 838ms git-install import, and
 *   removing the copies took the PI_TIMING module import from 941ms to ~180ms.
 *
 *   The three entries are NOT interchangeable at runtime. pi resolves the bare
 *   specifiers `typebox` and `@earendil-works/pi-tui` for an extension, so
 *   VALUE imports of those work with no copy on disk — verified by hiding both
 *   from the dogfood install and re-running under PI_TIMING (#1926), and by
 *   `@tintinweb/pi-subagents`, which declares pi-tui as a peer and ships no
 *   copy. `@earendil-works/pi-coding-agent` is different: it is not resolvable
 *   from an extension at all, so pi-lens imports it TYPE-ONLY and inlines the
 *   runtime helpers it needs. `tests/host-sdk-type-only.test.ts` enforces that
 *   separate rule (#1334 S6); do not read this list as permission to
 *   value-import the host SDK.
 *
 * LAZY_NATIVE_PACKAGES
 *   Native addon / wasm, dynamic-imported by absolute file:// URL at call time.
 *   They stay external because esbuild cannot inline a .node or .wasm, and they
 *   cost nothing at load because nothing imports them statically.
 *
 * `tests/packaging.test.ts` pins both invariants against package.json and
 * against the built dist entry, so this list cannot drift from what ships.
 */

/** Packages pi resolves from its own embedded runtime. */
export const HOST_PROVIDED_PACKAGES = Object.freeze([
	"typebox",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
]);

/** Native/wasm packages dynamic-imported by absolute path at call time. */
export const LAZY_NATIVE_PACKAGES = Object.freeze([
	"@ast-grep/napi",
	"web-tree-sitter",
]);

/** Everything esbuild must NOT inline into dist/index.js. */
export const BUNDLE_EXTERNALS = Object.freeze([
	...HOST_PROVIDED_PACKAGES,
	...LAZY_NATIVE_PACKAGES,
]);
