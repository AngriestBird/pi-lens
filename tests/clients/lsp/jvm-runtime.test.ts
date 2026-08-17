import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../../clients/dispatch/runners/utils/availability-policy.js";
import { removeTempDirSync } from "../test-utils.js";

const isWin = process.platform === "win32";
const JAVA_EXE = isWin ? "java.exe" : "java";

const { safeSpawnAsync, allowedFsRoots } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	allowedFsRoots: [] as string[],
}));

// `jvm-runtime.ts` probes `java` through `safeSpawnAsync` directly (#1538),
// mirroring the #1496 package-manager fix — mock at that boundary. Also
// reimplement `isCommandAvailableAsync` (not `importOriginal`'d — the real
// function's internal `safeSpawnAsync` call is bound to its OWN module's
// unmocked binding, so importing it would bypass this mock and hit the real
// system PATH). Pre-fix `jvm-runtime.ts` probes through `isCommandAvailableAsync`;
// post-fix code calls `safeSpawnAsync` directly — routing both through the
// same hoisted mock lets one test file exercise both at the same boundary and
// prove the pre-fix code fails on its own logic, not a missing export.
vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	isCommandAvailableAsync: async (command: string) => {
		const finder = process.platform === "win32" ? "where" : "which";
		const result = await safeSpawnAsync(finder, [command], { timeout: 5000 });
		return result.status === 0 && !result.error;
	},
}));

// `discoverJdkHome`'s default `candidateRoots()` scans real per-platform
// install locations (Program Files\Eclipse Adoptium, /usr/lib/jvm, …), and
// `resolveJavaRuntimeEnv` calls it with no args — so on a dev/CI box that
// actually has a JDK installed, an unfenced test would "discover" the real
// one and the "no JDK on this host" scenarios could never be exercised.
// Fence `readdirSync` to only see directories tests explicitly register
// (their own tmp dirs); every other root reads as empty, same as `childDirs`
// already treats an unreadable root. `existsSync` (the direct JAVA_HOME
// check) is untouched.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: (base: string, options?: unknown) => {
			if (allowedFsRoots.some((root) => base.startsWith(root))) {
				return (actual.readdirSync as (...args: unknown[]) => unknown)(
					base,
					options,
				);
			}
			const error = new Error(`ENOENT: fenced for tests: ${base}`) as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		},
	};
});

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

/** A real `where`/`which` that ran fine and found nothing: genuine absence. */
const notFoundResult = { stdout: "", stderr: "", status: 1 };

const okResult = { stdout: "/usr/bin/java\n", stderr: "", status: 0 };

function finder(): string {
	return process.platform === "win32" ? "where" : "which";
}

function advancePastCooldown(): void {
	vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
}

