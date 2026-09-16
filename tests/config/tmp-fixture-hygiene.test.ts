import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	stripSource,
} from "../support/sweep-kit.js";
import {
	cleanupTmpHygiene,
	removeRunBackstopDirs,
	tmpHygieneAdmissionFor,
	tmpHygieneLeakReport,
	tmpHygieneObservedEntries,
	tmpHygieneUnadmittedEntries,
} from "../support/vitest-setup.js";

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
		for (const file of listSourceFiles(root, { extensions: [".ts", ".mjs"] })) {
			fileCount += 1;
			const raw = fs.readFileSync(file, "utf8");
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

describe("tmp-fixture-hygiene", () => {
	afterAll(() => {
		const { testFile, leftovers } = tmpHygieneLeakReport();
		try {
			expect(
				leftovers,
				`[tmp-hygiene] tests/${testFile} leaked ${leftovers.length} top-level entries: ${leftovers.join(",")}`,
			).toEqual([]);
		} finally {
			cleanupTmpHygiene();
		}
	});

	it("routes every tests/ and scripts/ mkdtemp parent through a contained root", () => {
		const escapees = scanMkdtempSites().filter((site) => {
			if (site.file === "tests/support/vitest-setup.ts") return false;
			const file = path.join(REPO_ROOT, site.file);
			const raw = fs.readFileSync(file, "utf8");
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
	it("sweeps this run's private backstop directories and spares a sibling invocation's", () => {
		const home = process.env.PI_LENS_HOME as string;
		const mine = path.join(
			home,
			`backstop-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-owner-guard`,
		);
		const sibling = path.join(home, "backstop-0000000000-0-owner-guard");
		for (const dir of [mine, sibling]) {
			fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, "nested", "stamp.json"),
				JSON.stringify({ lastSweepAt: 1 }),
			);
		}
		try {
			removeRunBackstopDirs();
			expect(fs.existsSync(mine)).toBe(false);
			expect(fs.existsSync(sibling)).toBe(true);
		} finally {
			fs.rmSync(sibling, { recursive: true, force: true });
		}
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
});
