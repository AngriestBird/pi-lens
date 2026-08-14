import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.ts";

describe("RuntimeCoordinator", () => {
	it("makes edit autofix deferral sticky after a write until beginTurn", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/sticky.ts");

		expect(runtime.recordMutationToolReceipt(filePath, "write").autofixMode).toBe("immediate");
		expect(runtime.recordMutationToolReceipt(filePath, "edit").autofixMode).toBe("deferred");
		expect(runtime.recordMutationToolReceipt(filePath, "write").autofixMode).toBe("deferred");

		runtime.beginTurn();
		expect(runtime.recordMutationToolReceipt(filePath, "write").autofixMode).toBe("immediate");
	});

	it("coalesces autofix and format kinds on one owner-scoped path record", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/coalesced.ts");
		expect(runtime.deferMutation(filePath, process.cwd(), "edit", process.cwd(), "autofix", "owner")).toBe(true);
		expect(runtime.deferMutation(filePath, process.cwd(), "edit", process.cwd(), "format", "owner")).toBe(false);

		const [record] = runtime.consumeDeferredFormatFiles();
		expect(record.kinds).toEqual(new Set(["autofix", "format"]));
		expect(record.ownerSessionId).toBe("owner");
	});
	it("resetForSession clears any existing read guard state", () => {
		const runtime = new RuntimeCoordinator();
		const runtimeState = runtime as any;

		runtimeState._readGuard = { sentinel: true };
		runtime.resetForSession();

		expect(runtimeState._readGuard).toBeNull();
	});

	it("accepts the hook-start boundary when resetting a session", () => {
		const runtime = new RuntimeCoordinator();
		const hookStartedAt = Date.now() - 250;

		runtime.resetForSession(hookStartedAt);

		expect(runtime.sessionStartedAt).toBe(hookStartedAt);
	});

	it("tracks first-read LSP warming and suppresses duplicate warmups", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = "/tmp/example.ts";

		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(true);

		runtime.markLspReadWarmStarted(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(false);

		runtime.markLspReadWarmCompleted(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(false);

		runtime.clearLspReadWarmState(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(true);
	});

	describe("getFilesChangedSince (#451)", () => {
		it("returns only files bumped after the given projectSeq", () => {
			const runtime = new RuntimeCoordinator();
			const a = runtime.bumpFileSeq("/proj/a.ts"); // projectSeq 1
			runtime.bumpFileSeq("/proj/b.ts"); // projectSeq 2
			runtime.bumpFileSeq("/proj/c.ts"); // projectSeq 3

			// Since seq 1: b and c (a's last bump was at seq 1, not > 1).
			const changed = runtime.getFilesChangedSince(a.projectSeq);
			expect(changed).toHaveLength(2);
			expect(changed.some((f) => f.endsWith("/b.ts"))).toBe(true);
			expect(changed.some((f) => f.endsWith("/c.ts"))).toBe(true);
			expect(changed.some((f) => f.endsWith("/a.ts"))).toBe(false);

			// Since seq 0: all three.
			expect(runtime.getFilesChangedSince(0)).toHaveLength(3);
		});

		it("keys are separator-normalized: bump one form, query returns the other", () => {
			const runtime = new RuntimeCoordinator();
			// Record with a backslash path form.
			runtime.bumpFileSeq("C:\\proj\\src\\Widget.ts");

			const changed = runtime.getFilesChangedSince(0);
			expect(changed).toHaveLength(1);
			// The returned key is normalized to forward slashes (never backslashes),
			// so a builder keyed on forward-slash fileSignatures matches it.
			expect(changed[0]).not.toContain("\\");
			expect(changed[0].replace(/\\/g, "/").toLowerCase()).toContain(
				"proj/src/widget.ts",
			);
		});

		it("is cleared on session reset", () => {
			const runtime = new RuntimeCoordinator();
			runtime.bumpFileSeq("/proj/a.ts");
			expect(runtime.getFilesChangedSince(0)).toHaveLength(1);

			runtime.resetForSession();
			expect(runtime.getFilesChangedSince(0)).toHaveLength(0);
		});

		it("is cleared when sequences are seeded", () => {
			const runtime = new RuntimeCoordinator();
			runtime.bumpFileSeq("/proj/a.ts");
			expect(runtime.getFilesChangedSince(0)).toHaveLength(1);

			runtime.seedProjectSequence(5, new Map([["/proj/a.ts", 3]]));
			// Seeded per-file counters carry no seq provenance ⇒ empty changed map.
			expect(runtime.getFilesChangedSince(0)).toHaveLength(0);
		});
	});

	describe("inline blockers reconcile against disk (#1245)", () => {
		it("drops a blocker whose file no longer exists from the snapshot", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-reconcile-"));
			const file = path.join(dir, "stale.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);

				rmSync(file);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("drops a stale blocker for a mixed-case filename too (#1245 Windows key trap)", () => {
			// `normalizeMapKey` realpaths a live file (canonical case) but
			// lowercases the tail of a deleted one, so a delete-in-place
			// reconcile missed `MyCase.ts` on Windows — the reconcile must not
			// depend on delete-time key normalization matching set-time.
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-case-"));
			const file = path.join(dir, "MyCase.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);

				rmSync(file);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("keeps a blocker whose file still exists", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-keep-"));
			const file = path.join(dir, "stays.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
				expect(runtime.getInlineBlockersSnapshot()[0].summary).toBe("blocker A");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("no longer counts a deleted file's blocker toward the git guard", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-guard-"));
			const file = path.join(dir, "stale.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				runtime.updateGitGuardStatus(false, "");
				expect(runtime.gitGuardHasBlockers).toBe(true);

				rmSync(file);
				runtime.updateGitGuardStatus(false, "");
				expect(runtime.gitGuardHasBlockers).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