describe("jvm-runtime — JDK discovery (#241)", () => {
	const dirs: string[] = [];
	let savedJavaHome: string | undefined;

	function tmpDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-jdk-"));
		dirs.push(dir);
		allowedFsRoots.push(dir);
		return dir;
	}

	/** Create a fake JDK home `<root>/<name>/bin/java[.exe]` and return its home. */
	function fakeJdk(root: string, name: string): string {
		const home = path.join(root, name);
		fs.mkdirSync(path.join(home, "bin"), { recursive: true });
		fs.writeFileSync(path.join(home, "bin", JAVA_EXE), "");
		return home;
	}

	beforeEach(async () => {
		const { _resetJvmRuntimeCacheForTests } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);
		_resetJvmRuntimeCacheForTests();
		safeSpawnAsync.mockReset();
		// Passing `undefined` for the javaHome arg re-activates its
		// `= process.env.JAVA_HOME` default, so a CI runner with JAVA_HOME set
		// (GitHub's Ubuntu image has one) would leak its real JDK into the scan.
		// Clear it so these tests see only the explicit `roots` they pass.
		savedJavaHome = process.env.JAVA_HOME;
		delete process.env.JAVA_HOME;
	});

	afterEach(() => {
		if (savedJavaHome === undefined) delete process.env.JAVA_HOME;
		else process.env.JAVA_HOME = savedJavaHome;
		for (const dir of dirs.splice(0)) {
			removeTempDirSync(dir);
		}
	});

	it("finds a JDK under a scanned root", async () => {
		const { discoverJdkHome } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);
		const root = tmpDir();
		const home = fakeJdk(root, "jdk-21.0.11.10-hotspot");
		expect(discoverJdkHome([root], undefined)).toBe(home);
	});

	it("picks the highest version among several", async () => {
		const { discoverJdkHome } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);
		const root = tmpDir();
		fakeJdk(root, "jdk-17.0.9");
		const newer = fakeJdk(root, "jdk-21.0.11");
		fakeJdk(root, "jdk-18.0.2");
		expect(discoverJdkHome([root], undefined)).toBe(newer);
	});

	it("ignores JDKs below the minimum major (17)", async () => {
		const { discoverJdkHome } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);
		const root = tmpDir();
		fakeJdk(root, "jdk1.8.0_402"); // legacy 8 — too old for jdtls
		fakeJdk(root, "jdk-11.0.20"); // 11 — too old
		expect(discoverJdkHome([root], undefined)).toBeUndefined();
	});

	it("honours an explicit JAVA_HOME over scanned roots", async () => {
		const { discoverJdkHome } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);
		const root = tmpDir();
		fakeJdk(root, "jdk-21.0.11");
		const javaHomeRoot = tmpDir();
		const javaHome = fakeJdk(javaHomeRoot, "my-jdk-17");
		expect(discoverJdkHome([root], javaHome)).toBe(javaHome);
	});

	it("returns undefined when no JDK exists", async () => {
		const { discoverJdkHome } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);
		expect(discoverJdkHome([tmpDir()], undefined)).toBeUndefined();
	});

	it("returns undefined when JAVA_HOME points at a non-JDK", async () => {
		const { discoverJdkHome } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);
		const bogus = tmpDir(); // no bin/java
		expect(discoverJdkHome([tmpDir()], bogus)).toBeUndefined();
	});
});

