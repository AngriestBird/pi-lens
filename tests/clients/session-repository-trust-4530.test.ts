// flake-shape: real-process-spawn — each cell plants an executable that writes a marker file and asks the real spawn seam, PATH lookup and package-manager query to start it; whether the kernel ran the project's bytes is only observable from a real child.
/**
 * #4530: a bare lookup never runs the session repository's bytes while pi has
 * not trusted the project.
 *
 * The rule (`clients/session-repository.ts`): a file a LOOKUP would start (a
 * bare name resolved through a search path, a `which` answer, a global bin dir
 * entry) is refused, and a search-path entry is dropped, when pi trust is not
 * `trusted` and the kernel-real path belongs to the session repository: the
 * session root (this process's cwd, below HOME), the project-local bin dirs of
 * its ancestors below HOME, and every checkout sharing the session checkout's
 * git commondir. pi-lens's own data dir never counts.
 *
 * Every cell plants an executable that writes a marker file, starts it through
 * the production seam (`safeSpawnAsync`, `findGlobalBinary`, `findCommandAsync`,
 * the installer's PATH walk, `launchLSP`), and reads the marker: the marker is
 * the only independent evidence of which bytes the kernel ran. The cell ids
 * (F1..F13, I1..I15, A1..A13) are the failure list and state table in the PR.
 *
 * POSIX cells run on every POSIX lane; the planted scripts are `#!/bin/sh`.
 * The Windows cells (F13) run on the Windows lane only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { createAvailabilityLatch } from "../../clients/dispatch/runners/utils/availability-policy.js";
import {
	clearFormatterCache,
	gofmtFormatter,
} from "../../clients/formatters.js";
import {
	isCommandAvailable,
	isSpawnableCommand,
	resetPathWalkMemo,
} from "../../clients/installer/index.js";
import { launchLSP } from "../../clients/lsp/launch.js";
import {
	_resetJvmRuntimeCacheForTests,
	resolveJavaRuntimeEnv,
} from "../../clients/lsp/jvm-runtime.js";
import {
	_resetPackageManagerCache,
	findGlobalBinary,
} from "../../clients/package-manager.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	findCommandAsync,
	safeSpawnAsync,
	trustScopedSearchPath,
} from "../../clients/safe-spawn.js";
import {
	installPathProbeStub,
	type PathProbeStub,
	writeStandIn,
} from "../support/path-probe-stub.js";
import { withEnv } from "../support/with-env.js";
import { setupTestEnvironment } from "./test-utils.js";

const TOOL = "pi-lens-4530-tool";
const POSIX = process.platform !== "win32";

interface Layout {
	root: string;
	home: string;
	/** Main checkout of the session repository; the session root by default. */
	main: string;
	/** A linked worktree of `main`'s repository, beside it under HOME. */
	wt: string;
	/** A directory outside HOME and outside every checkout. */
	outside: string;
	/** pi-lens's data dir (PI_LENS_HOME), outside the session. */
	data: string;
}

let layout: Layout;
let stub: PathProbeStub;
let cleanups: Array<() => void> = [];
let originalCwd: string;

