/**
 * Guard for the #3082 guard.
 *
 * Named recurrence: a test that creates a `*.test.ts` — or any other source
 * file a governance walker enumerates — inside the repo's own `tests/` tree at
 * runtime. `tests/clients/pi-lens-home-hermeticity.test.ts` did exactly that
 * for the length of one assertion and redded four different directory-walking
 * sweeps with ENOENT on rotating runs (#3082/#3092).
 */
// flake-shape: raw-timer-wait — the guard's entire claim is that a REAL filesystem event reaches it; no fake clock delivers an inotify event, and a stubbed watcher would prove only that the stub calls its own callback. The wait is a bounded poll on the guard's own report, not a fixed sleep.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	installTestsTreeWriteGuard,
	isGuardedTreeEntry,
} from "./tests-tree-write-guard.js";
import { runTestsTreeWriteGuardSetup } from "./tests-tree-write-guard-setup.js";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

function fixtureTree(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3082-guard-"));
	scratch.push(root);
	fs.mkdirSync(path.join(root, "clients"), { recursive: true });
	fs.writeFileSync(path.join(root, "clients", "tracked.test.ts"), "// tracked");
	return root;
}

/** No watcher: `record` is fed directly, so every classification case is
 *  deterministic. Real delivery has its own case at the end of this file. */
function offlineGuard(root: string) {
	return installTestsTreeWriteGuard(root, { watch: false });
}

describe("tests-tree write guard (#3082)", () => {
	it("reports a source file created under the watched root", () => {
		const root = fixtureTree();
		const guard = offlineGuard(root);
		guard.record("scratch-3050.test.ts");
		expect(guard.report()).toMatch(/scratch-3050\.test\.ts/);
		expect(guard.report()).toMatch(/#3082/);
	});

	it("reports a file created in a nested directory, the shape a walk recurses into", () => {
		const root = fixtureTree();
		const guard = offlineGuard(root);
		guard.record(path.join("clients", "scratch-nested.test.ts"));
		expect(guard.report()).toMatch(/scratch-nested\.test\.ts/);
	});

	it("stays silent for a file that already existed when the run started", () => {
		const root = fixtureTree();
		const guard = offlineGuard(root);
		// An editor save, a `git checkout` of a tracked file: the walk started
		// with this path, so no sweep can be surprised by it.
		guard.record(path.join("clients", "tracked.test.ts"));
		expect(guard.report()).toBeUndefined();
	});

	it("stays silent for file kinds no walker under tests/ enumerates", () => {
		const root = fixtureTree();
		const guard = offlineGuard(root);
		guard.record("vi-mock-export-baseline.json");
		guard.record(path.join("fixtures", "workspace", "node_modules", "x.mjs"));
		guard.record(null);
		expect(guard.report()).toBeUndefined();
	});

	it("classifies by extension and node_modules position, not by filename", () => {
		expect(isGuardedTreeEntry("a.test.ts")).toBe(true);
		expect(isGuardedTreeEntry("helpers.mts")).toBe(true);
		expect(isGuardedTreeEntry("script.mjs")).toBe(true);
		expect(isGuardedTreeEntry("plain-helper.ts")).toBe(true);
		expect(isGuardedTreeEntry("baseline.json")).toBe(false);
		expect(isGuardedTreeEntry("fixtures/node_modules/pkg/index.mjs")).toBe(
			false,
		);
		expect(isGuardedTreeEntry("fixtures/not_node_modules/a.ts")).toBe(true);
	});

	it("records one entry per distinct path, however many events arrive", () => {
		const root = fixtureTree();
		const guard = offlineGuard(root);
		for (let index = 0; index < 50; index++) guard.record("repeat.test.ts");
		const report = guard.report() ?? "";
		expect(report.match(/repeat\.test\.ts/g)).toHaveLength(1);
		expect(report).toMatch(/^#3082: 1 source file/);
	});

	it("caps the reported list and says how many it dropped", () => {
		const root = fixtureTree();
		const guard = offlineGuard(root);
		for (let index = 0; index < 25; index++)
			guard.record(`flood-${index}.test.ts`);
		const report = guard.report() ?? "";
		expect(report).toMatch(/^#3082: 25 source file/);
		expect(report).toMatch(/\.\.\. and 5 more/);
	});

	it("warns once and stays inert when the platform cannot watch recursively", () => {
		const root = fixtureTree();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const guard = installTestsTreeWriteGuard(root, {
				watch: (() => {
					throw new Error("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM");
				}) as unknown as typeof fs.watch,
			});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toMatch(/will not be caught/);
			expect(guard.report()).toBeUndefined();
			guard.close();
		} finally {
			warn.mockRestore();
		}
	});

	it("the setup arm throws the report, and closes the watch on the way out", () => {
		const root = fixtureTree();
		const guard = offlineGuard(root);
		let closed = 0;
		const teardown = runTestsTreeWriteGuardSetup(root, {
			...guard,
			close: () => {
				closed += 1;
				guard.close();
			},
		});
		guard.record("scratch-setup.test.ts");
		expect(() => teardown()).toThrow(/scratch-setup\.test\.ts/);
		// The throw must not leak the inotify handle (AGENTS.md shape 4).
		expect(closed).toBe(1);
	});

	it("the setup arm is silent on a tree nothing created a source file in", () => {
		const root = fixtureTree();
		const teardown = runTestsTreeWriteGuardSetup(root);
		fs.writeFileSync(path.join(root, "clients", "tracked.test.ts"), "// edit");
		expect(() => teardown()).not.toThrow();
	});

	// The one real-watcher case, with no stand-in for `fs.watch`: a source file
	// created and removed inside one synchronous block — the producer's exact
	// shape, and the one no before/after snapshot can see — reaches the guard
	// through a real recursive watch. Without this case, deleting the `record`
	// call from the watch callback leaves every other case above green.
	it(
		"records a file created and removed mid-run, through a real recursive watch",
		{ timeout: 30_000 },
		async () => {
			const root = fixtureTree();
			const guard = installTestsTreeWriteGuard(root);
			const scratchPath = path.join(
				root,
				"clients",
				"scratch-delivery.test.ts",
			);
			try {
				// The write is RETRIED rather than slept in front of: the loop ends on
				// the guard's own report, not on a guessed settle time. The create and
				// the remove are separated by one event-loop turn of THIS process —
				// see the module docstring's "what it cannot see": a watcher only
				// observes a create if its own loop turns while the file exists, which
				// in the real run it always does (the watcher is in the main process,
				// the producer in a worker fork).
				const deadline = Date.now() + 20_000;
				while (guard.report() === undefined && Date.now() < deadline) {
					fs.writeFileSync(scratchPath, "// scratch");
					await new Promise((resolve) => setTimeout(resolve, 50));
					fs.rmSync(scratchPath, { force: true });
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				expect(guard.report()).toMatch(/scratch-delivery\.test\.ts/);
			} finally {
				guard.close();
				fs.rmSync(scratchPath, { force: true });
			}
		},
	);
});
