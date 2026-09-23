import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";
import {
	cleanupTmpHygiene,
	removeRunBackstopDirs,
	unadmittedRootBackstopEntries,
	tmpHygieneAdmissionFor,
	tmpHygieneLeakReport,
	tmpHygieneObservedEntries,
	tmpHygieneExcludeLiveOwnerEntries,
	tmpHygieneWaitForOwnerDrain,
	tmpHygieneUnadmittedEntries,
} from "../support/vitest-setup.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import {
	buildProjectSnapshotFromRuntime,
	getProjectSnapshotPath,
	saveProjectSnapshot,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

// Tmp-fixture hygiene governance (#2912). The setup hook in
// tests/support/vitest-setup.ts keeps the REAL TMPDIR: it never repoints
// TMPDIR/TMP/TEMP, so the gate watches the same /tmp namespace production
// uses. At each test-file load it snapshots the existing `pi-lens-`-prefixed
// entries there; each file's afterAll reports additions, and this file, the
// serialized governance owner that runs after every other project, reds on
// new unadmitted entries in its afterAll and removes them after the
// assertion. Per-file teardown is the ONLY containment: a raw mkdtempSync
// root is contained solely by its owning file's teardown, and a deferred
// producer that writes after teardown recreates it. The admission baseline in
// tests/config/tmp-fixture-hygiene-baseline.json is a shrink-only ratchet
// over the entries that outlive their owning file. This sweep keeps the
// mkdtemp population observable: each site's parent must derive from the real
// tmpdir (os.tmpdir()/the ambient TMPDIR at call time), stay repo-rooted, or
// use the sanctioned scratch seam, so every fixture it creates is either
// watched by the prefix diff, never tmpfs, or self-swept.