describe("jvm-runtime — resolveJavaRuntimeEnv (#241)", () => {
	const dirs: string[] = [];
	let savedJavaHome: string | undefined;

	function tmpDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-jdkenv-"));
		dirs.push(dir);
		allowedFsRoots.push(dir);
		return dir;
	}

	beforeEach(async () => {
		const { _resetJvmRuntimeCacheForTests } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);
		_resetJvmRuntimeCacheForTests();
		safeSpawnAsync.mockReset();
		// See the first describe block: clear the host's real JAVA_HOME so
		// `resolveJavaRuntimeEnv`'s unfenced `discoverJdkHome()` call can't pick
		// up an actual JDK on a dev/CI box; tests that need one set it back
		// explicitly, pointed at a fenced tmp dir.
		savedJavaHome = process.env.JAVA_HOME;
		delete process.env.JAVA_HOME;
		vi.useFakeTimers({ toFake: ["Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		if (savedJavaHome === undefined) delete process.env.JAVA_HOME;
		else process.env.JAVA_HOME = savedJavaHome;
		for (const dir of dirs.splice(0)) {
			removeTempDirSync(dir);
		}
	});

	it("injects nothing when java is already on PATH", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "java" ? okResult : notFoundResult,
		);
		const { resolveJavaRuntimeEnv } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);
		expect(await resolveJavaRuntimeEnv()).toBeUndefined();
	});

	it("injects JAVA_HOME + PATH from a discovered JDK when java is absent", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "java" ? notFoundResult : notFoundResult,
		);
		const { resolveJavaRuntimeEnv } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);
		const home = path.join(tmpDir(), "jdk-21");
		fs.mkdirSync(path.join(home, "bin"), { recursive: true });
		fs.writeFileSync(
			path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java"),
			"",
		);
		// JAVA_HOME has top discovery priority, so this exercises the env overlay
		// deterministically regardless of the host's real JDK installs.
		process.env.JAVA_HOME = home;

		const env = await resolveJavaRuntimeEnv();
		expect(env?.JAVA_HOME).toBe(home);
		expect(env?.PATH?.startsWith(path.join(home, "bin") + path.delimiter)).toBe(
			true,
		);
	});

	it("memoizes a durable verdict across calls", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "java" ? okResult : notFoundResult,
		);
		const { resolveJavaRuntimeEnv } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);
		await resolveJavaRuntimeEnv();
		await resolveJavaRuntimeEnv();
		const javaProbes = safeSpawnAsync.mock.calls.filter(
			([cmd, args]) => cmd === finder() && args[0] === "java",
		).length;
		expect(javaProbes).toBe(1);
	});

	/**
	 * THE regression proof (#1538): the `java` probe times out (a transient
	 * host-side 5 s budget expiry, the #1467 latch family's benign-direction
	 * sibling) and no JDK is discoverable on this host. Pre-fix, the timeout
	 * was indistinguishable from a genuine absence — both cached
	 * `{ value: undefined }` forever, pinning whatever ambient `JAVA_HOME` (or
	 * lack of one) happened to be in effect for the rest of the session.
	 * Post-fix, a transient verdict must not be cached: this call must FAIL on
	 * pre-fix code, which returns `undefined` from BOTH calls with only one
	 * probe recorded (latched after the first).
	 */
	it("a timed-out probe is not cached: retried on the next demand call", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "java" ? timeoutResult : notFoundResult,
		);
		const { resolveJavaRuntimeEnv } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);

		expect(await resolveJavaRuntimeEnv()).toBeUndefined();
		// The transient verdict's own short cooldown (#1467's policy) means an
		// IMMEDIATE re-call correctly doesn't re-probe yet — that's the "short
		// cooldown so repeated calls don't pay 5s each" half of the fix. Advance
		// past it to prove the verdict was never latched for the SESSION.
		advancePastCooldown();
		expect(await resolveJavaRuntimeEnv()).toBeUndefined();

		const javaProbes = safeSpawnAsync.mock.calls.filter(
			([cmd, args]) => cmd === finder() && args[0] === "java",
		).length;
		// Pre-fix: the first timeout latches `false` forever, so the second call
		// hits the `_cachedEnv` memo and never re-probes — this assertion fails
		// (probes stays at 1). Post-fix: a transient verdict is never cached, so
		// resolveJavaRuntimeEnv re-probes once its cooldown expires.
		expect(javaProbes).toBeGreaterThan(1);
	});

	it("a genuine absence (no JDK, no java) caches: not re-probed", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "java" ? notFoundResult : notFoundResult,
		);
		const { resolveJavaRuntimeEnv } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);

		expect(await resolveJavaRuntimeEnv()).toBeUndefined();
		expect(await resolveJavaRuntimeEnv()).toBeUndefined();

		const javaProbes = safeSpawnAsync.mock.calls.filter(
			([cmd, args]) => cmd === finder() && args[0] === "java",
		).length;
		expect(javaProbes).toBe(1);
	});

	it("recovers after a transient failure: a later successful probe is used, not the stall", async () => {
		let call = 0;
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === finder() && args[0] === "java") {
				call += 1;
				return call === 1 ? timeoutResult : okResult;
			}
			return notFoundResult;
		});
		const { resolveJavaRuntimeEnv } = await import(
			"../../../clients/lsp/jvm-runtime.js"
		);

		// First call: probe stalls, no JDK discoverable — falls back to
		// undefined (no override) for THIS call, but must not cache it.
		expect(await resolveJavaRuntimeEnv()).toBeUndefined();
		// Second call, past the transient cooldown: `java` is reachable again —
		// correctly discovered and (since java is now on PATH) still no override
		// needed, but this time as a DURABLE verdict, proven by the probe having
		// run again.
		advancePastCooldown();
		expect(await resolveJavaRuntimeEnv()).toBeUndefined();

		const javaProbes = safeSpawnAsync.mock.calls.filter(
			([cmd, args]) => cmd === finder() && args[0] === "java",
		).length;
		expect(javaProbes).toBe(2);

		// Now durable: a third call must not probe again.
		expect(await resolveJavaRuntimeEnv()).toBeUndefined();
		const javaProbesAfter = safeSpawnAsync.mock.calls.filter(
			([cmd, args]) => cmd === finder() && args[0] === "java",
		).length;
		expect(javaProbesAfter).toBe(2);
	});
});
