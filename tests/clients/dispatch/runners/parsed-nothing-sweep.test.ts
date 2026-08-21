/**
 * Registered-or-fail sweep for the #1948 parsed-nothing gate.
 *
 * `parseToolRun` composes BOTH gates a runner needs before it may claim a
 * clean file: "the tool produced nothing" (#1816) and "the tool produced
 * something the parser could not read" (#1948). A runner that calls the older
 * `skipUnlessToolRan` directly gets only the first, which is exactly the state
 * that hid five parser bugs for months.
 *
 * So: any dispatch runner calling `skipUnlessToolRan` must declare WHY the
 * second gate is wrong for it. Prose could not enforce that. Stale claims fail
 * too — an exemption whose call site is gone turns red instead of leaving a lie
 * behind.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUNNER_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../clients/dispatch/runners",
);

/**
 * Runners that legitimately parse zero diagnostics out of a FAILING run, so
 * the #1948 rule would fire on a healthy run. Each entry states the mechanism.
 */
const EXEMPT: Record<string, string> = {
	"go-vet.ts":
		"go vet exits nonzero for a SIBLING file's problem, then this runner " +
		"filters the output down to the edited file. Zero parsed diagnostics " +
		"under a nonzero exit is the normal, correct outcome there.",
};

/**
 * Runners that write a `runner-empty-result` row themselves rather than
 * through `skipUnlessToolRan`. Allowed only where the row carries a DIFFERENT
 * discriminating identity than the tool id.
 */
const DIRECT_LEDGER_WRITERS: Record<string, string> = {
	"trivy-config.ts":
		"subject is the FILE PATH, not the tool: the identity a reader needs " +
		"here is which file trivy stopped covering. `trivy config` also exits 0 " +
		"whenever it completed, so any nonzero status is already an error and " +
		"the #1948 rule can never apply to it.",
};

function runnerSources(): string[] {
	return fs
		.readdirSync(RUNNER_DIR)
		.filter((name) => name.endsWith(".ts"))
		.sort();
}

function read(name: string): string {
	return fs.readFileSync(path.join(RUNNER_DIR, name), "utf8");
}

/** Call sites, not mentions: a name inside a comment must not count. */
function callsInSource(source: string, callee: string): boolean {
	return source
		.split(/\r?\n/)
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.some((line) => line.includes(`${callee}(`));
}

describe("parsed-nothing sweep (#1948)", () => {
	const sources = runnerSources();
	const adopters = sources.filter((name) =>
		callsInSource(read(name), "parseToolRun"),
	);
	const legacy = sources.filter((name) =>
		callsInSource(read(name), "skipUnlessToolRan"),
	);

	it("scans a non-trivial population, so a broken scanner cannot pass vacuously", () => {
		expect(sources.length).toBeGreaterThan(40);
		expect(adopters.length).toBeGreaterThanOrEqual(9);
	});

	it("every runner on the old gate declares why the parsed-nothing gate is wrong for it", () => {
		const undeclared = legacy.filter((name) => !(name in EXEMPT));
		expect(
			undeclared,
			`these runners call skipUnlessToolRan without the #1948 gate: ${undeclared.join(", ")}. ` +
				"Migrate them to parseToolRun, or add an EXEMPT entry stating the mechanism.",
		).toEqual([]);
	});

	it("every exemption still names a live call site", () => {
		const stale = Object.keys(EXEMPT).filter((name) => !legacy.includes(name));
		expect(
			stale,
			`these exemptions no longer call skipUnlessToolRan: ${stale.join(", ")}. Delete them.`,
		).toEqual([]);
	});

	it("no runner rebuilds the rule by hand", () => {
		// The taplo copy this replaced spelled the same rule inline and wrote its
		// own ledger row. A second copy would drift from the shared wording and
		// split the ledger identity across two kinds.
		const handRolled = sources.filter((name) => {
			const source = read(name);
			return (
				callsInSource(source, "incrementDegradationCount") &&
				source.includes("runner-empty-result") &&
				!(name in DIRECT_LEDGER_WRITERS)
			);
		});
		expect(
			handRolled,
			`these runners write a runner-empty-result row directly instead of going ` +
				`through the shared seam: ${handRolled.join(", ")}`,
		).toEqual([]);

		const stale = Object.keys(DIRECT_LEDGER_WRITERS).filter(
			(name) => !read(name).includes("runner-empty-result"),
		);
		expect(
			stale,
			`stale DIRECT_LEDGER_WRITERS entries: ${stale.join(", ")}`,
		).toEqual([]);
	});
});
