/**
 * Regression: read-guard keyed its reads/edits maps on the raw file path, so a
 * read recorded under one separator/casing form (e.g. the slash-normalized path
 * that LSP-expanded and search-tool reads produce) was invisible to an edit
 * checked under another (the Read tool's OS-native backslashes on Windows). The
 * guard then reported `zero_read` and blocked the edit even though the file had
 * been read — repeatedly, in a real session (see read-guard.log: reads logged
 * with `C:/…` forward slashes, the blocking edit with `C:\\…` backslashes).
 *
 * The fix canonicalizes every map key through `normalizeFilePath`. These tests
 * pin that record and lookup agree regardless of the separator/casing the two
 * call sites happen to use.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createReadGuard, type ReadRecord } from "../../clients/read-guard.js";

vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));

vi.mock("../../clients/file-time.js", () => ({
	createFileTime: () => ({
		read: vi.fn(),
		hasChanged: vi.fn(() => false),
		assert: vi.fn(),
		get: vi.fn(),
	}),
}));

function rec(
	filePath: string,
	overrides: Partial<ReadRecord> = {},
): ReadRecord {
	return {
		filePath,
		requestedOffset: 1,
		requestedLimit: 100,
		effectiveOffset: 1,
		effectiveLimit: 100,
		expandedByLsp: false,
		turnIndex: 1,
		writeIndex: 1,
		timestamp: Date.now(),
		...overrides,
	};
}

describe("ReadGuard path-key normalization (zero_read false-block regression)", () => {
	it("allows an edit checked with backslashes after a read recorded with forward slashes", () => {
		const guard = createReadGuard("test-session");
		guard.recordRead(rec("/proj/providers/model-fetcher.ts"));

		const verdict = guard.checkEdit("\\proj\\providers\\model-fetcher.ts");

		expect(verdict.action).toBe("allow");
	});

	it("allows the reverse — read recorded with backslashes, edit checked with forward slashes", () => {
		const guard = createReadGuard("test-session");
		guard.recordRead(rec("\\proj\\tests\\kilo.test.ts"));

		const verdict = guard.checkEdit("/proj/tests/kilo.test.ts");

		expect(verdict.action).toBe("allow");
	});

	it("getReadHistory matches across separator forms", () => {
		const guard = createReadGuard("test-session");
		guard.recordRead(rec("/proj/a.ts"));

		expect(guard.getReadHistory("\\proj\\a.ts")).toHaveLength(1);
	});

	it("a once-recorded exemption is honored regardless of separator form", () => {
		const guard = createReadGuard("test-session");
		guard.addExemption("/proj/b.ts");

		expect(guard.checkEdit("\\proj\\b.ts").action).toBe("allow");
	});

	// Path casing folds only on Windows, so this declares itself skipped
	// elsewhere rather than returning early and reporting a PASS (#2089).
	// lane: windows-vitest
	it.skipIf(process.platform !== "win32")(
		"folds Windows path casing so cased read forms match lower-cased edits",
		() => {
			const guard = createReadGuard("test-session");
			guard.recordRead(rec("C:/Proj/Src/Api.ts"));

			expect(guard.checkEdit("c:/proj/src/api.ts").action).toBe("allow");
		},
	);

	it("still blocks a genuinely unread file (guard not weakened)", () => {
		const guard = createReadGuard("test-session");

		const verdict = guard.checkEdit("/proj/never-read.ts");

		expect(verdict.action).toBe("block");
		expect(verdict.reason).toContain("Edit without read");
	});

	// RECURRENCE GUARDED (#3159 review round 2, F2): `checkEdit` rewrites its
	// argument to `this.key(filePath)` (read-guard.ts:931) and renders that KEY
	// into the RETRYABLE instruction — `read path="…"`. The key must therefore
	// always name a path the agent can actually read. #3098's first POSIX
	// casing arm could rewrite a case-variant symlink's basename onto a
	// directory that does not exist (`node_modules/Foo` → `node_modules/foo`),
	// so the block told the agent to read a path that ENOENTs and the edit
	// could never be unblocked — a permanent block, worse than the defect
	// #3098 set out to fix. lane: ubuntu Unit tests (the fixture needs two
	// case-distinct entries, impossible on a case-insensitive filesystem).
	it("the retryable block names a path that exists, under a case-variant symlinked package", (ctx) => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rg-case-"));
		try {
			fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
			fs.mkdirSync(path.join(tmpDir, "pkgs", "foo"), { recursive: true });
			const target = path.join(tmpDir, "pkgs", "foo", "i.ts");
			fs.writeFileSync(target, "export const i = 1;\n");
			// Age the file past the guard's session start. `wasWrittenThisSession`
			// (read-guard.ts:1515) falls back to `mtimeMs >= sessionStartMs`,
			// and a fixture written in the same millisecond the guard is
			// constructed reads as "the agent authored this" and is ALLOWED — a
			// wall-clock race that failed 1 run in 4 before this line. The subject
			// here is which path the block names, not mtime semantics.
			const anHourAgo = new Date(Date.now() - 3_600_000);
			fs.utimesSync(target, anHourAgo, anHourAgo);
			ctx.skip(
				fs.existsSync(path.join(tmpDir, "node_modules", "FOO")),
				"case-insensitive filesystem: node_modules/Foo and node_modules/foo are one entry here",
			);
			fs.symlinkSync(
				path.join("..", "pkgs", "foo"),
				path.join(tmpDir, "node_modules", "Foo"),
				"dir",
			);
			const held = path.join(tmpDir, "node_modules", "Foo", "i.ts");

			const verdict = createReadGuard("test-session").checkEdit(held);

			expect(verdict.action).toBe("block");
			const quoted = /read path="([^"]+)"/.exec(verdict.reason ?? "")?.[1];
			expect(quoted).toBeDefined();
			expect(fs.existsSync(quoted as string)).toBe(true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
		}
	});
});