const MKTEMP_CALLEE = /\bmkdtempSync\s*\(|\bmkdtemp\s*\(/g;
const TMPDIR_SOURCE = /\bos\.tmpdir\s*\(\s*\)|[^a-zA-Z]tmpdir\s*\(\s*\)/;
const TMPDIR_ENV_SOURCE = /process\.env\.TMPDIR/;
// Repo-rooted parents never enter /tmp, so the prefix snapshot cannot observe
// them. They are repo pollution of a different class (tracked-but-ignored
// `.probe-*` dirs), not tmpfs inodes.
const REPO_ROOTED_SOURCE =
	/\bREPO_ROOT\b|process\.cwd\s*\(\s*\)|\brepositoryRoot\b|\brepoRoot\b/;
// The sanctioned scratch seam (scripts/lib/scratch-dir.mjs) owns its
// lifecycle (owner.pid + sweepScratchDirs); sites under it are not strays.
const SCRATCH_SEAM_SOURCE = /\bSCRATCH_DIR_ROOT\b/;
const HARDCODED_TMP = /(["'`])\/tmp\//;

function scanMkdtempSites(): { file: string; line: number; text: string }[] {
	const roots = [
		path.join(REPO_ROOT, "tests"),
		path.join(REPO_ROOT, "scripts"),
	];
	const sites: { file: string; line: number; text: string }[] = [];
	let fileCount = 0;
	for (const root of roots) {
		// readWalkedFiles: a path that vanished between the walk and the read is
		// out of the population, not a finding (#3082).
		for (const { file, source: raw } of readWalkedFiles(
			listSourceFiles(root, { extensions: [".ts", ".mjs"] }),
		)) {
			fileCount += 1;
			const code = stripSource(raw);
			const lines = code.split("\n");
			for (const [index, line] of lines.entries()) {
				MKTEMP_CALLEE.lastIndex = 0;
				if (!MKTEMP_CALLEE.test(line)) continue;
				sites.push({
					file: path.relative(REPO_ROOT, file).replace(/\\/g, "/"),
					line: index + 1,
					text: line.trim().slice(0, 160),
				});
			}
		}
	}
	assertNonEmptyScan("mkdtemp population", sites.length, 50);
	assertNonEmptyScan("mkdtemp file population", fileCount, 100);
	return sites;
}

function ownerForTmpEntry(entry: string): string | undefined {
	for (const { file, source } of readWalkedFiles(
		listSourceFiles(path.join(REPO_ROOT, "tests"), { extensions: [".ts"] }),
	)) {
		const match = source.matchAll(/setupTestEnvironment\(\s*["']([^"']+)["']/g);
		for (const [, prefix] of match) {
			if (entry.startsWith(prefix))
				return path
					.relative(REPO_ROOT, file)
					.replace(/\\/g, "/")
					.replace(/^tests\//, "");
		}
	}
	return undefined;
}

describe("tmp-fixture-hygiene", () => {
	afterAll(async () => {
		const liveOwners = await tmpHygieneWaitForOwnerDrain();
		const { testFile, leftovers } = tmpHygieneLeakReport();
		const attributable = tmpHygieneExcludeLiveOwnerEntries(
			leftovers,
			ownerForTmpEntry,
			liveOwners,
		);
		const described = attributable.map((entry) => {
			const owner = ownerForTmpEntry(entry);
			return `${entry} (owner: tests/${owner ?? "unknown"})`;
		});
		try {
			expect(
				attributable,
				`[tmp-hygiene] tests/${testFile} leaked ${attributable.length} top-level entries: ${described.join(",")}; live owners: ${[...liveOwners].join(",") || "none"}`,
			).toEqual([]);
		} finally {
			cleanupTmpHygiene();
		}
	});

	it("routes every tests/ and scripts/ mkdtemp parent through a contained root", () => {
		const escapees = scanMkdtempSites().filter((site) => {
			if (site.file === "tests/support/vitest-setup.ts") return false;
			const file = path.join(REPO_ROOT, site.file);
			const raw = readWalkedFile(file);
			if (raw === undefined) return false;
			const rawLines = raw.split("\n");
			// Multi-line calls carry path.join(os.tmpdir(), ...) on the
			// following lines; read the call window, not the call line.
			const window = rawLines.slice(site.line - 1, site.line + 2).join("\n");
			if (HARDCODED_TMP.test(window)) return true;
			if (TMPDIR_SOURCE.test(window)) return false;
			if (TMPDIR_ENV_SOURCE.test(window)) return false;
			if (REPO_ROOTED_SOURCE.test(window)) return false;
			if (SCRATCH_SEAM_SOURCE.test(window)) return false;
			// claimScratchDir IS the seam: it takes the caller's root.
			if (site.file === "scripts/lib/scratch-dir.mjs") return false;
			// One-hop const: a child of a tmpdir-derived `const root`.
			const parentId = window.match(
				/mkdtempSync\(\s*path\.join\(\s*([A-Za-z_$][\w$]*)\s*,/,
			)?.[1];
			if (parentId) {
				const decl = new RegExp(
					`const ${parentId} = [^;]*mkdtemp[^;]*tmpdir\\s*\\(`,
					"s",
				);
				if (decl.test(raw)) return false;
			}
			return true;
		});
		expect(
			escapees.map((site) => `${site.file}:${site.line}: ${site.text}`),
		).toEqual([]);
	});

	// PR #3100 review F2: #3083's per-file backstop directories live under the
	// run-shared home, which no owner removes, and round 1's
	// `process.once("exit")` never fired under vitest's SIGTERM fork teardown —
	// two green runs left one, then two, directories holding real stamps. This
	// file is the owner that sweeps them, dead last, when no worker is alive to
	// recreate one from a delayed callback; the sibling row is the recurrence in
	// the other direction, a second vitest invocation sharing this checkout's
	// `.probe-home` losing its live directory to our sweep.
	// The planted directories hold a nested `stamp.json` standing in for the real
	// cooldown stamp, so the sweep is proven to remove a NON-EMPTY tree. The
	// production filename is deliberately not spelled here: the #3042
	// registry-isolation sweep in tests/clients/pi-lens-home-hermeticity.test.ts
	// flags any file naming a producer's target filename beside PI_LENS_HOME
	// without its own pin, and this owner cannot pin a home — the run-shared one
	// is its subject. Comments are blanked before that scan, so this note neither
	// trips nor excuses it.
	//
	// Over a FIXTURE directory, not the live home: the sweep is destructive and
	// this file is the last worker, so pointing the guard at the live home would
	// perform the run's cleanup from inside the assertion and hide whether
	// `cleanupTmpHygiene` still calls the sweep at all. That the default target
	// is the live home is what the out-of-process leftover count proves.
	//
	// All four cells of the cleanup axis in one case (round 3 F1). Before the
	// stale arm, `oldForeign` had no remover at all: a run-id-only sweep cleans
	// only itself, so every targeted invocation that excludes this file left one
	// more stamped directory under the persistent home for ever.
	it("sweeps this run's private backstop directories and spares a sibling invocation's", () => {
		const fixture = path.join(
			process.env.PI_LENS_HOME as string,
			`hygiene-backstop-guard-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}`,
		);
		const mine = path.join(
			fixture,
			`backstop-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-owner-guard`,
		);
		const liveForeign = path.join(fixture, "backstop-0000000000-0-owner-guard");
		const oldForeign = path.join(fixture, "backstop-0000000001-0-owner-guard");
		for (const dir of [mine, liveForeign, oldForeign]) {
			fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, "nested", "stamp.json"),
				JSON.stringify({ lastSweepAt: 1 }),
			);
		}
		// Round 4 F4, second half: root-level residue is reclaimed on the same
		// window. It is a FILE, which is why the seam's directory-only sweep
		// cannot be the whole rule.
		const oldRoot = path.join(fixture, "orphan-backstop-owner-guard-old");
		const liveRoot = path.join(fixture, "orphan-backstop-owner-guard-live");
		for (const file of [oldRoot, liveRoot])
			fs.writeFileSync(file, JSON.stringify({ lastSweepAt: 1 }));
		// #3109: the last member of this class in this directory. The
		// `tmp-hygiene-baseline-<run>.json` record is written once per run and
		// only ever removed by the owner-inclusive run that wrote it
		// (`cleanupTmpHygiene`'s own `fs.rmSync`) — an owner-less (targeted) run
		// never reaches that line, so a foreign one accumulates for ever, the
		// same shape as `oldRoot` above. `liveBaseline` stands in for THIS run's
		// own record: fresh, and must survive this call the way `mine` above
		// does not, because it is consumed explicitly afterward, not by this
		// sweep.
		const oldBaseline = path.join(
			fixture,
			"tmp-hygiene-baseline-owner-guard-old.json",
		);
		const liveBaseline = path.join(
			fixture,
			"tmp-hygiene-baseline-owner-guard-live.json",
		);
		for (const file of [oldBaseline, liveBaseline])
			fs.writeFileSync(file, JSON.stringify({ tmp: [], backstopRoot: {} }));
		// A day old: past any six-hour window, and far past the 16-minute
		// worst-case vitest invocation the window is sized against.
		const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		fs.utimesSync(oldForeign, dayAgo, dayAgo);
		fs.utimesSync(oldRoot, dayAgo, dayAgo);
		fs.utimesSync(oldBaseline, dayAgo, dayAgo);
		// Round 5: `mine`'s mtime is put two seconds INTO THE FUTURE, the
		// boundary that redded CI (run 35072411511). A directory created
		// microseconds before the sweep can carry a filesystem timestamp later
		// than the process clock, and the run-id arm's `maxAgeMs: 0` read as
		// "age >= 0" and skipped it. The rule for my own run's directories is
		// the prefix alone, so no clock comparison may enter it.
		const soon = new Date(Date.now() + 2_000);
		fs.utimesSync(mine, soon, soon);
		try {
			removeRunBackstopDirs(fixture, fixture);
			expect(fs.existsSync(mine)).toBe(false);
			expect(fs.existsSync(liveForeign)).toBe(true);
			expect(fs.existsSync(oldForeign)).toBe(false);
			expect(fs.existsSync(oldRoot)).toBe(false);
			expect(fs.existsSync(liveRoot)).toBe(true);
			expect(fs.existsSync(oldBaseline)).toBe(false);
			expect(fs.existsSync(liveBaseline)).toBe(true);
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true });
		}
	});

	// PR #3100 round 4 F4. The per-file detector used to assert the shared root
	// holds NO backstop residue at all, while the tmp gate in the same file has
	// always diffed against a setup snapshot. A checkout that had run master
	// first — the expected first state for this change — therefore redded every
	// test file for ever, naming an innocent file as the writer: with
	// `.probe-home/orphan-backstop.json` planted, all 8 tests of
	// bootstrap-lazy-liveness passed and the FILE failed. CI never sees it,
	// because CI checks out fresh.
	//
	// `before` is injected because the real baseline is captured at setup, so no
	// test can plant an entry into it; the directory read and the filter are the
	// shipped ones. Both directions matter — the second is the guarantee round 3
	// had and must not lose: a producer writing DURING the run is still named.
	it("names only root backstop residue this run is answerable for", () => {
		const home = process.env.PI_LENS_HOME as string;
		const planted = `orphan-backstop-round4-guard-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}`;
		const file = path.join(home, planted);
		fs.writeFileSync(file, "{}");
		const mtimeMs = fs.statSync(file).mtimeMs;
		try {
			// Present at setup, untouched since: not this run's doing.
			expect(
				unadmittedRootBackstopEntries({ [planted]: mtimeMs }),
			).not.toContain(planted);
			// Absent at setup: a producer created it during the run.
			expect(unadmittedRootBackstopEntries({})).toContain(planted);
			// Present at setup and OVERWRITTEN during the run — the case a
			// name-only baseline masks. Measured on the real writer with the pin
			// mutated away: same path, new mtime, and name-only named only the
			// quarantine directory beside it, never the rewritten stamp.
			expect(
				unadmittedRootBackstopEntries({ [planted]: mtimeMs - 1000 }),
			).toContain(planted);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	// PR #3100 round 3 F3. The wiring — that `cleanupTmpHygiene` still calls the
	// sweep — has no behavioural guard available: this file is the LAST worker,
	// so a guard driving the live home would perform the run's cleanup from
	// inside its own assertion and stay green with the call deleted (measured:
	// the whole hermeticity file and all 61 tests/config files passed while one
	// directory leaked). The same source-scan idiom this file already uses for
	// the setup-hook registration above, over comment-and-string-blanked text so
	// a comment naming the call can never satisfy it.
	it("keeps the backstop sweep wired into cleanupTmpHygiene", () => {
		const setup = stripSource(
			fs.readFileSync(
				path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
				"utf8",
			),
		);
		const body = setup.match(
			/export function cleanupTmpHygiene\(\): void \{[\s\S]*?\n\}/,
		)?.[0];
		expect(
			body,
			"cleanupTmpHygiene is no longer declared as expected",
		).toBeTypeOf("string");
		expect(body).toMatch(/\bremoveRunBackstopDirs\s*\(/);
	});

	it("registers the tmp-hygiene setup hook in every vitest project", () => {
		const config = fs.readFileSync(
			path.join(REPO_ROOT, "vitest.config.ts"),
			"utf8",
		);
		expect(config).toContain("./tests/support/vitest-setup.ts");
		const setup = fs.readFileSync(
			path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
			"utf8",
		);
		expect(setup).toContain("[tmp-hygiene]");
	});

	it("holds every tmp-leak admission to a reason, an issue, and a real file", () => {
		const setup = fs.readFileSync(
			path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
			"utf8",
		);
		const block = setup.match(/const TMP_LEAK_ADMISSIONS[^;]*;/s)?.[0] ?? "";
		const entries = [
			...block.matchAll(
				/file:\s*"([^"]+)"[\s\S]*?reason:\s*"([^"]+)"[\s\S]*?issue:\s*"([^"]+)"/g,
			),
		];
		for (const [, file, reason, issue] of entries) {
			expect(reason.length).toBeGreaterThan(20);
			expect(issue).toMatch(/^#\d+$/);
			if (file !== "*") {
				expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
			}
		}
		const baseline = JSON.parse(
			fs.readFileSync(
				path.join(REPO_ROOT, "tests/config/tmp-fixture-hygiene-baseline.json"),
				"utf8",
			),
		) as Array<{
			prefix: string;
			owner: string;
			reason: string;
		}>;
		expect(baseline.length).toBeGreaterThan(0);
		for (const row of baseline) {
			expect(row.prefix.startsWith("pi-lens-")).toBe(true);
			expect(row.reason).toContain("#2912");
			expect(fs.existsSync(path.join(REPO_ROOT, row.owner))).toBe(true);
		}
	});

	it("keeps every live baseline prefix within its checked-in owner population", () => {
		const baseline = JSON.parse(
			fs.readFileSync(
				path.join(REPO_ROOT, "tests/config/tmp-fixture-hygiene-baseline.json"),
				"utf8",
			),
		) as Array<{ prefix: string }>;
		const created = baseline.map((row) =>
			fs.mkdtempSync(path.join(os.tmpdir(), `${row.prefix}population-`)),
		);
		try {
			const observed = tmpHygieneObservedEntries();
			for (const row of baseline) {
				expect(
					observed.some((entry) => entry.startsWith(row.prefix)),
					`${row.prefix} disappeared from its owner population; remove the admission`,
				).toBe(true);
			}
		} finally {
			for (const dir of created)
				fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reds new prefixes and removal of an admitted prefix from the real namespace", () => {
		const baseline = JSON.parse(
			fs.readFileSync(
				path.join(REPO_ROOT, "tests/config/tmp-fixture-hygiene-baseline.json"),
				"utf8",
			),
		) as Array<{ prefix: string }>;
		const created = baseline.map((row) =>
			fs.mkdtempSync(path.join(os.tmpdir(), `${row.prefix}governance-`)),
		);
		const fabricated = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-fabricated-new-prefix-X-"),
		);
		try {
			const observed = tmpHygieneObservedEntries();
			expect(
				tmpHygieneUnadmittedEntries(
					observed,
					"config/tmp-fixture-hygiene.test.ts",
				).sort(),
			).toContain(path.basename(fabricated));
		} finally {
			for (const dir of [...created, fabricated])
				fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reds when a live prefix loses its admission row", () => {
		const live = "pi-lens-still-live-abc";
		const admissions = [
			{
				file: "*",
				prefix: "pi-lens-other-",
				reason: "unrelated admission",
				issue: "#2912",
			},
		];
		expect(
			tmpHygieneUnadmittedEntries(
				[live],
				"config/tmp-fixture-hygiene.test.ts",
				admissions,
			),
		).toContain(live);
	});

	it("selects the longest matching prefix for overlapping fixture families", () => {
		const admission = tmpHygieneAdmissionFor(
			"config/tmp-fixture-hygiene.test.ts",
			"pi-lens-which-latch-shabc123",
			[
				{
					file: "*",
					prefix: "pi-lens-which-latch",
					reason: "short",
					issue: "#2912",
				},
				{
					file: "*",
					prefix: "pi-lens-which-latch-sh",
					reason: "long",
					issue: "#2912",
				},
			],
		);
		expect(admission?.prefix).toBe("pi-lens-which-latch-sh");
	});

	// #3186: PR #3168 CI run 35160969016 redded THIS file over
	// pi-lens-tool-policy-conventions-{4irwKN,BDRp7z,PQRGdj} — dirs owned by
	// tests/clients/tool-policy-conventions.test.ts, whose afterEach removed
	// its setupTestEnvironment dir synchronously while saveProjectSnapshot's
	// body persist was still in flight. Premise-first repro against the real
	// production call (clients/project-snapshot.ts saveProjectSnapshot, no
	// mock): a bare Node invocation that calls it, then removes the directory
	// the instant it returns, saw the directory back on disk ~10-50ms later,
	// unforced, on every trial — saveProjectSnapshot dispatches its body
	// persist to a worker thread/main-thread fallback the caller never
	// awaits, and that persist's write path (clients/gzip-stage-write.ts)
	// does `fs.promises.mkdir(dirname, {recursive:true})` before writing,
	// recreating whatever ancestor directory a synchronous cleanup already
	// removed.
	//
	// The real fix is at the producer, not an admission here: every call
	// site (including tool-policy-conventions.test.ts's own afterEach, as of
	// this change) awaits the drain seam the repo already ships for exactly
	// this — waitForProjectSnapshotPersistsForTests — before its cleanup
	// runs, so nothing is left in flight to recreate the directory once
	// removed. Proven WITHOUT a raw wall-clock wait (this file's own
	// dedicated, fully-serialized project is not in vitest.config.ts's
	// wallClockBudgetInclude/realHarnessInclude, so a new raw timer here
	// would need moving the file's whole project assignment just for one
	// case): JS is single-threaded, so immediately after the synchronous
	// saveProjectSnapshot() call returns, NO microtask or macrotask of its
	// fire-and-forget worker/main-thread-fallback dispatch has run yet —
	// the body file cannot exist. Awaiting the real drain seam instead of a
	// fixed pause is what proves completion, not elapsed time: once it
	// resolves, the body file is verifiably ON DISK (not "probably done by
	// now"), so cleanup right after it can leave nothing pending to recreate
	// what it removes — checked synchronously, no wait either side.
	it("draining the real project-snapshot persist before cleanup leaves nothing to recreate pi-lens-tool-policy-conventions dirs", async () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-conventions-");
		const cwd = path.join(env.tmpDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const runtime = new RuntimeCoordinator();
		runtime.seedProjectSequence(1);
		const snapshot = buildProjectSnapshotFromRuntime({
			cwd,
			runtime,
			conventions: {
				frameworks: [
					{ id: "react", confidence: "high", signals: ["fixture:react"] },
				],
				testRunners: [],
				buildTools: [],
				agentDocs: [],
			},
		});
		const gzPath = getProjectSnapshotPath(cwd);
		saveProjectSnapshot(cwd, snapshot);
		expect(
			fs.existsSync(gzPath),
			"the persist is dispatched fire-and-forget; it cannot have landed in the same synchronous tick",
		).toBe(false);
		await waitForProjectSnapshotPersistsForTests(); // the #3186 fix
		expect(
			fs.existsSync(gzPath),
			"the drain must not resolve before the persist actually reaches disk",
		).toBe(true);
		env.cleanup();
		expect(
			fs.existsSync(env.tmpDir),
			"nothing was left pending to recreate the directory cleanup just removed",
		).toBe(false);
	});

	it("does not red a live scratch owner, then reds it after the owner drains", async () => {
		// #3186 mutation proof: removing the live-owner filter makes the first
		// assertion red, while removing the second assertion would hide a real
		// post-drain leak. PID 1 is a stable live process; the marker is removed
		// to model the owner's completed cleanup drain.
		const owner = "config/tmp-fixture-hygiene.test.ts";
		const marker = path.join(
			process.env.PI_LENS_HOME as string,
			"tmp-hygiene-owners",
			`${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-scratch.json`,
		);
		const scratch = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-scratch-3186-"),
		);
		fs.writeFileSync(marker, JSON.stringify({ pid: 1, file: owner }));
		try {
			const live = await tmpHygieneWaitForOwnerDrain(50);
			expect(
				tmpHygieneExcludeLiveOwnerEntries(
					[path.basename(scratch)],
					() => owner,
					live,
				),
			).toEqual([]);
			fs.rmSync(marker, { force: true });
			const drained = await tmpHygieneWaitForOwnerDrain(50);
			expect(
				tmpHygieneExcludeLiveOwnerEntries(
					[path.basename(scratch)],
					() => owner,
					drained,
				),
			).toEqual([path.basename(scratch)]);
		} finally {
			fs.rmSync(marker, { force: true });
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});
});
