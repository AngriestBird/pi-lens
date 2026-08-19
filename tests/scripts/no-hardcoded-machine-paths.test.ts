// #1728: class sweep from #1718. scripts/run-astgrep-pi-lens.mjs hardcoded a
// single author's now-nonexistent machine paths
// (C:/Users/R3LiC/Desktop/pi-lens[-rules2]) as both its scan target and rule
// source, so it silently ran nowhere -- not in CI, not on any other
// contributor's machine (#1718). Grepping scripts/ + package.json for the
// same shape found three more instances (#1728), fixed alongside this guard:
// scripts/run-ts-rules-pi-lens.mjs (derives repo root from its own file
// location), scripts/run-all-ts-rules-posthog.mjs (now takes the external
// checkout as --posthog-dir/POSTHOG_DIR, no baked-in default), and
// package.json's harness:*-poc scripts (the hardcoded --pi-bin literal is
// redundant with run-harness.mjs's own $APPDATA-derived PATH resolution, so
// it is dropped rather than replaced).
//
// This is the registered-or-fail guard: it greps every script under
// scripts/ plus package.json for an author-machine absolute path literal
// (C:\Users\<name> or C:/Users/<name>) baked into source, so a future commit
// that reintroduces one -- an author pasting a debug command as-is -- fails
// here instead of shipping unnoticed a second time. Not scoped to R3LiC
// specifically: the shape is ANY hardcoded user-profile path, not just this
// one author's.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

// A user-profile absolute path literal: C:\Users\<name>\... or
// C:/Users/<name>/.... Deliberately NOT anchored to any one username -- the
// defect shape is "baked-in machine path", not "baked-in R3LiC".
const USER_PROFILE_PATH_RE = /C:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+/g;

// Legitimate exceptions, reviewed per entry -- never a blanket file skip.
// Each entry names the file, the issue/PR that reviewed it, and why the hit
// is not a recurrence of the #1718/#1728 defect shape.
const ALLOWLIST: Record<string, string> = {
	// #1718's fixer PR (#1729) rewrites this file's PI_LENS/PI_LENS_RULES2
	// constants to derive from import.meta.url, same as #1728's fix did for
	// run-ts-rules-pi-lens.mjs. Remove this entry once #1729 merges --
	// tracked so the guard doesn't silently stay lenient past that point.
	"scripts/run-astgrep-pi-lens.mjs": "pending #1718 fix in PR #1729",
};

function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listFilesRecursive(full));
		} else if (/\.(mjs|mts|js|ts|cjs)$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

function findHardcodedMachinePaths(filePath: string): string[] {
	const text = fs.readFileSync(filePath, "utf8");
	const matches = text.match(USER_PROFILE_PATH_RE);
	return matches ? [...new Set(matches)] : [];
}

function relFromRoot(p: string): string {
	return path.relative(REPO_ROOT, p).replace(/\\/g, "/");
}

describe("no hardcoded machine paths in scripts/ or package.json (#1728)", () => {
	it("scans a nonzero number of script files (registered-or-fail: an empty scan must not read as clean)", () => {
		const files = listFilesRecursive(SCRIPTS_DIR);
		expect(files.length).toBeGreaterThan(10);
	});

	it("the detector itself flags a synthetic hardcoded machine path, in both slash styles (mutation-proof)", () => {
		const posix = 'const X = "C:/Users/someone/Desktop/whatever";';
		const win32 = 'const X = "C:\\Users\\someone\\Desktop\\whatever";';
		expect([...posix.matchAll(USER_PROFILE_PATH_RE)].map((m) => m[0])).toEqual([
			"C:/Users/someone",
		]);
		expect([...win32.matchAll(USER_PROFILE_PATH_RE)].map((m) => m[0])).toEqual([
			"C:\\Users\\someone",
		]);
	});

	it("no script under scripts/ hardcodes an author-machine path outside the reviewed allowlist", () => {
		const files = listFilesRecursive(SCRIPTS_DIR);
		const offenders: string[] = [];
		for (const file of files) {
			const rel = relFromRoot(file);
			if (ALLOWLIST[rel]) continue;
			const hits = findHardcodedMachinePaths(file);
			if (hits.length > 0) {
				offenders.push(`${rel}: ${hits.join(", ")}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("package.json does not hardcode an author-machine path in any npm script", () => {
		const pkgPath = path.join(REPO_ROOT, "package.json");
		const hits = findHardcodedMachinePaths(pkgPath);
		expect(hits).toEqual([]);
	});

	it("every allowlist entry still exists and still contains the literal it excuses (a stale entry is dead weight, not a screen)", () => {
		for (const rel of Object.keys(ALLOWLIST)) {
			const full = path.join(REPO_ROOT, rel);
			expect(fs.existsSync(full), `${rel} no longer exists -- remove its allowlist entry`).toBe(true);
			const hits = findHardcodedMachinePaths(full);
			expect(
				hits.length > 0,
				`${rel} no longer contains a hardcoded machine path -- remove its allowlist entry (${ALLOWLIST[rel]})`,
			).toBe(true);
		}
	});
});
