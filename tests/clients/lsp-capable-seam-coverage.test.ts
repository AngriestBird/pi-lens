/**
 * Structural coverage guards for the two seams a newly registered lspCapable
 * language has to reach (#1545).
 *
 * Both seams are derived from LANGUAGE_POLICY in the source, so these guards
 * are the record that the derivation is still in place: re-hand-maintaining
 * either list drops a member and fails here. The class was found via #1520
 * (CUE), which missed both seams at once; fish had been missing from appliesTo
 * since it was registered.
 */

import { describe, expect, it } from "vitest";
import lspRunner from "../../clients/dispatch/runners/lsp.js";
import { KIND_EXTENSIONS } from "../../clients/file-kinds.js";
import { getLspCapableKinds } from "../../clients/language-policy.js";
import {
	getLanguageId,
	LANGUAGE_EXTENSIONS,
} from "../../clients/lsp/language.js";

// Every language id an lspCapable file can be announced as on didOpen.
//
// Whether a server answers to a given spelling is a fact about that server,
// not something the code can derive: the registry's id is a pi-lens-internal
// label ("shell"), and the id bash-language-server expects ("shellscript") is
// a separate decision. This list is a snapshot of what is reachable today, NOT
// a set of verified-good ids — the entries inherited from the curated table
// are grandfathered unchecked, and at least one is known dubious ("sass": the
// only registered CSS server ignores languageId and parses indented Sass as
// CSS). What the pin buys is that a NEW or RENAMED id cannot appear silently.
// Adding one here is the review decision that it is the spelling the target
// server wants.
//
// tests/clients/language-policy.test.ts already fails a kind with no
// registered primary server at all; this covers the case that one slips past:
// a kind that HAS a server but announces itself in a spelling the server's
// DocumentSelector never matches.
const PINNED_LSP_LANGUAGE_IDS = [
	"c",
	"clojure",
	"cmake",
	"cpp",
	"csharp",
	"css",
	// cuelsp keys diagnostics off the file URI, but "cue" is the id the CUE
	// wiki and every editor client use, and it matches the registry id (#1520).
	"cue",
	"dart",
	"dockerfile",
	"elixir",
	"fish",
	"fsharp",
	"gleam",
	"go",
	"haskell",
	"html",
	"java",
	"javascript",
	"javascriptreact",
	"json",
	"jsonc",
	"kotlin",
	"less",
	"lua",
	"markdown",
	"nix",
	"ocaml",
	"php",
	"powershell",
	"prisma",
	"python",
	"ruby",
	"rust",
	"sass",
	"scss",
	"shellscript",
	"svelte",
	"swift",
	"terraform",
	"toml",
	"typescript",
	"typescriptreact",
	"vue",
	"yaml",
	"zig",
];

describe("lspCapable seam coverage", () => {
	// An empty appliesTo means "every kind" to RunnerRegistry.getForKind, so a
	// derivation that resolved to nothing would silently invert into running the
	// lsp runner on sql and terragrunt too.
	it("keeps the lsp runner's appliesTo non-empty", () => {
		expect(lspRunner.appliesTo.length).toBeGreaterThan(0);
	});

	it("lists every lspCapable kind in the lsp runner's appliesTo", () => {
		const missing = getLspCapableKinds().filter(
			(kind) => !lspRunner.appliesTo.includes(kind),
		);
		expect(
			missing,
			`lspCapable kind(s) absent from the lsp runner's appliesTo: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("claims no kind in appliesTo that policy says is not lspCapable", () => {
		const capable = new Set(getLspCapableKinds());
		const extra = lspRunner.appliesTo.filter((kind) => !capable.has(kind));
		expect(
			extra,
			`lsp runner applies to non-lspCapable kind(s): ${extra.join(", ")}`,
		).toEqual([]);
	});

	it("maps every lspCapable kind's extensions to an LSP language id", () => {
		const missing = getLspCapableKinds().flatMap((kind) =>
			KIND_EXTENSIONS[kind].filter(
				(extension) => LANGUAGE_EXTENSIONS[extension] === undefined,
			),
		);
		expect(
			missing,
			`lspCapable extension(s) absent from LANGUAGE_EXTENSIONS: ${missing.join(", ")}`,
		).toEqual([]);
	});

	// The seam that matters is didOpen's languageId, not the table itself.
	// "plaintext" counts as unresolved: it is what the didOpen call sites
	// substitute for undefined, and whether a server tolerates it is that
	// server's choice, not something this seam gets to assume.
	it("resolves a language id for every lspCapable extension", () => {
		const unresolved = getLspCapableKinds().flatMap((kind) =>
			KIND_EXTENSIONS[kind].filter((extension) => {
				const id = getLanguageId(`file${extension}`);
				return id === undefined || id === "plaintext";
			}),
		);
		expect(
			unresolved,
			`extension(s) still falling back to plaintext on didOpen: ${unresolved.join(", ")}`,
		).toEqual([]);
	});

	// Presence is not spelling. The derivation fills gaps from the registry's
	// per-kind id, so a kind registered with a label no server answers to
	// ("Probe-Lang-Script") satisfies every guard above. Pinning the reachable
	// set makes the spelling a review decision instead of an accident.
	it("announces lspCapable files only under a pinned language id", () => {
		const reachable = [
			...new Set(
				getLspCapableKinds().flatMap((kind) =>
					KIND_EXTENSIONS[kind]
						.map((extension) => getLanguageId(`file${extension}`))
						.filter((id): id is string => id !== undefined),
				),
			),
		].sort();
		expect(reachable).toEqual([...PINNED_LSP_LANGUAGE_IDS].sort());
	});

	// Sweep findings the derivation fixed alongside fish — powershell had no
	// LANGUAGE_EXTENSIONS entry at all, and cxx covered only a third of its
	// registered extensions.
	it("keeps the sweep's newly covered extensions resolvable", () => {
		expect(getLanguageId("build/Deploy.ps1")).toBe("powershell");
		expect(getLanguageId("mod/Helpers.psm1")).toBe("powershell");
		expect(getLanguageId("src/view.cu")).toBe("cpp");
		expect(getLanguageId("src/detail.ipp")).toBe("cpp");
		expect(getLanguageId("cfg/app.json5")).toBe("json");
	});

	// The curated per-extension ids are finer-grained than the per-kind
	// registry id (jsts is one kind, .ts and .tsx are two language ids), so the
	// derivation must only fill gaps, never overwrite.
	it("keeps curated per-extension language ids ahead of the per-kind id", () => {
		expect(getLanguageId("src/App.tsx")).toBe("typescriptreact");
		expect(getLanguageId("src/main.ts")).toBe("typescript");
		expect(getLanguageId("scripts/run.sh")).toBe("shellscript");
		expect(getLanguageId("src/main.c")).toBe("c");
		expect(getLanguageId("styles/app.scss")).toBe("scss");
	});
});