/** Real git metadata, written by hand: a main checkout and one linked worktree. */
function makeLayout(): Layout {
	const env = setupTestEnvironment("pi-lens-4530-trust-");
	cleanups.push(env.cleanup);
	const root = fs.realpathSync(env.tmpDir);
	const home = path.join(root, "home");
	const main = path.join(home, "main");
	const wt = path.join(home, "wt");
	const outside = path.join(root, "outside");
	const data = path.join(root, "data");
	for (const dir of [main, wt, outside, data])
		fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
	fs.writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
	const wtGitDir = path.join(main, ".git", "worktrees", "wt");
	fs.writeFileSync(path.join(wtGitDir, "HEAD"), "ref: refs/heads/wt\n");
	fs.writeFileSync(path.join(wtGitDir, "commondir"), "../..\n");
	fs.writeFileSync(path.join(wtGitDir, "gitdir"), `${path.join(wt, ".git")}\n`);
	fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGitDir}\n`);
	return { root, home, main, wt, outside, data };
}

/** An executable `TOOL` in `dir` that records, in `marker`, that it ran. */
function plant(dir: string, marker: string, name = TOOL): string {
	return writeStandIn(dir, name, `printf ran > '${marker}'`);
}

function ran(marker: string): boolean {
	return fs.existsSync(marker);
}

function trustRefusals(): string[] {
	return (
		getDegradationSummary()
			.find((group) => group.kind === "trust-refusal")
			?.latestReasons.map((entry) => entry.subject) ?? []
	);
}

function enterSession(dir: string): void {
	process.chdir(dir);
}

beforeEach(() => {
	originalCwd = process.cwd();
	resetProjectTrust();
	resetDegradationLedger();
	_resetPackageManagerCache();
	_resetJvmRuntimeCacheForTests();
	resetPathWalkMemo();
	clearFormatterCache();
	layout = makeLayout();
	cleanups.push(withEnv({ HOME: layout.home, PI_LENS_HOME: layout.data }));
	// Hermetic: PATH holds only the stub's stand-ins and the host's `which`,
	// so no lookup reaches a package manager the test did not plant.
	if (POSIX) {
		const stubRoot = path.join(layout.root, "stub-root");
		fs.mkdirSync(stubRoot);
		stub = installPathProbeStub(stubRoot);
		cleanups.push(() => stub.restore());
	}
	enterSession(layout.main);
});

afterEach(() => {
	process.chdir(originalCwd);
	for (const cleanup of cleanups.reverse()) cleanup();
	cleanups = [];
	resetProjectTrust();
	resetDegradationLedger();
	_resetPackageManagerCache();
	_resetJvmRuntimeCacheForTests();
	resetPathWalkMemo();
	clearFormatterCache();
});

describe.skipIf(!POSIX)("bare lookups under untrusted pi trust (#4530)", () => {
	it("F1/I5: refuses a linked worktree's bin dir and lets the global entry answer", async () => {
		const global = path.join(layout.outside, "global-bin");
		const projectMarker = path.join(layout.root, "project-ran");
		const globalMarker = path.join(layout.root, "global-ran");
		plant(path.join(layout.wt, "node_modules", ".bin"), projectMarker);
		plant(global, globalMarker);

		for (let run = 0; run < 2; run += 1) {
			const result = await safeSpawnAsync(TOOL, [], {
				cwd: layout.wt,
				env: { PATH: `node_modules/.bin${path.delimiter}${global}` },
				timeout: 10_000,
			});
			expect(result.status).toBe(0);
		}

		expect(ran(projectMarker)).toBe(false);
		expect(ran(globalMarker)).toBe(true);
		// One bounded row for the dropped entry, however many spawns met it.
		expect(trustRefusals()).toEqual([
			`project-path-entry:${path.join(layout.wt, "node_modules", ".bin")}`,
		]);
	});

	it("F2/I8: judges `link/..` where the kernel resolves it, not lexically", async () => {
		const marker = path.join(layout.root, "project-ran");
		fs.mkdirSync(path.join(layout.main, "sub"));
		plant(layout.main, marker);
		fs.symlinkSync(
			path.join(layout.main, "sub"),
			path.join(layout.outside, "link"),
		);
		const entry = `${path.join(layout.outside, "link")}${path.sep}..`;

		const result = await safeSpawnAsync(TOOL, [], {
			env: { PATH: entry },
			timeout: 10_000,
		});

		expect(result.status).not.toBe(0);
		expect(ran(marker)).toBe(false);
		expect(trustRefusals()).toEqual([`project-path-entry:${layout.main}`]);
		// The scoped search path the installer and launcher read agrees.
		expect(trustScopedSearchPath(entry)).toBeUndefined();
	});

	it("F3/I10: an absent PATH stays absent, so the system default path answers", async () => {
		const marker = path.join(layout.root, "project-ran");
		plant(layout.main, marker, "true");
		cleanups.push(withEnv({ PATH: undefined }));

		const result = await safeSpawnAsync("true", [], { timeout: 10_000 });

		expect(result.status).toBe(0);
		expect(ran(marker)).toBe(false);
		expect(trustRefusals()).toEqual([]);
	});

	it("F3/I1: a PATH that loses every entry is removed, never emptied (an empty PATH searches the cwd)", async () => {
		const marker = path.join(layout.root, "project-ran");
		plant(layout.main, marker, "true");

		const result = await safeSpawnAsync("true", [], {
			cwd: layout.main,
			env: { PATH: layout.main },
			timeout: 10_000,
		});

		expect(result.status).toBe(0);
		expect(ran(marker)).toBe(false);
		expect(trustRefusals()).toEqual([`project-path-entry:${layout.main}`]);
	});

	it("I2/I3: a relative or empty entry is the child's cwd, judged there", async () => {
		const marker = path.join(layout.root, "project-ran");
		plant(path.join(layout.main, "bin"), marker);

		for (const PATH of ["bin", `${path.delimiter}`]) {
			const cwd = PATH === "bin" ? layout.main : path.join(layout.main, "bin");
			const result = await safeSpawnAsync(TOOL, [], {
				cwd,
				env: { PATH },
				timeout: 10_000,
			});
			expect(result.status, PATH).not.toBe(0);
		}
		expect(ran(marker)).toBe(false);
	});

	it("F4/I9: pi-lens's own data dir is never project bytes, even under the session root", async () => {
		const data = path.join(layout.main, ".pi-lens-data");
		cleanups.push(withEnv({ PI_LENS_HOME: data }));
		const marker = path.join(layout.root, "managed-ran");
		plant(path.join(data, "bin"), marker);

		const result = await safeSpawnAsync(TOOL, [], {
			env: { PATH: path.join(data, "bin") },
			timeout: 10_000,
		});

		expect(result.status).toBe(0);
		expect(ran(marker)).toBe(true);
		expect(trustRefusals()).toEqual([]);
	});

	it("F5/I6: node_modules linked to the main checkout is the session repository's, from a worktree session", async () => {
		enterSession(layout.wt);
		const marker = path.join(layout.root, "project-ran");
		plant(path.join(layout.main, "node_modules", ".bin"), marker);
		fs.symlinkSync(
			path.join(layout.main, "node_modules"),
			path.join(layout.wt, "node_modules"),
		);

		for (const entry of [
			path.join(layout.wt, "node_modules", ".bin"),
			path.join(layout.main, "node_modules", ".bin"),
		]) {
			const result = await safeSpawnAsync(TOOL, [], {
				env: { PATH: entry },
				timeout: 10_000,
			});
			expect(result.status, entry).not.toBe(0);
		}
		expect(ran(marker)).toBe(false);
	});

	it("I4: an ancestor's hoisted bin dir below HOME is the session repository's", async () => {
		const pkg = path.join(layout.main, "packages", "app");
		fs.mkdirSync(pkg, { recursive: true });
		enterSession(pkg);
		// Not a git checkout this time: the ancestor walk alone must own it.
		fs.rmSync(path.join(layout.main, ".git"), { recursive: true });
		const marker = path.join(layout.root, "project-ran");
		plant(path.join(layout.main, "node_modules", ".bin"), marker);

		const result = await safeSpawnAsync(TOOL, [], {
			env: { PATH: path.join(layout.main, "node_modules", ".bin") },
			timeout: 10_000,
		});

		expect(result.status).not.toBe(0);
		expect(ran(marker)).toBe(false);
	});

	it("I7/A1: refuses a global entry that links into the project, by the link's target", async () => {
		const marker = path.join(layout.root, "project-ran");
		const target = plant(path.join(layout.main, "tools"), marker);
		const global = path.join(layout.outside, "global-bin");
		fs.mkdirSync(global);
		fs.symlinkSync(target, path.join(global, TOOL));

		const result = await safeSpawnAsync(TOOL, [], {
			env: { PATH: global },
			timeout: 10_000,
		});

		expect(result.spawnFailure?.kind).toBe("trust-refused");
		expect(result.status).toBeNull();
		expect(ran(marker)).toBe(false);
		expect(trustRefusals()).toEqual([`project-command:${target}`]);
	});

	it("A5: a `which` answer that links into the project is no answer", async () => {
		const marker = path.join(layout.root, "project-ran");
		const target = plant(path.join(layout.main, "tools"), marker);
		const global = path.join(layout.outside, "global-bin");
		fs.mkdirSync(global);
		fs.symlinkSync(target, path.join(global, TOOL));
		cleanups.push(
			withEnv({ PATH: `${process.env.PATH}${path.delimiter}${global}` }),
		);

		expect(await findCommandAsync(TOOL)).toBeNull();
		expect(trustRefusals()).toEqual([`project-command:${target}`]);
	});

	it("A5: a formatter's `which` answer that links into the project is no answer", async () => {
		const target = plant(
			path.join(layout.main, "tools"),
			path.join(layout.root, "unused"),
			"gofmt",
		);
		const global = path.join(layout.outside, "global-bin");
		fs.mkdirSync(global);
		const link = path.join(global, "gofmt");
		fs.symlinkSync(target, link);
		cleanups.push(
			withEnv({ PATH: `${process.env.PATH}${path.delimiter}${global}` }),
		);
		const file = path.join(layout.main, "main.go");

		expect(await gofmtFormatter.resolveCommand?.(file, layout.main)).toBeNull();
		setProjectTrustState("trusted");
		expect(await gofmtFormatter.resolveCommand?.(file, layout.main)).toEqual([
			link,
			"-w",
			file,
		]);
	});

	it("A9: the installer does not report a project binary as an installed tool", async () => {
		plant(path.join(layout.main, "bin"), path.join(layout.root, "unused"));
		cleanups.push(withEnv({ PATH: path.join(layout.main, "bin") }));

		expect(await isCommandAvailable(TOOL)).toBe(false);
		setProjectTrustState("trusted");
		expect(await isCommandAvailable(TOOL)).toBe(true);
	});

	it("A9: the memoized spawnability answer is kept per trust answer", async () => {
		plant(path.join(layout.main, "bin"), path.join(layout.root, "unused"));
		cleanups.push(withEnv({ PATH: path.join(layout.main, "bin") }));

		expect(await isSpawnableCommand(TOOL)).toBe(false);
		setProjectTrustState("trusted");
		expect(await isSpawnableCommand(TOOL)).toBe(true);
	});

	it("A6: the LSP launcher drops project entries that are not bin layouts", async () => {
		const marker = path.join(layout.root, "project-ran");
		plant(path.join(layout.main, "scripts"), marker);

		await expect(
			launchLSP(TOOL, [], {
				cwd: layout.main,
				env: { PATH: path.join(layout.main, "scripts") },
				startupFailureWindowMs: 200,
			}),
		).rejects.toThrow();
		expect(ran(marker)).toBe(false);
	});

	it("A6: the LSP launcher's child does not inherit project search-path entries", async () => {
		// A global server that runs a bare helper: the helper must not resolve
		// to the project's bytes through the child's own search path.
		const marker = path.join(layout.root, "project-ran");
		const projectBin = path.join(layout.main, "node_modules", ".bin");
		plant(projectBin, marker, "pi-lens-4530-helper");
		const global = path.join(layout.outside, "global-bin");
		writeStandIn(global, TOOL, "pi-lens-4530-helper; exit 3");

		const launched = await launchLSP(TOOL, [], {
			cwd: layout.main,
			env: { PATH: `${projectBin}${path.delimiter}${global}` },
			startupFailureWindowMs: 500,
		}).catch(() => undefined);
		launched?.process.kill("SIGKILL");

		expect(ran(marker)).toBe(false);
	});

	it("A6: the LSP launcher refuses a global link into the project", async () => {
		const marker = path.join(layout.root, "project-ran");
		const target = plant(path.join(layout.main, "tools"), marker);
		const global = path.join(layout.outside, "global-bin");
		fs.mkdirSync(global);
		fs.symlinkSync(target, path.join(global, TOOL));

		await expect(
			launchLSP(TOOL, [], {
				cwd: layout.main,
				env: { PATH: global },
				startupFailureWindowMs: 200,
			}),
		).rejects.toMatchObject({ kind: "trust-refused" });
		expect(ran(marker)).toBe(false);
	});
});

describe.skipIf(!POSIX)("cells the rule leaves admitted (#4530)", () => {
	it("F6/A12/A13: a trusted project (and every MCP host, which latches trusted) runs its own entry", async () => {
		setProjectTrustState("trusted");
		const marker = path.join(layout.root, "project-ran");
		plant(path.join(layout.wt, "node_modules", ".bin"), marker);

		const result = await safeSpawnAsync(TOOL, [], {
			cwd: layout.wt,
			env: { PATH: "node_modules/.bin" },
			timeout: 10_000,
		});

		expect(result.status).toBe(0);
		expect(ran(marker)).toBe(true);
		expect(trustRefusals()).toEqual([]);
	});

	it("I11: a session at HOME owns nothing, so HOME's own tool dirs stay usable", async () => {
		enterSession(layout.home);
		const marker = path.join(layout.root, "home-tool-ran");
		plant(path.join(layout.home, "bin"), marker);

		const result = await safeSpawnAsync(TOOL, [], {
			env: { PATH: path.join(layout.home, "bin") },
			timeout: 10_000,
		});

		expect(result.status).toBe(0);
		expect(ran(marker)).toBe(true);
	});

	it("I12: a dotfiles checkout rooted at HOME does not make HOME's tool dirs project bytes", async () => {
		// HOME is itself a checkout, and the session is a plain directory in it,
		// so the session's checkout is HOME's: the git clause stays off there.
		fs.mkdirSync(path.join(layout.home, ".git"));
		fs.writeFileSync(
			path.join(layout.home, ".git", "HEAD"),
			"ref: refs/heads/main\n",
		);
		const session = path.join(layout.home, "notes");
		fs.mkdirSync(session);
		enterSession(session);
		const marker = path.join(layout.root, "home-tool-ran");
		const bin = path.join(layout.home, ".local", "bin");
		plant(bin, marker);

		const result = await safeSpawnAsync(TOOL, [], {
			env: { PATH: bin },
			timeout: 10_000,
		});

		expect(result.status).toBe(0);
		expect(ran(marker)).toBe(true);
		expect(trustRefusals()).toEqual([]);
	});

	it("I15/A2: a file the caller names is not a lookup", async () => {
		const marker = path.join(layout.root, "named-ran");
		const named = plant(path.join(layout.main, "node_modules", ".bin"), marker);

		const result = await safeSpawnAsync(named, [], { timeout: 10_000 });

		expect(result.status).toBe(0);
		expect(ran(marker)).toBe(true);
	});
});

describe.skipIf(!POSIX)("package-manager global lookups (#4530)", () => {
	it("F9/A3: a global bin dir entry that links into the project is refused, one row per target", async () => {
		stub.plantManager("npm");
		const marker = path.join(layout.root, "project-ran");
		const target = plant(path.join(layout.main, "tools"), marker);
		const link = stub.plantGlobalBinary("npm", "placeholder");
		fs.symlinkSync(target, path.join(path.dirname(link), TOOL));

		expect(await findGlobalBinary(TOOL)).toBeUndefined();
		expect(await findGlobalBinary(TOOL)).toBeUndefined();
		expect(trustRefusals()).toEqual([`project-command:${target}`]);
		setProjectTrustState("trusted");
		expect(await findGlobalBinary(TOOL)).toBe(
			path.join(path.dirname(link), TOOL),
		);
	});

	it("F8/A4: project configuration cannot redirect the global-bin query", async () => {
		// The stand-in answers like npm does: a `.npmrc` in its cwd sets the
		// prefix. The redirected prefix sits OUTSIDE the session, so only the
		// query's cwd (not the target judgment) can keep it out.
		const redirected = path.join(layout.outside, "redirected");
		const honest = path.join(layout.root, "honest-prefix");
		fs.mkdirSync(path.join(honest, "bin"), { recursive: true });
		plant(path.join(redirected, "bin"), path.join(layout.root, "unused"));
		fs.writeFileSync(
			path.join(layout.main, ".npmrc"),
			`prefix=${redirected}\n`,
		);
		stub.plantOnPath(
			"npm",
			[
				`if [ "$*" != 'config get prefix' ]; then exit 1; fi`,
				`if [ -f .npmrc ]; then printf '%s\\n' '${redirected}'; else printf '%s\\n' '${honest}'; fi`,
			].join("\n"),
		);

		expect(await findGlobalBinary(TOOL)).toBeUndefined();
	});

	it("F8/A4: an answer made under trust never serves an untrusted lookup", async () => {
		// Trusted, the query runs in the project and reads its `.npmrc`; that
		// redirected answer must not be reused once the trust answer changes.
		const redirected = path.join(layout.outside, "redirected");
		const honest = path.join(layout.root, "honest-prefix");
		fs.mkdirSync(path.join(honest, "bin"), { recursive: true });
		const redirectedTool = plant(
			path.join(redirected, "bin"),
			path.join(layout.root, "unused"),
		);
		fs.writeFileSync(
			path.join(layout.main, ".npmrc"),
			`prefix=${redirected}\n`,
		);
		stub.plantOnPath(
			"npm",
			[
				`if [ "$*" != 'config get prefix' ]; then exit 1; fi`,
				`if [ -f .npmrc ]; then printf '%s\\n' '${redirected}'; else printf '%s\\n' '${honest}'; fi`,
			].join("\n"),
		);

		setProjectTrustState("trusted");
		expect(await findGlobalBinary(TOOL)).toBe(redirectedTool);
		resetProjectTrust();
		expect(await findGlobalBinary(TOOL)).toBeUndefined();
	});

	it("F11: two session cwds share one manager probe (no cwd in the key)", async () => {
		stub.plantManager("npm");

		await findGlobalBinary(TOOL);
		enterSession(layout.wt);
		await findGlobalBinary(TOOL);

		expect(stub.queries()).toEqual(["config get prefix"]);
	});

	it("F10/A11: Java resolves again after a trust flip", async () => {
		const jdk = path.join(layout.outside, "jdk");
		writeStandIn(path.join(jdk, "bin"), "java", "exit 0");
		writeStandIn(path.join(layout.main, "bin"), "java", "exit 0");
		cleanups.push(
			withEnv({
				JAVA_HOME: jdk,
				PATH: `${process.env.PATH}${path.delimiter}${path.join(layout.main, "bin")}`,
			}),
		);

		// Untrusted: the project's `java` is not on the search path, so the
		// discovered JDK is injected.
		expect((await resolveJavaRuntimeEnv())?.JAVA_HOME).toBe(jdk);
		setProjectTrustState("trusted");
		// Trusted: the PATH `java` answers, so nothing is injected.
		expect(await resolveJavaRuntimeEnv()).toBeUndefined();
	});

	it("A11: every availability verdict is dropped when pi's trust answer changes", () => {
		const latch = createAvailabilityLatch();
		latch.noteAvailable();
		expect(latch.read()).toBe(true);
		setProjectTrustState("trusted");
		expect(latch.read()).toBeNull();
		latch.noteUnavailable("missing", "not-found");
		expect(latch.read()).toBe(false);
	});
});

describe.runIf(!POSIX)(
	"Windows lookups under untrusted pi trust (#4530 F13)",
	() => {
		// lane: windows-vitest
		it("drops a project PATH entry, so PATHEXT never resolves the project's .cmd", async () => {
			const marker = path.join(layout.root, "project-ran");
			plant(path.join(layout.main, "bin"), marker);

			const result = await safeSpawnAsync(TOOL, [], {
				env: { PATH: path.join(layout.main, "bin"), PATHEXT: ".CMD;.EXE" },
				timeout: 10_000,
			});

			expect(result.status).not.toBe(0);
			expect(ran(marker)).toBe(false);
		});

		// lane: windows-vitest
		it("refuses the launcher's cwd-first search for an unresolved bare command", async () => {
			const marker = path.join(layout.root, "project-ran");
			plant(layout.main, marker);

			await expect(
				launchLSP(TOOL, [], {
					cwd: layout.main,
					env: { PATH: path.join(layout.outside, "empty"), PATHEXT: ".CMD" },
					startupFailureWindowMs: 500,
				}),
			).rejects.toMatchObject({ kind: "trust-refused" });
			expect(ran(marker)).toBe(false);
		});
	},
);
