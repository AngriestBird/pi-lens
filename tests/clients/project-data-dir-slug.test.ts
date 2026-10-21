// flake-shape: real-process-spawn — two real Node children must contend on the
// production rename; an in-process mock cannot expose the cross-process ENOENT.
/**
 * #2874: `getProjectDataDir`'s slug folded separators to `-`, so two roots
 * differing only in separator-vs-hyphen placement (`src/pi-lens` vs
 * `src/pi/lens`) shared one data directory. The slug now appends an 8-hex
 * SHA-256 of the canonical absolute root, and a pre-hash directory is
 * renamed once on first use.
 *
 * Probe hygiene: scratch roots live under `os.tmpdir()` (outside the
 * worktree); `PILENS_DATA_DIR`/`PI_LENS_HOME` are pointed at per-test temp
 * dirs and restored afterwards. The real HOME is never touched.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const realpathState = vi.hoisted(() => ({ fail: false }));
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	// Only the slug's boundary probe (`fs.realpathSync`) fails on demand. The
	// replacement keeps the real `.native`: `clients/path-utils.ts` keys by it,
	// and a double without it made every key in this file fall back to the
	// spelling, so the #4689 cell below could not see the identity arm.
	const realpathSync = Object.assign(
		(...args: Parameters<typeof actual.realpathSync>) => {
			if (realpathState.fail) {
				throw Object.assign(new Error("temporary failure"), { code: "EACCES" });
			}
			return actual.realpathSync(...args);
		},
		{ native: actual.realpathSync.native },
	);
	return { ...actual, realpathSync };
});
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { getDisposition } from "../../clients/diagnostic-dispositions.js";
import {
	drainProjectDataDirMigrations,
	getProjectDataDir,
	_resetProjectDataDirMemoForTests,
} from "../../clients/file-utils.js";
import { dataDir444 } from "../support/data-dir-4-4-4.js";

const FIXTURES = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
);
const savedDataDir = process.env.PILENS_DATA_DIR;
const savedHome = process.env.PI_LENS_HOME;

// Every temp dir this file creates, removed in afterEach (#2929 round 4, F5:
// the 80-iteration race loop left 464 /tmp/pi-lens-datadir-base-* behind).
const tempDirs: string[] = [];

function isolateDataDir(): string {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-datadir-base-"));
	tempDirs.push(base);
	process.env.PILENS_DATA_DIR = base;
	process.env.PI_LENS_HOME = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-datadir-home-"),
	);
	tempDirs.push(process.env.PI_LENS_HOME);
	return base;
}

function makeScratch(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function runRealProcess(
	env: NodeJS.ProcessEnv,
	script: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", script], {
			cwd: process.cwd(),
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let error = "";
		// The child is always reaped: kill-on-settle is a no-op after a clean
		// exit and bounds the orphan window when the child hangs (#2929 F5).
		const kill = () => {
			try {
				child.kill();
			} catch {
				// Already exited; nothing to reap.
			}
		};
		child.stdout.on("data", (chunk: Buffer) => (output += chunk));
		child.stderr.on("data", (chunk: Buffer) => (error += chunk));
		child.on("error", (err) => {
			kill();
			reject(err);
		});
		child.on("exit", (code) => {
			kill();
			if (code === 0) resolve(output.trim());
			else reject(new Error(`child exited ${code}: ${error}`));
		});
	});
}

afterEach(() => {
	if (savedDataDir === undefined) {
		delete process.env.PILENS_DATA_DIR;
	} else {
		process.env.PILENS_DATA_DIR = savedDataDir;
	}
	if (savedHome === undefined) {
		delete process.env.PI_LENS_HOME;
	} else {
		process.env.PI_LENS_HOME = savedHome;
	}
	drainProjectDataDirMigrations();
	resetDegradationLedger();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("project data-dir slug (#2874)", () => {
	it("gives separator/hyphen twins distinct directories", () => {
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-twins-");
		const rootA = path.join(scratch, "src", "pi-lens");
		const rootB = path.join(scratch, "src", "pi", "lens");
		fs.mkdirSync(rootA, { recursive: true });
		fs.mkdirSync(rootB, { recursive: true });

		const dirA = getProjectDataDir(rootA);
		const dirB = getProjectDataDir(rootB);

		expect(dirA.startsWith(base)).toBe(true);
		expect(dirB.startsWith(base)).toBe(true);
		expect(dirB).not.toBe(dirA);
		// No state leak across the twins: a file in A's directory is
		// invisible from B's.
		fs.mkdirSync(dirA, { recursive: true });
		fs.writeFileSync(path.join(dirA, "marker.json"), "{}");
		expect(fs.existsSync(path.join(dirB, "marker.json"))).toBe(false);
	});

	it("returns the same directory for the same root across calls", () => {
		isolateDataDir();
		const scratch = makeScratch("pi-lens-stable-");
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const first = getProjectDataDir(root);
		const second = getProjectDataDir(root);
		const trailingSlash = getProjectDataDir(`${root}${path.sep}`);

		expect(second).toBe(first);
		expect(trailingSlash).toBe(first);
	});

	it("a root spelled through a link names its real path's directory (#4689)", () => {
		// RECURRENCE GUARDED: #4689 round 4. The name came from the caller's
		// spelling while dispatch and the runtime hold the realpath, so one
		// link-rooted session wrote two data dirs: the turn state, the change
		// log and the mark store each split between them (r3 probe: getLensDir
		// opened 38 times by identity and 222 by spelling).
		isolateDataDir();
		const scratch = makeScratch("pi-lens-symlink-");
		const target = path.join(scratch, "target", "proj");
		const linkParent = path.join(scratch, "linked");
		fs.mkdirSync(target, { recursive: true });
		fs.mkdirSync(linkParent);
		fs.symlinkSync(path.join(scratch, "target"), path.join(linkParent, "root"));

		const linked = getProjectDataDir(path.join(linkParent, "root", "proj"));
		// win32 names have never followed the realpath (canonicalProjectRoot).
		if (process.platform === "win32")
			expect(linked).not.toBe(getProjectDataDir(target));
		else expect(linked).toBe(getProjectDataDir(target));
	});

	it("a root spelled through a link still reads the marks 4.4.4 wrote under that spelling (#4689)", (ctx) => {
		// RECURRENCE GUARDED: review r1 F2. A session rooted at a link (an
		// alias root, macOS `/var`, a symlinked home) must not lose its marks,
		// review graph and snapshot on upgrade. The store below is the one
		// 4.4.4 wrote (tests/fixtures/data-dir-4.4.4), placed where 4.4.4 put
		// it, and the directory the real path names adopts it.
		if (process.platform === "win32")
			return ctx.skip("the win32 name never moved");
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-alias-slug-");
		const real = path.join(scratch, "realproj");
		const alias = path.join(scratch, "aliasproj");
		fs.mkdirSync(path.join(real, ".git"), { recursive: true });
		fs.symlinkSync("realproj", alias, "dir");

		const written = dataDir444(base, alias);
		fs.mkdirSync(path.join(written, "cache"), { recursive: true });
		fs.copyFileSync(
			path.join(
				FIXTURES,
				"data-dir-4.4.4",
				"cache",
				"diagnostic-dispositions.json",
			),
			path.join(written, "cache", "diagnostic-dispositions.json"),
		);

		expect(getProjectDataDir(alias)).toBe(getProjectDataDir(real));
		expect(getProjectDataDir(alias)).not.toBe(written);
		expect(getDisposition(alias, "ddw:ec76942a8ce3")?.disposition).toBe(
			"suppress",
		);
		expect(getDisposition(real, "ddw:ec76942a8ce3")?.disposition).toBe(
			"suppress",
		);
		expect(
			fs.existsSync(
				path.join(written, "cache", "diagnostic-dispositions.json"),
			),
		).toBe(true);
	});

	it("realpath failure keeps the resolved directory stable and records fallback", () => {
		isolateDataDir();
		const scratch = makeScratch("pi-lens-realpath-");
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });
		const healthy = getProjectDataDir(root);
		_resetProjectDataDirMemoForTests();
		realpathState.fail = true;
		try {
			expect(getProjectDataDir(root)).toBe(healthy);
			const notices = drainProjectDataDirMigrations();
			expect(notices).toHaveLength(1);
			expect(notices[0]?.outcome).toBe("identity-fallback");
			expect(notices[0]?.to).toBe(healthy);
		} finally {
			realpathState.fail = false;
		}
	});

	it("two processes converge on one migrated directory", async () => {
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-race-");
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });
		const hashedDir = getProjectDataDir(root);
		const oldDir = path.join(
			base,
			path.basename(hashedDir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "sessions.json"), "{}\n");
		_resetProjectDataDirMemoForTests();
		const barrier = path.join(scratch, "release");
		const readyA = path.join(scratch, "ready-a");
		const readyB = path.join(scratch, "ready-b");
		const script = [
			"const fs = require('node:fs');",
			"const { getProjectDataDir } = require('./clients/file-utils.js');",
			"const ready = process.env.READY_FILE;",
			"fs.writeFileSync(ready, 'ready');",
			"(async () => {",
			"  const t0 = Date.now();",
			"  while (!fs.existsSync(process.env.BARRIER_FILE)) {",
			"    if (Date.now() - t0 > 30000) { console.error('barrier timeout'); process.exit(1); }",
			"    await new Promise((r) => setTimeout(r, 1));",
			"  }",
			`  process.stdout.write(getProjectDataDir(${JSON.stringify(root)}));`,
			"})().catch((e) => { console.error(e); process.exit(1); });",
		].join("\n");
		const childEnv = {
			...process.env,
			PILENS_DATA_DIR: base,
			PI_LENS_HOME: path.join(scratch, "home"),
			BARRIER_FILE: barrier,
		};
		const first = runRealProcess({ ...childEnv, READY_FILE: readyA }, script);
		const second = runRealProcess({ ...childEnv, READY_FILE: readyB }, script);
		// Observe early child failures now: without these the ready loop below
		// would spin to its deadline while the rejection waits for Promise.all.
		void first.catch(() => {});
		void second.catch(() => {});
		const waitStart = Date.now();
		while (!fs.existsSync(readyA) || !fs.existsSync(readyB)) {
			if (Date.now() - waitStart > 30_000) {
				throw new Error("race children never became ready");
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		fs.writeFileSync(barrier, "go");
		const dirs = await Promise.all([first, second]);
		expect(dirs[0]).toBe(dirs[1]);
		expect(dirs[0]).toBe(hashedDir);
		expect(fs.existsSync(path.join(hashedDir, "sessions.json"))).toBe(true);
		expect(fs.existsSync(oldDir)).toBe(false);
	});

	it("migrates an old-slug directory by rename and preserves its contents", () => {
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-migrate-");
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const dir = getProjectDataDir(root);
		// The pre-#2874 name is the new basename without its trailing hash.
		const oldDir = path.join(
			base,
			path.basename(dir).replace(/-[0-9a-f]{8}$/, ""),
		);
		expect(oldDir).not.toBe(dir);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "marker.json"), '{"kept":true}');
		_resetProjectDataDirMemoForTests();

		const settled = getProjectDataDir(root);

		expect(settled).toBe(dir);
		expect(fs.existsSync(oldDir)).toBe(false);
		expect(fs.readFileSync(path.join(settled, "marker.json"), "utf8")).toBe(
			'{"kept":true}',
		);
	});

	it("prefers the new directory when both old and new exist", () => {
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-both-");
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const dir = getProjectDataDir(root);
		const oldDir = path.join(
			base,
			path.basename(dir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "old.txt"), "old");
		fs.writeFileSync(path.join(dir, "new.txt"), "new");
		_resetProjectDataDirMemoForTests();

		const settled = getProjectDataDir(root);

		expect(settled).toBe(dir);
		expect(fs.existsSync(path.join(settled, "new.txt"))).toBe(true);
		expect(fs.existsSync(oldDir)).toBe(true);
	});

	it("rename failure keeps the legacy directory and records rename-failed", () => {
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-rename-failure-");
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });
		const hashedDir = getProjectDataDir(root);
		const oldDir = path.join(
			base,
			path.basename(hashedDir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		_resetProjectDataDirMemoForTests();
		const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});
		try {
			const settled = getProjectDataDir(root);
			expect(settled).toBe(oldDir);
			const notices = drainProjectDataDirMigrations();
			expect(notices).toHaveLength(1);
			expect(notices[0]?.outcome).toBe("rename-failed");
			expect(notices[0]?.to).toBe(hashedDir);
			expect(notices[0]?.to).not.toBe(settled);
		} finally {
			rename.mockRestore();
		}
	});
});

/** Every file of a 4.4.4 alias-rooted session's data dir that names no absolute path. */
const ALIAS_SESSION_444 = path.join(
	FIXTURES,
	"data-dir-4.4.4",
	"alias-session",
);

