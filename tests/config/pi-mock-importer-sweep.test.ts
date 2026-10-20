/**
 * Registered-or-fail ratchet on the hand-built pi double `tests/support/pi-mock.ts`
 * (#4632).
 *
 * Recurrence this prevents: #4631. pi rebuilds the system head when a `context`
 * handler returns a changed list; the double kept the list as returned, so every
 * test passed on the double while the cache broke on the real host. Fixers keep
 * reaching for the double because no check named the real tiers. Host semantics
 * (what pi does with a handler's return value, what the model receives, how pi
 * orders a session) belong to tier 1 (`tests/support/pi-runner.ts`, a real
 * `ExtensionRunner`) or tier 2 (`tests/support/pi-session.ts`, a real
 * `AgentSession`), see AGENTS.md "Testing".
 *
 * The importer list below is the baseline measured on 2026-10-20. A NEW importer
 * fails here; a REMOVED importer must also leave the list (a stale row fails), so
 * the list only shrinks. A row's class is acceptance 7 of #4632: `process-boundary`,
 * `internal-seam` (the case interposes on a pi-lens `clients/` module through
 * `vi.mock`, which cannot reach the copy pi's loader builds), or
 * `unproducible-payload`; `pending slice N` marks a file a roadmap slice still
 * owns, and slice 10 (the last) records the final three-class counts. Classes
 * are the author's reading at the baseline date and are checked for vocabulary
 * only; the SET of files is what the ratchet pins.
 *
 * The scan reads non-comment text with strings kept, because the evidence is a
 * module specifier. Comments are blanked, so prose naming the module neither
 * counts nor excuses. Two needles, either one flags a file. The first is the
 * token `pi-mock`, unless it prefixes another module's name: static,
 * side-effect and dynamic import, `require`, `vi.mock`, `importActual`,
 * `export * from`, a specifier held in a binding, `path.join` pieces. The
 * second is the double's own entry identifiers: a specifier assembled from
 * fragments that never spell the token still has to call them. KNOWN MISS: a
 * `makeCtx`-only user that also assembles the specifier from fragments;
 * `makeCtx` is a generic name in 18 unrelated files, so it cannot be a needle.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const TESTS_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
/** This file names the token in its own plant fixtures and messages. */
const SELF = "config/pi-mock-importer-sweep.test.ts";
const CLASS_VOCABULARY =
	/^(process-boundary|internal-seam|unproducible-payload|text-reference|double-subject|pending slice (?:[3-9]|10))$/;

const NEEDLES: Array<{ via: string; pattern: RegExp }> = [
	{ via: "specifier", pattern: /pi-mock(?![\w-])/ },
	{
		via: "entry identifier",
		pattern: /\b(?:createPiMock|makeStaleCtx|SESSION_START_TEST_BUDGET_MS)\b/,
	},
];

interface Hit {
	line: number;
	via: string;
}

/** First hit per needle, comment-blanked and string-kept. Pure, for the plants. */
function piMockHits(source: string): Hit[] {
	const text = stripSource(source, { strings: "keep" });
	const hits: Hit[] = [];
	for (const { via, pattern } of NEEDLES) {
		const match = pattern.exec(text);
		if (match) {
			hits.push({
				line: text.slice(0, match.index).split("\n").length,
				via,
			});
		}
	}
	return hits;
}

/**
 * file (tests/-relative) -> class. Only ever shrinks: delete a row in the PR that
 * removes the file's last pi-mock use.
 */
