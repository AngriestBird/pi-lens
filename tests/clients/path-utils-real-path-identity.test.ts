/**
 * #4689: a file's identity is the real path of its nearest existing ancestor
 * plus the missing tail, with no lexical `..` collapse first.
 *
 * Shapes the cells guard: a link to a file, a link to a directory, a missing
 * tail under a directory link, `..` after a link (the kernel leaves through the
 * link target's parent), `..` inside the missing tail, a relative spelling,
 * and an unreadable ancestor (which must reach the caller, not be skipped).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realPathIdentity } from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("realPathIdentity", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	function fixture(): string {
		const env = setupTestEnvironment("pi-lens-path-identity-");
		cleanups.push(env.cleanup);
		return fs.realpathSync(env.tmpDir);
	}

	it("resolves a file link to its target", () => {
		const root = fixture();
		fs.writeFileSync(path.join(root, "CLAUDE.md"), "x\n");
		fs.symlinkSync("CLAUDE.md", path.join(root, "AGENTS.md"));
		expect(realPathIdentity(path.join(root, "AGENTS.md"))).toBe(
			path.join(root, "CLAUDE.md"),
		);
	});

	it("keeps a missing tail beside the real directory a link names", () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, "real"));
		fs.symlinkSync("real", path.join(root, "alias"));
		expect(realPathIdentity(path.join(root, "alias", "a", "new.ts"))).toBe(
			path.join(root, "real", "a", "new.ts"),
		);
	});

	it("leaves a link through the target's parent, not the spelling's", () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, "pkg-a", "src"), { recursive: true });
		fs.mkdirSync(path.join(root, "pkg-b", "deep"), { recursive: true });
		fs.symlinkSync(
			path.join(root, "pkg-b", "deep"),
			path.join(root, "pkg-a", "src", "link"),
		);
		// `pkg-a/src/link/..` is `pkg-b`, though lexically it is `pkg-a/src`.
		// Built by concatenation: `path.join` would collapse the `..` first.
		const spelling = `${root}${path.sep}pkg-a${path.sep}src${path.sep}link${path.sep}..${path.sep}b.ts`;
		expect(realPathIdentity(spelling)).toBe(path.join(root, "pkg-b", "b.ts"));
	});

	it("collapses a `..` that sits inside the missing tail", () => {
		const root = fixture();
		const spelling = `${root}${path.sep}missing${path.sep}..${path.sep}x.ts`;
		expect(realPathIdentity(spelling)).toBe(path.join(root, "x.ts"));
	});

	it("anchors a relative spelling at the process cwd", () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, "real"));
		fs.symlinkSync("real", path.join(root, "alias"));
		const previous = process.cwd();
		process.chdir(root);
		try {
			expect(realPathIdentity(path.join("alias", "n.ts"))).toBe(
				path.join(root, "real", "n.ts"),
			);
		} finally {
			process.chdir(previous);
		}
	});

	it("reports a symlink loop instead of answering with the spelling", () => {
		const root = fixture();
		fs.symlinkSync("b", path.join(root, "a"));
		fs.symlinkSync("a", path.join(root, "b"));
		expect(() => realPathIdentity(path.join(root, "a", "x.ts"))).toThrow(
			/ELOOP/,
		);
	});
});