function filesUnder(dir: string, rel = ""): string[] {
	return fs
		.readdirSync(path.join(dir, rel), { withFileTypes: true })
		.flatMap((entry) => {
			const child = path.join(rel, entry.name);
			return entry.isDirectory() ? filesUnder(dir, child) : [child];
		});
}

describe("adopting the data dir a link spelling named (#4689 round 4)", () => {
	// RECURRENCE GUARDED: #4689 round 4, maintainer decision 2026-10-21. The
	// data dir moved from the link spelling's name to the real path's, so
	// everything 4.4.4 stored for a link-rooted project must be carried over
	// once, never overwrite newer data, and leave the old directory intact.
	function aliasRoot(
		prefix: string,
	): { base: string; alias: string; spelled: string } | undefined {
		if (process.platform === "win32") return undefined;
		const base = isolateDataDir();
		const scratch = makeScratch(prefix);
		fs.mkdirSync(path.join(scratch, "realproj"));
		const alias = path.join(scratch, "aliasproj");
		fs.symlinkSync("realproj", alias, "dir");
		const spelled = dataDir444(base, alias);
		fs.cpSync(ALIAS_SESSION_444, spelled, { recursive: true });
		return { base, alias, spelled };
	}

	it("copies every file byte for byte, keeps the old dir and records adopted", (ctx) => {
		const fx = aliasRoot("pi-lens-adopt-");
		if (!fx) return ctx.skip("the win32 name never moved");
		// Not data: a lock directory, a lock file and an atomic-write stage.
		fs.mkdirSync(path.join(fx.spelled, "cache", "x.json.locks"));
		fs.writeFileSync(
			path.join(fx.spelled, "cache", "x.json.locks", "lock.1"),
			"1",
		);
		fs.writeFileSync(path.join(fx.spelled, "cache", "y.lock"), "1");
		fs.writeFileSync(path.join(fx.spelled, "cache", "z.json.tmp-1-0-0"), "{");

		const dir = getProjectDataDir(fx.alias);

		const expected = filesUnder(ALIAS_SESSION_444).sort();
		expect(expected.length).toBeGreaterThan(0);
		expect(filesUnder(dir).sort()).toEqual(expected);
		for (const file of expected) {
			expect(fs.readFileSync(path.join(dir, file))).toEqual(
				fs.readFileSync(path.join(ALIAS_SESSION_444, file)),
			);
			expect(fs.existsSync(path.join(fx.spelled, file))).toBe(true);
		}
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopted" },
		]);
	});

	it("never overwrites a file the real path's directory already holds", (ctx) => {
		const fx = aliasRoot("pi-lens-adopt-keep-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const real = fs.realpathSync.native(fx.alias);
		const dir = getProjectDataDir(real);
		const newer = path.join(dir, "cache", "diagnostic-dispositions.json");
		fs.mkdirSync(path.dirname(newer), { recursive: true });
		fs.writeFileSync(newer, '{"dispositions":{}}');
		_resetProjectDataDirMemoForTests();

		expect(getProjectDataDir(fx.alias)).toBe(dir);

		expect(fs.readFileSync(newer, "utf8")).toBe('{"dispositions":{}}');
		expect(fs.existsSync(path.join(dir, "cache", "todo-baseline.json"))).toBe(
			true,
		);
	});

	it("records adopt-failed when a file cannot be copied, and leaves it where it was", (ctx) => {
		const fx = aliasRoot("pi-lens-adopt-fail-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const real = fs.realpathSync.native(fx.alias);
		const dir = getProjectDataDir(real);
		// A file where the copy needs a directory.
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "cache"), "");
		_resetProjectDataDirMemoForTests();
		drainProjectDataDirMigrations();

		getProjectDataDir(fx.alias);

		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopt-failed" },
		]);
		expect(
			fs.existsSync(path.join(fx.spelled, "cache", "todo-baseline.json")),
		).toBe(true);
	});

	it("copies at most 4096 files and records the rest as not adopted", (ctx) => {
		const fx = aliasRoot("pi-lens-adopt-cap-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const bulk = path.join(fx.spelled, "bulk");
		fs.mkdirSync(bulk);
		for (let i = 0; i < 4100; i++)
			fs.writeFileSync(path.join(bulk, `${i}.json`), "");

		const dir = getProjectDataDir(fx.alias);

		expect(filesUnder(dir)).toHaveLength(4096);
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopt-failed" },
		]);
	});
});
