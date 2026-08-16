/**
 * Coverage gate for the shared availability policy (#1476).
 *
 * #1467 fixed four clients that each latched a timed-out probe as a permanent
 * "tool is not installed" verdict. Its class sweep still missed three more, and
 * the #1476 sweep found three beyond those — including `ctx.hasTool`, the
 * generic seam every CLI runner gates on. The next tool would have been the
 * eleventh. This test is the durable close: it DERIVES the consumer list from the
 * source tree and fails when any consumer decides availability with its own
 * copy of the rule.
 *
 * ## How the list is derived — and why it is not a list
 *
 * A hand-maintained roster of consumers is exactly the defect shape #883
 * established: it drifts the moment someone adds a tool, and a test that lies
 * is worse than no test. So the set is computed by scanning `clients/**\/*.ts`
 * for the shape that defines the defect:
 *
 *   1. the module spawns a VERSION PROBE (a spawn call plus a version-flag
 *      literal in the same file) — it decides availability by running the tool;
 *   2. it MEMOIZES the verdict — an `avail`-named boolean/`null` field or
 *      variable, an assignment to one, a session fact (the dispatcher's memo
 *      for `hasTool`), or one of the shared memo factories.
 *
 * Anything matching both must route through `availability-policy.ts`: directly,
 * via `createAvailabilityChecker` (which applies the policy internally), or by
 * extending `SecurityScanClient` (which does the same for the scanners).
 *
 * ## What this gate does NOT prove
 *
 * Granularity is per FILE. A module that already imports the policy for one
 * memo can still add a second, hand-rolled one beside it and stay green here —
 * `runner-helpers.ts` held exactly such a second memo (the shared ast-grep
 * cache) until #1476. Per-declaration binding would need real type analysis;
 * the review question stays "does every latch in this file go through the
 * policy", and this gate covers the file-level case that recurred twice.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const clientsRoot = path.join(repoRoot, "clients");

/** The module runs a tool to decide whether the tool is there. */
const VERSION_PROBE =
	/\b(?:safeSpawnAsync|safeSpawn|spawnSync|spawn)\s*\(/;
const VERSION_ARG = /"(?:--version|-version|-V|version|--Version)"/;
/** The verdict is remembered, rather than recomputed per call. */
const AVAILABILITY_MEMO = new RegExp(
	[
		// The shared memo factories.
		"createAvailabilityLatch\\(\\)",
		"createAvailabilityChecker\\(",
		// A hand-rolled memo: `private fooAvailable: boolean | null = null`.
		"(?:private|protected|public|let|var)\\s+(?:readonly\\s+)?[A-Za-z_$][\\w$]*[Aa]vail[\\w$]*\\s*(?::[^=;]*)?=\\s*(?:null|false|true)\\b",
		// …or a write to one: `this.available = false`.
		"\\bthis\\.[\\w$]*[Aa]vail[\\w$]*\\s*=\\s*(?:null|false|true)\\b",
		// …or a session fact, which is the dispatcher's memo for `hasTool`.
		"setSessionFact\\(",
	].join("|"),
);
/** The three legitimate ways to reach the shared policy. */
const ROUTED_THROUGH_POLICY =
	/availability-policy\.js|createAvailabilityChecker|extends SecurityScanClient/;

function* walkTs(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			yield* walkTs(full);
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".d.ts") &&
			!entry.name.endsWith(".test.ts")
		) {
			yield full;
		}
	}
}

function isAvailabilityConsumer(source: string): boolean {
	return (
		VERSION_PROBE.test(source) &&
		VERSION_ARG.test(source) &&
		AVAILABILITY_MEMO.test(source)
	);
}

interface Consumer {
	file: string;
	routed: boolean;
}

function collectConsumers(): Consumer[] {
	const consumers: Consumer[] = [];
	for (const file of walkTs(clientsRoot)) {
		const source = fs.readFileSync(file, "utf-8");
		if (!isAvailabilityConsumer(source)) continue;
		consumers.push({
			file: path.relative(repoRoot, file).replace(/\\/g, "/"),
			routed: ROUTED_THROUGH_POLICY.test(source),
		});
	}
	return consumers.sort((a, b) => a.file.localeCompare(b.file));
}

describe("availability policy coverage (#1476)", () => {
	const consumers = collectConsumers();

	it("every availability consumer routes through the shared policy", () => {
		const unrouted = consumers.filter((c) => !c.routed).map((c) => c.file);
		expect(unrouted, [
			"These modules decide tool availability with their own copy of the rule.",
			"Route them through clients/dispatch/runners/utils/availability-policy.ts",
			"(directly, via createAvailabilityChecker, or via SecurityScanClient) so a",
			"timed-out probe cannot latch as 'the tool is not installed' (#1467/#1476).",
		].join(" ")).toEqual([]);
	});

	it("the derived set actually covers the known consumers", () => {
		// Guards the scan itself: a regex that stopped matching would make the
		// assertion above pass over an empty set — defect shape 7, a vacuous test.
		const files = consumers.map((c) => c.file);
		for (const known of [
			"clients/biome-client.ts",
			"clients/sg-runner.ts",
			"clients/go-client.ts",
			"clients/rust-client.ts",
			"clients/knip-client.ts",
			"clients/dead-code-client.ts",
			"clients/dependency-checker.ts",
			"clients/govulncheck-client.ts",
			"clients/jscpd-client.ts",
			"clients/dispatch/runners/utils/runner-helpers.ts",
			"clients/dispatch/dispatcher.ts",
		]) {
			expect(files).toContain(known);
		}
	});

	it("the shape rule can fail: an unrouted hand-rolled latch is detected", () => {
		// The mutation proof, inline: if this synthetic module were added to
		// clients/, the gate above would flag it.
		const reintroduced = `
			import { safeSpawnAsync } from "./safe-spawn.js";
			export class NewToolClient {
				private toolAvailable: boolean | null = null;
				async ensureAvailable(): Promise<boolean> {
					if (this.toolAvailable !== null) return this.toolAvailable;
					const probe = await safeSpawnAsync("newtool", ["--version"], {});
					this.toolAvailable = !probe.error && probe.status === 0;
					return this.toolAvailable;
				}
			}
		`;
		expect(isAvailabilityConsumer(reintroduced)).toBe(true);
		expect(ROUTED_THROUGH_POLICY.test(reintroduced)).toBe(false);
	});
});
