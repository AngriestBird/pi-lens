/**
 * A private `PI_LENS_HOME` for one test file's lifetime (#3721, folding the
 * inline `vi.hoisted` pins of #3669 and #3682).
 *
 * WHY A FILE NEEDS ONE. `tests/support/vitest-setup.ts` pins ONE
 * `PI_LENS_HOME` for the whole vitest run, so every worker shares
 * `latency.log`, `sessionstart.log`, `instances.json` and the stamps beside
 * them. The loggers freeze their paths when they LOAD, so a pin made inside a
 * test body moves nothing: it has to run before the first import. A file that
 * drives a real `session_start` while sharing that home appends rows to, and
 * (through `clearLatencyLog`) truncates rows out of, whichever reader runs
 * beside it: `config-resolved-phase` redded in 3 of 5 overlapping runs (#3682),
 * and `index-session-start-classification-wiring` failed in batch runs because
 * the untouched 3190 witness wrote an extra latency row (#3732 verify).
 *
 * USE. Hoisted, before any import, then released in `afterAll`:
 *
 *     const lensHome = await vi.hoisted(async () =>
 *       (await import("./support/private-lens-home.js")).pinPrivateLensHome("tag"),
 *     );
 *     afterAll(() => lensHome.release());
 *
 * The call has to be an async import inside `vi.hoisted` because a hoisted
 * body runs before the file's own static imports exist. This module imports
 * only node builtins at load, so that early import cannot load a logger.
 * `tests/clients/pi-lens-home-hermeticity.test.ts` walks `tests/` and fails a
 * file that imports the extension entry (or drives a real `handleSessionStart`
 * with test mode off) without this call inside `vi.hoisted`.
 */
import * as path from "node:path";

export interface PrivateLensHome {
	/** The private directory `PI_LENS_HOME` now names. */
	readonly home: string;
	/**
	 * Flush every deferred writer that can recreate the home (project-snapshot,
	 * review-graph, extension-log, `latency.log`, `sessionstart.log`, probe-cache), remove
	 * it, and restore the previous `PI_LENS_HOME`. The restore sits in `finally`;
	 * a flush that cannot run (a file that mocks a logger away) skips only itself.
	 */
	release(): Promise<void>;
}

export function pinPrivateLensHome(tag: string): PrivateLensHome {
	const previous = process.env.PI_LENS_HOME;
	const base = previous ?? path.join(process.cwd(), ".probe-home");
	const home = path.join(base, `pi-lens-${tag}-home-${process.pid}`);
	process.env.PI_LENS_HOME = home;
	return {
		home,
		async release(): Promise<void> {
			try {
				// Loaded here, at call time: this module is imported before any
				// logger may load.
				const { drainBackgroundWritesForTests, removeTempDirSync } =
					await import("../clients/test-utils.js");
				const flushes: Array<() => Promise<unknown>> = [
					() => drainBackgroundWritesForTests(),
					async () =>
						(await import("../../clients/latency-logger.js")).flushLatencyLog(),
					async () =>
						(
							await import("../../clients/sessionstart-logger.js")
						).flushSessionStartLog(),
					// The probe cache persists on a 300ms unref'd timer into a path
					// fixed at module load, i.e. into this home: left alone it
					// recreates the home after the removal below.
					async () =>
						(
							await import("../../clients/installer/index.js")
						).flushProbeCache(),
				];
				for (const flush of flushes) {
					try {
						await flush();
					} catch {
						// best effort: the removal below is what matters
					}
				}
				removeTempDirSync(home);
			} finally {
				if (previous === undefined) delete process.env.PI_LENS_HOME;
				else process.env.PI_LENS_HOME = previous;
			}
		},
	};
}
