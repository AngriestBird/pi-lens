/**
 * #4765: `scripts/build-opengrep-pack.mjs` builds the pack that ships in the
 * npm package from a checkout of opengrep/opengrep-rules.
 *
 * Recurrence these cases prevent: the shipped pack carrying a rule whose
 * licence is not the admitted one (one upstream rule is marked proprietary),
 * or a pack nobody can rebuild byte for byte. The fixture is a tiny upstream
 * tree built here, so the script's licence filter and its `--check` mode are
 * observed through a real run, not a restatement of its source.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { load } from "js-yaml";

import {
	buildPack,
	defuseRiskyLiterals,
} from "../../scripts/build-opengrep-pack.mjs";
import { pinFixtureHome, removeTempDirSync } from "../clients/test-utils.js";

const COMMONS = "Commons Clause License Condition v1.0[LGPL-2.1-only]";
const COMMIT = "f".repeat(40);

let home: string;
let restoreHome: () => void;
let upstream: string;
let packDir: string;

const ruleFile = (rules: string): string => `rules:\n${rules}`;
const rule = (id: string, license?: string): string =>
	`  - id: ${id}\n    pattern: foo(...)\n    languages: [python]\n    message: m\n    severity: WARNING\n${
		license ? `    metadata:\n      license: ${license}\n` : ""
	}`;

beforeEach(() => {
	({ home, restore: restoreHome } = pinFixtureHome("opengrep-builder-4765"));
	upstream = path.join(home, "upstream");
	packDir = path.join(home, "work", "vendor", "opengrep-rules");
	fs.mkdirSync(path.join(upstream, "python", "lang"), { recursive: true });
	fs.writeFileSync(
		path.join(upstream, "python", "lang", "a.yaml"),
		ruleFile(
			[
				rule("kept-commons", COMMONS),
				rule("kept-bare"),
				rule("proprietary-one", "proprietary license - copyright (c) X"),
				rule("not-in-registry", COMMONS),
			].join(""),
		),
	);
	fs.writeFileSync(
		path.join(home, "ids.txt"),
		[
			"python.lang.a.kept-commons",
			"python.lang.a.kept-bare",
			"python.lang.a.proprietary-one",
			"",
		].join("\n"),
	);
});

afterEach(() => {
	removeTempDirSync(home);
	restoreHome();
});

function build(extra: { check?: boolean; ids?: boolean } = {}) {
	return buildPack({
		upstream,
		registryFile: extra.ids === false ? undefined : path.join(home, "ids.txt"),
		commit: COMMIT,
		check: extra.check,
		packDir,
	});
}

describe("scripts/build-opengrep-pack.mjs", () => {
	it("keeps only registry-listed rules under the admitted licence and lists the rest as excluded", () => {
		const result = build();
		expect(result.chosen.map((r) => r.id)).toEqual([
			"python.lang.a.kept-bare",
			"python.lang.a.kept-commons",
		]);
		const doc = load(
			fs.readFileSync(path.join(packDir, "rules.yaml"), "utf-8"),
		) as { rules: Array<{ id: string }> };
		expect(doc.rules.map((r) => r.id)).toEqual(result.chosen.map((r) => r.id));
		const manifest = JSON.parse(
			fs.readFileSync(path.join(packDir, "manifest.json"), "utf-8"),
		) as {
			ruleCount: number;
			excluded: Array<{ id: string }>;
			upstream: { commit: string };
		};
		expect(manifest.ruleCount).toBe(2);
		expect(manifest.excluded.map((e) => e.id)).toEqual([
			"python.lang.a.proprietary-one",
		]);
		expect(manifest.upstream.commit).toBe(COMMIT);
	});

	it("rebuilds the shipped pack byte for byte from its own rule ids, and says so when it differs", () => {
		build();

		// No registry list: the rebuild takes the ids already in the pack.
		expect(build({ check: true, ids: false }).same).toBe(true);

		// A different upstream body for a kept rule: the rebuild must not match.
		fs.writeFileSync(
			path.join(upstream, "python", "lang", "a.yaml"),
			ruleFile(
				[
					rule("kept-commons", COMMONS).replace(
						"message: m",
						"message: changed",
					),
					rule("kept-bare"),
					rule("proprietary-one", "proprietary license - copyright (c) X"),
				].join(""),
			),
		);
		expect(build({ check: true, ids: false }).same).toBe(false);
	});
});

describe("defuseRiskyLiterals", () => {
	// Recurrence: GitHub push protection declined the first push of this pack
	// (GH013, 2026-10-23) because one upstream rule lists the placeholder
	// `https://hooks.slack.com/services/T00000000/B00000000/XXXX...` as a
	// `pattern-not`. The scalar must read back byte for byte and no longer
	// hold the contiguous webhook shape.
	const placeholder =
		"https://hooks.slack.com/services/T00000000/B00000000/" + "X".repeat(24);

	it("rewrites a whole webhook-shaped scalar so it parses to the same string", () => {
		const text = `rules:\n  - id: r\n    patterns:\n      - pattern-not: ${placeholder}\n`;
		const out = defuseRiskyLiterals(text);
		expect(out).not.toContain(placeholder);
		expect(load(out)).toEqual(load(text));
	});

	it("leaves a regex that detects webhooks, and every other scalar, alone", () => {
		const text = `rules:\n  - id: r\n    pattern-regex: https://hooks\\.slack\\.com/services/T[a-zA-Z0-9_]{8,10}/B[a-zA-Z0-9_]{8,10}/[a-zA-Z0-9_]{24}\n    message: see ${placeholder} in prose\n`;
		expect(defuseRiskyLiterals(text)).toBe(text);
	});
});