const BASELINE: Record<string, string> = {
	// double-subject
	"support/pi-mock.test.ts": "double-subject",
	// internal-seam
	"clients/bootstrap-lazy-liveness.test.ts": "internal-seam",
	"clients/dispatch/lazy-liveness.test.ts": "internal-seam",
	"clients/formatters-lazy-liveness.test.ts": "internal-seam",
	"clients/lsp-lazy-liveness.test.ts": "internal-seam",
	"index-1892-govulncheck-lane-witness.test.ts": "internal-seam",
	"index-1892-scanner-freshness-witness.test.ts": "internal-seam",
	"index-1892-secrets-lane-witness.test.ts": "internal-seam",
	"index-2939-read-path-witness.test.ts": "internal-seam",
	"index-2939-tool-result-budget-witness.test.ts": "internal-seam",
	"index-3190-inline-blocker-deleted-path-witness.test.ts": "internal-seam",
	"index-3246-turn-end-delivery.test.ts": "internal-seam",
	"index-3248-git-guard-latch-witness.test.ts": "internal-seam",
	"index-3290-actionable-warnings-witness.test.ts": "internal-seam",
	"index-3506-file-mutation-queue-wiring.test.ts": "internal-seam",
	"index-3620-sweep-scope-fence.test.ts": "internal-seam",
	"index-3748-advisory-scope-witness.test.ts": "internal-seam",
	"index-3814-deferred-blocker-gate.test.ts": "internal-seam",
	"index-3917-orphan-sweep-scope.test.ts": "internal-seam",
	"index-4483-first-write-seed-witness.test.ts": "internal-seam",
	"index-4484-unfixed-blocker-witness.test.ts": "internal-seam",
	"index-4504-opaque-prescan-root-witness.test.ts": "internal-seam",
	"index-drain-refresh-straddle.test.ts": "internal-seam",
	"index-integration.test.ts": "internal-seam",
	"index-loop-block-wiring.test.ts": "internal-seam",
	"index-lsp-idle-reset.test.ts": "internal-seam",
	"index-memory-sample-wiring.test.ts": "internal-seam",
	"index-mode-awareness.test.ts": "internal-seam",
	"index-mutation-bridge-recordability.test.ts": "internal-seam",
	"index-mutation-latency-marker.test.ts": "internal-seam",
	"index-observed-sweep-no-read-guard.test.ts": "internal-seam",
	"index-project-trust-wiring.test.ts": "internal-seam",
	"index-read-bridge-zero-line.test.ts": "internal-seam",
	"index-smells-rollup-wiring.test.ts": "internal-seam",
	"index-vanished-instance-wiring.test.ts": "internal-seam",
	"index-wiring.test.ts": "internal-seam",
	"index-word-index-memo-settle.test.ts": "internal-seam",
	"index-write-order-token.test.ts": "internal-seam",
	// pending slice 10
	"clients/cascade-unanswered-primary-4403.test.ts": "pending slice 10",
	"config/result-contract-governance.test.ts": "pending slice 10",
	"index-process-bridge-rebind-real-factory.test.ts": "pending slice 10",
	"tools/diagnostics-route-switch-matrix.test.ts": "pending slice 10",
	// pending slice 3
	"clients/context-append-to-last-user.test.ts": "pending slice 3",
	"index-4631-pre-087-context-shape.test.ts": "pending slice 3",
	// pending slice 5
	"index-4554-last-member-teardown.test.ts": "pending slice 5",
	"index-config-resolved-session-wiring.test.ts": "pending slice 5",
	"index-multi-root-session-start.test.ts": "pending slice 5",
	// pending slice 8
	"clients/session-event-guard.test.ts": "pending slice 8",
	"index-cascade-resolved-clean-wiring.test.ts": "pending slice 8",
	"index-process-bridge-registration.test.ts": "pending slice 8",
	// pending slice 9
	"index-2992-integration.test.ts": "pending slice 9",
	"index-lsp-config-root-eviction.test.ts": "pending slice 9",
	"index-session-start-classification-wiring.test.ts": "pending slice 9",
	"lens-toggle-command.test.ts": "pending slice 9",
	// process-boundary
	"clients/handler-verdict-helper.test.ts": "process-boundary",
	"clients/ndjson-logger.test.ts": "process-boundary",
	"clients/pi-host-callable-schema-contract.test.ts": "process-boundary",
	"clients/pi-lens-home-hermeticity.test.ts": "process-boundary",
	// text-reference
	"config/handler-verdict-sweep.test.ts": "text-reference",
};

