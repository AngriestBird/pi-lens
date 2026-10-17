import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isUnderDir } from "../../clients/path-utils.js";
import {
	fixtureHomeRoot,
	pinFixtureHome,
	setupTestEnvironment,
} from "./test-utils.js";

/**
 * #4591: a child a test never awaits inherits the pinned HOME and its `cwd`,
 * and a write it lands after the fixture root is gone re-creates that root.
 * `pi-lens-4577-resolver-cqF0yk` was still on disk three minutes after its own
 * file's teardown sweep (`registered=1 stragglers=0 failed=0`), and no sweep
 * can remove a root a foreign process re-creates.
 *
 * The late write is modeled in-process: the harness only ever sees the
 * directory appear, never which process wrote it, so the same write at the same
 * moment is the same input. Before #4591 this exact pair — `pinTestHome(home)`
 * with `home` under the fixture root — leaves the root on disk.
 */
describe("a pinned fixture HOME after teardown (#4591)", () => {
	it("places the home outside the root teardown deletes and outside the tmp-root census", () => {
		const env = setupTestEnvironment("pi-lens-4591-fixture-home-");
		const { home, restore } = pinFixtureHome("4591-fixture-home");
		try {
			expect(os.homedir()).toBe(home);
			expect(
				isUnderDir(path.resolve(home), path.resolve(env.tmpDir)),
				"a home inside the fixture root is re-created by a straggler write",
			).toBe(false);
			// The census watches top-level `pi-lens-` entries under the OS temp
			// root; a home the worker owns is not one of them.
			expect(isUnderDir(path.resolve(home), path.resolve(os.tmpdir()))).toBe(
				false,
			);
			// Its lifecycle belongs to the worker-owned scratch root the shared
			// setup removes at teardown, and it sits BESIDE the worker home: a
			// home inside `PI_LENS_HOME` is pi-lens's own housekeeping to
			// production (`isPiLensInternalPath`), which changes what the write
			// path does with it.
			expect(path.dirname(home)).toBe(fixtureHomeRoot());
			expect(
				isUnderDir(
					path.resolve(home),
					path.resolve(process.env.PI_LENS_HOME as string),
				),
			).toBe(false);
		} finally {
			restore();
			env.cleanup();
		}
	});

	it("keeps the fixture root deleted when a straggler writes to the pinned home", () => {
		const env = setupTestEnvironment("pi-lens-4591-fixture-home-late-");
		const { home, restore } = pinFixtureHome("4591-fixture-home-late");
		try {
			expect(os.homedir()).toBe(home);
			env.cleanup();
			expect(fs.existsSync(env.tmpDir)).toBe(false);
			// The write the child lands after teardown, at the same moment.
			fs.mkdirSync(path.join(home, "late-write"), { recursive: true });
			expect(fs.existsSync(path.join(home, "late-write"))).toBe(true);
			expect(fs.existsSync(env.tmpDir)).toBe(false);
		} finally {
			restore();
		}
	});
});
