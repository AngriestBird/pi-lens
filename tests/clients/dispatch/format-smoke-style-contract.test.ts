/**
 * Format-smoke style-contract drift guard (#1144 follow-up).
 *
 * #1144 made biome/prettier/ruff/shfmt style-PRESERVING: with no formatter
 * config in the workspace AND no indented line to infer a style from, they
 * refuse to format rather than impose their stock style. Every `--format` smoke
 * fixture for those four was a flat, unindented snippet, so six rows
 * (javascript, python, shell, css, html, yaml) silently began asserting a
 * rewrite that the contract forbids — the nightly failed with "ran clean but
 * left the mis-formatted file unchanged" and nothing in the unit suite noticed.
 *
 * This screens the whole matrix instead of the six that happened to fire: a
 * `reformat` fixture driven by a style-pinning formatter must supply the style
 * evidence its formatter needs, or it can never pass.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasDetectableIndentation } from "../../../clients/dispatch/indent-detect.js";
// Typed via scripts/smoke-tools.d.mts (the harness itself is plain ESM JS).
import { FORMAT_FIXTURES } from "../../../scripts/smoke-tools.mjs";

const repoRoot = path.resolve(__dirname, "../../..");

/** Formatters whose resolveCommand pins style from the file (indentationArgs). */
const STYLE_PINNING = new Set(["biome", "prettier", "ruff", "shfmt"]);

/** Config files that satisfy indentationArgs' "the repo already chose" branch. */
const CONFIG_FILES = new Set([
	".editorconfig",
	".prettierrc",
	".prettierrc.json",
	".prettierrc.yaml",
	".prettierrc.yml",
	".prettierrc.js",
	"prettier.config.js",
	"biome.json",
	"biome.jsonc",
	"ruff.toml",
	".ruff.toml",
	"pyproject.toml",
	"setup.cfg",
	"package.json",
]);

function hasFormatterConfig(dir: string): boolean {
	return fs
		.readdirSync(dir)
		.some((entry) => CONFIG_FILES.has(entry.toLowerCase()));
}

describe("format-smoke fixtures honor the style-preserving contract (#1144)", () => {
	const pinned = FORMAT_FIXTURES.filter((fx) =>
		STYLE_PINNING.has(fx.formatter),
	);

	it("covers every style-pinning formatter", () => {
		expect(new Set(pinned.map((fx) => fx.formatter))).toEqual(STYLE_PINNING);
	});

	it.each(pinned.filter((fx) => fx.expect !== "preserve"))(
		"$lang/$formatter supplies style evidence so a rewrite is reachable",
		(fx) => {
			const dir = path.join(repoRoot, fx.dir);
			const content = fs.readFileSync(path.join(dir, fx.file), "utf8");
			expect(
				hasDetectableIndentation(content) || hasFormatterConfig(dir),
				`${fx.dir}/${fx.file}: ${fx.formatter} refuses to format an unconfigured file with no indented line, so this fixture can only ever report "ran clean but left the mis-formatted file unchanged"`,
			).toBe(true);
		},
	);

	it("keeps a fixture that pins the refusal itself", () => {
		const preserve = FORMAT_FIXTURES.filter((fx) => fx.expect === "preserve");
		expect(preserve.length).toBeGreaterThan(0);
		for (const fx of preserve) {
			const dir = path.join(repoRoot, fx.dir);
			const content = fs.readFileSync(path.join(dir, fx.file), "utf8");
			expect(hasDetectableIndentation(content)).toBe(false);
			expect(hasFormatterConfig(dir)).toBe(false);
		}
	});
});
