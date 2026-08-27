/**
 * #2252: a negative runner-availability (and Vitest-glob) verdict must not
 * latch for the client's whole process lifetime.
 *
 * `TestRunnerClient` is constructed once per extension process
 * (`clients/bootstrap.ts:182`), so any state it memoizes lives as long as the
 * process does. `getRunnerAvailability` already re-validates a POSITIVE
 * verdict by re-statting its `evidencePath`, but a negative verdict carries no
 * evidence path and was written into the same cache unconditionally — so
 * probing an empty directory, then adding `vitest.config.ts` a moment later,
 * kept answering "no runner" for the rest of the client's life. Same shape
 * for `parseVitestTestGlobs`'s `null` ("no config yet") memo.
 *
 * This is the sibling of #2077 (fixed by PR #2242): a memo that persists a
 * FAILED resolution. The fix here follows #2242's precedent — drop the memo
 * write on the failure branch — rather than adding a TTL or an explicit
 * re-arm signal, since the miss path already pays the identical bounded
 * filesystem check on every call regardless of caching.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import { setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

describe("TestRunnerClient negative-verdict convergence (#2252)", () => {
	it("detects vitest once its config appears, on the SAME client instance", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-2252-runner-");
		cleanups.push(cleanup);

		const client = new TestRunnerClient();

		// Empty project directory: no config, no package.json — genuinely no
		// runner detectable yet.
		expect(client.detectRunner(tmpDir)).toBeNull();

		fs.writeFileSync(
			path.join(tmpDir, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);

		// Same client, same cwd: the config now exists, so detection must
		// converge instead of re-serving the earlier miss.
		expect(client.detectRunner(tmpDir)?.runner).toBe("vitest");
	});

	it("parses Vitest globs once the config appears, on the SAME client instance", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-2252-globs-");
		cleanups.push(cleanup);

		const client = new TestRunnerClient();

		expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();

		fs.writeFileSync(
			path.join(tmpDir, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);

		expect(client.parseVitestTestGlobs(tmpDir)).toEqual({
			include: ["tests/**/*.test.ts"],
		});
	});
});