describe("pi-mock importer ratchet (#4632, recurrence #4631)", () => {
	it("every file that uses the pi double is on the baseline list, and no row is stale", () => {
		const files = listSourceFiles(TESTS_ROOT, {
			extensions: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"],
		}).filter((file) => relativePosix(TESTS_ROOT, file) !== SELF);
		const flagged: Array<{ key: string; detail: string }> = [];
		for (const { file, source } of readWalkedFiles(files)) {
			const rel = relativePosix(TESTS_ROOT, file);
			// The double itself names its own module and entry points.
			if (rel === "support/pi-mock.ts") continue;
			const hits = piMockHits(source);
			if (hits.length > 0) {
				flagged.push({
					key: rel,
					detail: `line ${hits[0].line}, ${hits.map((h) => h.via).join(" + ")}`,
				});
			}
		}
		// Calibration 2026-10-20: ~1,300 files under tests/. Half rounds to 650.
		// A dead walk with a non-empty list already reds as stale rows; this floor
		// is for the day the list is empty and a dead scan would read as clean.
		assertNonEmptyScan("pi-mock sweep: files scanned", files.length, 650);
		const audit = auditRegistry({
			sweepName: "pi-mock importer ratchet",
			flagged,
			registered: [],
			exemptions: BASELINE,
			minReasonLength: 10,
			remediation:
				"A new file may not drive the extension through tests/support/pi-mock.ts. " +
				"A case whose verdict depends on what pi does with a handler's return value, " +
				"what the model receives, or how pi orders a session goes through tier 1 " +
				"(tests/support/pi-runner.ts, a real ExtensionRunner: flags, tools, commands, " +
				"registrations) or tier 2 (tests/support/pi-session.ts, a real AgentSession: " +
				"turns, tool round trips, session ids, the model-visible request). AGENTS.md " +
				"'Testing' says which. Add a capability to pi-runner.test.ts / " +
				"pi-session.test.ts first. If the file is a genuine process-boundary subject, " +
				"internal seam or unproducible payload (#4632 acceptance 7), add it to BASELINE " +
				"with that class and say why in the PR body. A row for a file that no longer " +
				"uses the double must be deleted.",
		});
		expect(audit.problems).toEqual([]);
	});

	it("every baseline row names a class from the #4632 vocabulary", () => {
		const bad = Object.entries(BASELINE)
			.filter(([, cls]) => !CLASS_VOCABULARY.test(cls))
			.map(([file, cls]) => `${file}: ${cls}`);
		expect(bad).toEqual([]);
		// The ratchet's own file is excluded by path; the exclusion must name a real file.
		expect(fs.existsSync(path.join(TESTS_ROOT, SELF))).toBe(true);
	});
});

describe("pi-mock scan plants (spellings nobody designed the list for)", () => {
	const flaggedPlants: Record<string, string> = {
		"static import": `import { createPiMock } from "../support/pi-mock.js";`,
		"side-effect import": `import "./support/pi-mock.js";`,
		"multi-line named import": `import {\n\tmakeCtx,\n\ttype PiMock,\n} from "../support/pi-mock.ts";`,
		"dynamic import": `const m = await import("../support/pi-mock.js");`,
		"alias binding": `const spec = "../support/pi-mock.js";\nconst m = await import(spec);`,
		"indirect call": `const load = () => import("../support/pi-mock.js");\nawait load();`,
		require: `const m = require("../support/pi-mock.js");`,
		"vi.mock of the double": `vi.mock("../support/pi-mock.js", () => ({}));`,
		importActual: `const m = await vi.importActual("../support/pi-mock.js");`,
		"value through another binding (re-export)": `export * from "../support/pi-mock.js";`,
		"template literal": "const m = await import(`../support/pi-mock.js`);",
		"directory-style specifier": `await import("../support/pi-mock/index.js");`,
		"template with interpolation": "await import(`../${dir}/pi-mock.js`);",
		"path.join pieces": `path.join(ROOT, "support", "pi-mock.ts");`,
		"split specifier, entry identifier used": `const spec = "../support/pi-" + "mock.js";\nconst { createPiMock } = await import(spec);`,
		"entry identifier only": `const pi = createPiMock();`,
		"after a comment on the same line": `/* tier 2 */ import { createPiMock } from "./pi-mock.js";`,
	};
	for (const [name, source] of Object.entries(flaggedPlants)) {
		it(`flags: ${name}`, () => {
			expect(piMockHits(source).length).toBeGreaterThan(0);
		});
	}

	// KNOWN MISS, stated in the header: a makeCtx-only user assembling the
	// specifier from fragments. Pinned so a widened needle shows up as a change.
	it("documents the one miss: makeCtx-only, specifier from fragments", () => {
		const source = `const spec = "../support/pi-" + "mo" + "ck.js";\nconst { makeCtx } = await import(spec);`;
		expect(piMockHits(source)).toEqual([]);
	});

	const quietPlants: Record<string, string> = {
		"line comment": `// moved off tests/support/pi-mock.ts onto tier 2\nconst x = 1;`,
		"block comment": `/* createPiMock was here, see pi-mock.ts */\nconst x = 1;`,
		"unrelated mock": `import { makeCtx } from "./runner-ctx.js";`,
		// Recurrence: the first run of this ratchet flagged
		// tests/scripts/pre-push-targeted-tests.test.ts for naming this very
		// file's path in a registry list.
		"a sibling module whose name starts with the token": `"tests/config/pi-mock-importer-sweep.test.ts",`,
	};
	for (const [name, source] of Object.entries(quietPlants)) {
		it(`does not flag: ${name}`, () => {
			expect(piMockHits(source)).toEqual([]);
		});
	}

	it("a comment opener inside a string does not blank the import after it", () => {
		const source = `const url = "http://x"; import "../support/pi-mock.js";`;
		expect(piMockHits(source).length).toBeGreaterThan(0);
	});
});
