/**
 * #4689: a path identity the kernel cannot finish is visible, not silent.
 *
 * `normalizeMapKey` derives an absolute spelling's identity from the realpath
 * of its nearest existing ancestor. A missing component is the ordinary answer
 * for a file not yet written and records nothing; any other realpath error (a
 * cyclic link here) makes the key fall back to an ancestor's identity, where
 * another spelling of the same file may derive a different key. That fallback
 * reaches `pilens_health` through the ledger's read-time fold
 * (`path-identity-fallback`), bounded to one row per errno code.
 *
 * Recurrence guarded: a silent identity fallback is the shape-1 split this
 * issue fixes, hidden again (engineering principles, "Every new failure path
 * gets bounded observability"). Lane: ubuntu Unit tests; a host that cannot
 * create symlinks skips visibly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

function fallbackGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "path-identity-fallback",
	);
}

describe("path identity fallback record (#4689)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-path-identity-fallback-");
		resetDegradationLedger();
	});
	afterEach(() => {
		resetDegradationLedger();
		env.cleanup();
	});

	it("a cyclic link keys under its nearest resolvable ancestor and records the fallback once per errno", (ctx) => {
		const root = fs.realpathSync.native(env.tmpDir);
		try {
			fs.symlinkSync("loop-b", path.join(root, "loop-a"));
			fs.symlinkSync("loop-a", path.join(root, "loop-b"));
		} catch (error) {
			return ctx.skip(`symlinks unavailable: ${String(error)}`);
		}
		const spelled = path.join(root, "loop-a", "x.ts");
		expect(normalizeMapKey(spelled)).toBe(spelled.replace(/\\/g, "/"));
		const group = fallbackGroup();
		// Two refusals (the file under the loop, then the loop itself), one row.
		expect(group?.count).toBe(2);
		expect(group?.latestReasons.map((row) => row.subject)).toEqual(["ELOOP"]);
		expect(group?.latestReasons[0]?.reason).toContain(spelled);
	});

	it("a file not yet written records nothing", () => {
		const root = fs.realpathSync.native(env.tmpDir);
		normalizeMapKey(path.join(root, "missing-dir", "new.ts"));
		expect(fallbackGroup()).toBeUndefined();
	});

	it("re-arms with the ledger at a session boundary", (ctx) => {
		const root = fs.realpathSync.native(env.tmpDir);
		try {
			fs.symlinkSync("self", path.join(root, "self"));
		} catch (error) {
			return ctx.skip(`symlinks unavailable: ${String(error)}`);
		}
		normalizeMapKey(path.join(root, "self"));
		expect(fallbackGroup()?.count).toBe(1);
		resetDegradationLedger();
		expect(fallbackGroup()).toBeUndefined();
	});
});
