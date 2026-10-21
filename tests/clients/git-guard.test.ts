import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	clearGitGuardTestFailure,
	evaluateGitGuard,
	isGitCommitOrPushAttempt,
	mergeGitGuardTestFailure,
	retireInlineBlockerAndResyncGuard,
	retireSettledGitGuardRecord,
	syncGitGuardRecord,
	writeGitGuardRecord,
	type TurnEndFindingsCache,
} from "../../clients/git-guard.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { setupTestEnvironment } from "./test-utils.js";
import { tokenizeShellCommand } from "../../clients/bash-file-access.js";

/**
 * A blocking dispatch diagnostic, shaped as the runners emit it.
 */
function blockingDiagnostic(
	filePath: string,
	line: number,
	message: string,
): Diagnostic {
	return {
		id: `ast-grep:${path.basename(filePath)}:${line}`,
		message,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool: "ast-grep",
		rule: "no-eval",
	};
}

/**
 * The inline-blocker summary PRODUCTION records, byte for byte: the pipeline
 * hands `recordInlineBlockers` `dispatchResult.blockerOutput.trim()`
 * (`clients/pipeline.ts:1916`), and `blockerOutput` is
 * `formatDiagnostics(inlineBlockers, "blocking")`
 * (`clients/dispatch/dispatcher.ts:1409`) — a `🔴 STOP` header line plus one
 * INDENTED line per diagnostic.
 *
 * #3282's detection retrospective: every case in this file used to hand-type a
 * single-line summary (`"blocker A"`), the one shape the record's provenance
 * parse accepted. The parse never matched what either writer emits, so the
 * commit gate answered `blocking_provenance_untrusted` for the rest of any
 * session that recorded a blocker, and these tests stayed green. A double that
 * is not production-faithful on the axis under test proves nothing — so the
 * fixture is now rendered by the production renderer, and cannot diverge again.
 */
function productionSummary(
	filePath: string,
	messages: readonly string[],
): string {
	return formatDiagnostics(
		messages.map((message, index) =>
			blockingDiagnostic(filePath, index + 1, message),
		),
		"blocking",
	).trim();
}

function record(
	overrides: Partial<TurnEndFindingsCache> = {},
): TurnEndFindingsCache {
	return {
		content: "",
		hasBlockers: false,
		affectedFiles: [],
		sessionId: "session-A",
		projectSeqStart: 0,
		projectSeqEnd: 0,
		fileSeqByPath: {},
		fileContentHashes: {},
		...overrides,
	};
}

describe("git-guard", () => {
	it("detects actual git commands through wrappers and options", () => {
		expect(
			isGitCommitOrPushAttempt("bash", { command: 'git commit -m "x"' }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "git push origin main" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: "npm test && git -C repo commit -m x",
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: "git --no-pager push origin main",
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "git --help commit" }),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: "git -c user.name=x commit -m x",
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "GIT_DIR=.git git push" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "", cmd: "git commit -m x" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "sh -c 'git commit -m x'" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'bash -lc "git push origin main"',
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'cmd /c "git.exe commit -m x"',
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				cmd: 'powershell -Command "git.cmd push"',
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "# git commit -m x" }),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("bash", { command: 'echo "git commit -m x"' }),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "printf 'git push'" }),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("write", { command: "git commit -m x" }),
		).toBe(false);
	});

	it("detects wrapper commands when the shell joins unquoted argv", () => {
		expect(
			isGitCommitOrPushAttempt("bash", { command: "cmd /c git commit -m x" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: "powershell -Command git push origin main",
			}),
		).toBe(true);
	});

	it("blocks executable and path-qualified wrapper launchers", () => {
		for (const command of [
			"cmd.exe /c git push",
			"cmd.exe /S /C git push",
			"C:\\Windows\\System32\\cmd.exe /c git push",
			"POWERSHELL.EXE -c git push",
			"C:\\Windows\\System32\\powershell.com -Command git push",
			"sh.exe -c git push",
			"bash.com -c git push",
			"C:\\tools\\env.bat FOO=bar git push",
			"xargs.cmd git push",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
	});

	it("blocks shell escapes embedded in a guarded git verb", () => {
		for (const command of [
			"git pu\\sh",
			"git pu`sh",
			"git pu^sh",
			"git${IFS}push",
			"git$IFS$9push",
			"git ${IFS}pu^sh",
			"git$IFS$1push",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
		for (const command of [
			"git$IFS push",
			"git${IFS%x}push",
			"git$IFS$9push",
			"sh -c 'git$IFS$9push'",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'git commit -m "$IFS is a var"',
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'git add -m "$IFS is a var"',
			}),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "git add C:\\proj\\a.ts" }),
		).toBe(false);
	});

	it("fails closed for recognized and unknown command-string wrappers", () => {
		for (const command of [
			"busybox sh -c 'git push'",
			"toybox sh -c 'git commit'",
			"nix-shell -p git --run 'git push'",
			'someunknownwrapper -c "git push"',
			'weird --command "git push"',
			'weird -e "git push"',
			'weird /R "git push"',
			"weirdwrapper git push",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
		expect(
			isGitCommitOrPushAttempt("bash", { command: 'myprog -c "echo hi"' }),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "myprog git push" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'myprog -c "echo git push"',
			}),
		).toBe(false);
	});

	// #2007 R1 (regression, caught in review): the shared-checkout guard added
	// a post-verb `--help`/`-h` suppression to the classifier both gates now
	// share. Applied to THIS gate it was a hole, because `-h` is a legal
	// option VALUE. Verified against real git 2.55 in a scratch repo:
	// `git commit -m -h` exits 0 and the log subject reads `-h`, and
	// `git push --repo -h` reaches the push path rather than printing help.
	// A gate that fails closed must never be talked out of a match by a token
	// that might be a value.
	it("still matches when -h is an option VALUE, not a help request", () => {
		for (const command of [
			"git commit -m -h",
			"git commit -F -h",
			"git commit --file -h",
			"git commit -c -h",
			"git commit --reuse-message -h",
			"git push --repo -h",
			"git push --receive-pack -h",
			"git push --exec -h",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
	});

	it("keeps failing closed on an explicit post-verb help flag", () => {
		// Not a value here, but this gate does not get to decide that: the
		// pre-#2007 classifier matched these, and a commit gate that can be
		// switched off by appending a flag is not a gate.
		for (const command of [
			"git commit --help",
			"git commit -h",
			"git push --help",
			"git push -h",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
	});

	it("does not treat literal git text as an indirect operation", () => {
		for (const command of [
			'echo "remember to git push later"',
			'grep "git push" file',
			'docker run -c "echo hi"',
			'myprog --run "build"',
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(
				false,
			);
		}
		expect(isGitCommitOrPushAttempt("bash", { command: "git push" })).toBe(
			true,
		);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'git commit -m "prep for git push"',
			}),
		).toBe(true);
	});

	it("blocks guarded verbs executed by shell substitutions, including text consumers", () => {
		for (const command of [
			"echo $(git push)",
			'printf "%s" "$(git push)"',
			"grep -f <(git push) x",
			"echo `git push`",
			"cat >(git push)",
			"echo $(git$IFS$9push)",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
	});

	it("allows plain text that only mentions guarded verbs", () => {
		for (const command of [
			'echo "remember to git push later"',
			'grep "git push" file.txt',
			"echo git push",
			'docker run -c "echo hi"',
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(
				false,
			);
		}
	});

	it("detects launcher prefixes, shell keywords, combined flags, and continuations", () => {
		const continued = "git \\" + "\ncommit -m x";
		expect(tokenizeShellCommand(continued)[0]?.tokens).toEqual([
			"git",
			"commit",
			"-m",
			"x",
		]);
		for (const command of [
			"env FOO=bar git commit -m x",
			"exec git push origin main",
			"command git commit -m x",
			"nohup git push origin main",
			"nice git commit -m x",
			"xargs git push origin main",
			"if true; then git commit -m x; fi",
			"for x in one; do git push origin main; done",
			"sh -ec 'git commit -m x'",
			"bash -euc 'git push origin main'",
			continued,
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
	});

	it("blocks runtime blockers and preserves their details", () => {
		const runtime = {
			gitGuardHasBlockers: true,
			gitGuardSummary: "blocker in src/app.ts:12",
		};
		const env = setupTestEnvironment("pi-lens-git-guard-runtime-");
		try {
			const result = evaluateGitGuard(
				runtime as any,
				new CacheManager(false),
				env.tmpDir,
			);
			expect(result.block).toBe(true);
			expect(result.reason).toContain("src/app.ts");
		} finally {
			env.cleanup();
		}
	});

	it("allows advisory-only structured records", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-advisory-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({ content: "style advisory" }),
				env.tmpDir,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("treats malformed, stale, and cross-session state as unknown/block", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-unknown-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				{ content: "old shape" },
				env.tmpDir,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
			cache.writeCache(
				"turn-end-findings",
				record({ content: "blocker", hasBlockers: true, sessionId: "other" }),
				env.tmpDir,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
			const metaPath = path.join(
				getProjectDataDir(env.tmpDir),
				"cache",
				"turn-end-findings.meta.json",
			);
			const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
			meta.timestamp = new Date(0).toISOString();
			fs.writeFileSync(metaPath, JSON.stringify(meta));
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("blocks structured test failures", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-tests-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: "FAIL 1p/1f",
					hasBlockers: true,
					testFailures: true,
				}),
				env.tmpDir,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("aggregates per-file blockers instead of latest-file-wins", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-aggregate-");
		try {
			const runtime = new RuntimeCoordinator();
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const summary = productionSummary(file, ["alpha is unsafe"]);
			runtime.recordInlineBlockers(file, summary);
			runtime.updateGitGuardStatus(true, summary);
			runtime.clearInlineBlockers(path.join(env.tmpDir, "b.ts"));
			runtime.updateGitGuardStatus(false, "clean B");
			expect(runtime.gitGuardHasBlockers).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("does not block when the only affected file was deleted", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-deleted-");
		try {
			const file = path.join(env.tmpDir, "deleted.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: "blocker",
					hasBlockers: true,
					affectedFiles: [file],
					fileSeqByPath: { [file.replace(/\\/g, "/")]: 0 },
				}),
				env.tmpDir,
			);
			fs.unlinkSync(file);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("rejects an external content change even when sequence is unchanged", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-content-");
		try {
			const file = path.join(env.tmpDir, "changed.ts");
			fs.writeFileSync(file, "const before = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: "blocker",
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
				}),
			);
			fs.writeFileSync(file, "const after = 2;\n");
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("clears only the test failure that passed", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-test-clear-");
		try {
			const files = ["a.test.ts", "b.test.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of files) fs.writeFileSync(file, "test();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			mergeGitGuardTestFailure(
				cache,
				env.tmpDir,
				runtime,
				"two failures",
				files,
			);
			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [files[0]]);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [files[1]]);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("recovers a stale inline blocker after its file reconciles clean", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-stale-inline-");
		try {
			const file = path.join(env.tmpDir, "cleaned.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			const summary = productionSummary(file, [
				"alpha is unsafe",
				"beta is unsafe",
			]);
			runtime.recordInlineBlockers(file, summary);
			runtime.updateGitGuardStatus(true, summary);
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			runtime.clearInlineBlockers(file);
			runtime.updateGitGuardStatus(false, "clean");
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#1561 F2: retiring the last blocker unblocks the commit with no manual gate call", () => {
		// The round-1 probe. `evaluateGitGuard` short-circuits on the
		// `gitGuardHasBlockers` LATCH before it reads the persisted record, and
		// the retire touched neither — so a "retired" blocker still blocked the
		// commit and was quoted back as the reason. Nothing below calls
		// `updateGitGuardStatus`/`syncGitGuardRecord` by hand after the retire;
		// that is the whole point.
		const env = setupTestEnvironment("pi-lens-git-guard-retire-");
		try {
			const file = path.join(env.tmpDir, "cleaned.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			const summary = productionSummary(file, ["alpha is unsafe"]);
			runtime.recordInlineBlockers(file, summary, 1, ["lsp"]);
			runtime.updateGitGuardStatus(true, summary);
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);

			expect(
				retireInlineBlockerAndResyncGuard({
					runtime,
					cacheManager: cache,
					cwd: env.tmpDir,
					filePath: file,
					writeIndex: 2,
					coveredSources: ["lsp"],
					lensGuardEnabled: true,
				}),
			).toBe(true);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#1561 F2: retiring ONE blocker still leaves a sibling file's blocker gating", () => {
		// The latch recompute must not become a blanket "clear the gate".
		const env = setupTestEnvironment("pi-lens-git-guard-retire-sibling-");
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			runtime.recordInlineBlockers(
				files[0],
				productionSummary(files[0], ["alpha is unsafe"]),
				1,
				["lsp"],
			);
			runtime.recordInlineBlockers(
				files[1],
				productionSummary(files[1], ["beta is unsafe"]),
				1,
				["lsp"],
			);
			runtime.updateGitGuardStatus(true, "blockers");
			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);

			expect(
				retireInlineBlockerAndResyncGuard({
					runtime,
					cacheManager: cache,
					cwd: env.tmpDir,
					filePath: files[0],
					writeIndex: 2,
					coveredSources: ["lsp"],
					lensGuardEnabled: true,
				}),
			).toBe(true);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("#1561 F1: an ast-grep-origin blocker keeps gating after an LSP-only clean", () => {
		// The security case: a `cors-wildcard` / `no-commented-credentials`
		// finding must not become committable because a language server said the
		// file was fine.
		const env = setupTestEnvironment("pi-lens-git-guard-retire-source-");
		try {
			const file = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			runtime.recordInlineBlockers(
				file,
				productionSummary(file, ["cors-wildcard: origin is unbounded"]),
				1,
				["ast-grep"],
			);
			runtime.updateGitGuardStatus(true, "blocker");
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(
				retireInlineBlockerAndResyncGuard({
					runtime,
					cacheManager: cache,
					cwd: env.tmpDir,
					filePath: file,
					writeIndex: 2,
					coveredSources: ["lsp"],
					lensGuardEnabled: true,
				}),
			).toBe(false);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("still enforces a blocker for another file during per-file recovery", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-stale-sibling-");
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			runtime.recordInlineBlockers(
				files[0],
				productionSummary(files[0], ["alpha is unsafe"]),
			);
			runtime.recordInlineBlockers(
				files[1],
				productionSummary(files[1], ["beta is unsafe"]),
			);
			runtime.updateGitGuardStatus(true, "blockers");
			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);

			runtime.clearInlineBlockers(files[0]);
			runtime.updateGitGuardStatus(false, "clean A");
			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("fails closed when persisted blocker provenance omits a represented sibling", () => {
		const env = setupTestEnvironment(
			"pi-lens-git-guard-incomplete-provenance-",
		);
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			// The per-edit writer's own expression
			// (`clients/git-guard.ts:1013`), with the production summary each
			// entry carries — so the omission below is the only thing wrong
			// with this record.
			const siblingBlockerContent = files
				.map(
					(file, index) =>
						`${file}: ${productionSummary(file, [`issue ${index + 1} is unsafe`])}`,
				)
				.join("\n");
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: siblingBlockerContent,
					blockerContent: siblingBlockerContent,
					hasBlockers: true,
					affectedFiles: files,
					blockingFiles: [files[0]],
					sessionId: "session-A",
				}),
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);

			// WHICH fail-closed answer matters: the record names a file its own
			// provenance omits, so it is not a record the gate may rewrite — it is
			// untrusted. Asserting only `block: true` let the ownership check be
			// deleted with the suite green (#3282 mutation M7), because the
			// section-ownership rule below refuses the clear on its own.
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
				reason: expect.stringContaining("blocking_provenance_untrusted"),
			});
		} finally {
			env.cleanup();
		}
	});

	it.each([123, null])(
		"fails closed for forged blocking provenance (%s)",
		(forged) => {
			const env = setupTestEnvironment("pi-lens-git-guard-forged-provenance-");
			try {
				const file = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(file, "const x = 1;\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.setTelemetryIdentity({ sessionId: "session-A" });
				const cache = new CacheManager(false);
				const forgedBlockerContent = `${file}: ${productionSummary(file, ["alpha is unsafe"])}`;
				cache.writeCache(
					"turn-end-findings",
					record({
						content: forgedBlockerContent,
						blockerContent: forgedBlockerContent,
						hasBlockers: true,
						affectedFiles: [file],
						blockingFiles: [forged as unknown as string],
						sessionId: "session-A",
					}),
					env.tmpDir,
				);

				syncGitGuardRecord(runtime, cache, env.tmpDir, file);

				expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
					block: true,
				});
			} finally {
				env.cleanup();
			}
		},
	);

	it("#3282: a fixed multi-line blocker stops gating and latches no unknown", () => {
		// The reported defect, through the per-edit writer and the real gate. On
		// pre-fix code the SECOND `syncGitGuardRecord` of the session reads back
		// its own multi-line `blockerContent`, reads `  L1: alpha is unsafe` as a
		// file named `L1`, and returns early after
		// `markGitGuardCacheUnknown("blocking_provenance_untrusted")` — so the
		// record is never rewritten and every later commit in the session is
		// refused with a reason no re-run can clear.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-multiline-");
		try {
			const file = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(file, "alpha();\nbeta();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			const summary = productionSummary(file, [
				"alpha is unsafe",
				"beta is unsafe",
			]);
			expect(summary.split("\n").length).toBeGreaterThan(1);

			// Edit 1: the dispatch raises the blockers.
			runtime.recordInlineBlockers(file, summary, 1, ["ast-grep"]);
			runtime.updateGitGuardStatus(true, summary);
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);

			// Edit 2: the same file, still blocking. This is the sync that read its
			// own record back and poisoned the session.
			runtime.recordInlineBlockers(file, summary, 2, ["ast-grep"]);
			runtime.updateGitGuardStatus(true, summary);
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);
			expect(runtime.gitGuardCacheUnknownReason).toBeUndefined();

			// Edit 3: the agent FIXED it — a clean dispatch, no marks involved.
			runtime.clearInlineBlockers(file);
			runtime.updateGitGuardStatus(false, "");
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#3282: a blank line INSIDE a diagnostic message is body, not a boundary", () => {
		// `formatDiagnostics` renders a multi-line message as
		// `d.message.split("\n").join("\n  ")`
		// (`clients/dispatch/utils/format-utils.ts:21`), so a message with a blank
		// line reaches the record as a TWO-SPACE line. Only the composer's
		// zero-length `"\n\n"` part separator ends a section; treating a
		// whitespace-only line as a boundary would make the rest of the message
		// text that no blocking file owns, and re-latch the #3282 block.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-blank-body-");
		try {
			const file = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(file, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			const summary = formatDiagnostics(
				[
					blockingDiagnostic(
						file,
						1,
						"alpha is unsafe\n\nuse the checked helper instead",
					),
				],
				"blocking",
			).trim();
			expect(summary).toContain("\n  \n");
			runtime.recordInlineBlockers(file, summary, 1, ["ast-grep"]);
			runtime.updateGitGuardStatus(true, summary);
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			runtime.clearInlineBlockers(file);
			runtime.updateGitGuardStatus(false, "");
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(runtime.gitGuardCacheUnknownReason).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#3282: keeps the gate closed for a blocker section no blocking file owns", () => {
		// Named recurrence for the fail-closed direction. `blockerParts` is
		// multi-lane: the trivy CRITICAL report (`clients/runtime-turn.ts:2141`),
		// knip (`:2147`), the secrets lane (`:2099`) and cascade (`:1340`) all push
		// sections that belong to NO file, and the composer joins them into
		// `blockerContent` with `"\n\n"` (`:4291`). Attributing such a section to
		// the file section beside it would let a clean dispatch of that file clear
		// a live CVE or leaked secret out of the gate.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-unowned-");
		try {
			const file = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(file, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: "unowned",
					blockerContent: `Unresolved from this turn — ${file}:\n${productionSummary(file, ["alpha is unsafe"])}\n\n🔴 STOP — CRITICAL dependency CVEs (trivy, 3d old). Upgrade before shipping:\n  CVE-2026-1 (left-pad@1.0.0) — upgrade to 1.0.1 or later`,
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
					sessionId: "session-A",
				}),
			);

			// The file dispatches clean. The CVE section is not its to clear.
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(runtime.gitGuardCacheUnknownReason).toBe(
				"blocking_provenance_untrusted",
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#3282: a clean dispatch clears only the sections that are ITS file's", () => {
		// The clear is a PER-FILE authority claim — `syncGitGuardRecord` is called
		// with one `editedFilePath` from three sites — and it must not exceed the
		// file it is about. The record here is the turn-end composer's own shape
		// for a two-file turn (`clients/runtime-turn.ts:1085`, persisted at
		// `:4291`), with both files in `blockingFiles`, so it is fully trusted:
		// nothing but the ownership rule stands between a clean dispatch of `a.ts`
		// and `b.ts`'s blocker being dropped out of the gate.
		//
		// The blocker map is empty here on purpose. Today's writers keep it in step
		// with the record — every path that removes an entry resyncs, and the
		// composer rewrites the record from the surviving set — so this state is
		// not one a session reaches; the rule is pinned at the seam it belongs to
		// rather than through a caller that cannot express it.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-own-section-");
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			const sections = files
				.map(
					(file, index) =>
						`Unresolved from this turn — ${file}:\n${productionSummary(file, [`issue ${index + 1} is unsafe`])}`,
				)
				.join("\n\n");
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: sections,
					blockerContent: sections,
					hasBlockers: true,
					affectedFiles: files,
					blockingFiles: files,
					sessionId: "session-A",
				}),
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);

			expect(runtime.gitGuardCacheUnknownReason).toBeUndefined();
			const after = cache.readCache<Partial<TurnEndFindingsCache>>(
				"turn-end-findings",
				env.tmpDir,
			)?.data;
			expect(after?.blockerContent ?? "").toContain("issue 2 is unsafe");
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it.each([
		["\\n", "\n"],
		["\\n\\n", "\n\n"],
	])(
		"#3282 HIGH-3287-1: all-blank blocker text (%s) cannot clear another file's record",
		(_label, blockerContent) => {
			// Round 1 shipped this fail-open: `blockerContent` that is non-empty but
			// all-blank opens no section, and round 1 read "zero sections" as
			// "nothing left to attribute", so `[].every(…)` was vacuously true and a
			// clean dispatch of an UNRELATED file deleted a record whose only named
			// blocking file was `other.ts` — the gate then answered `no_record` and
			// allowed the commit.
			//
			// ADR 0003 amendment 3 already said this: the text is attributable only
			// if its FIRST non-empty line opens a section. No line opens one here, so
			// the record is unattributed and fails closed, like any other malformed
			// record. Reviewer's probe, verbatim: `blockerContent="\n"`,
			// `blockingFiles=[<cwd>/other.ts]`, clean dispatch of `<cwd>/clean.ts`
			// observed `{cleared: true, written: false}`.
			const env = setupTestEnvironment("pi-lens-git-guard-3282-blank-content-");
			try {
				const other = path.join(env.tmpDir, "other.ts");
				const clean = path.join(env.tmpDir, "clean.ts");
				fs.writeFileSync(other, "const x = 1;\n");
				fs.writeFileSync(clean, "const y = 2;\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.setTelemetryIdentity({ sessionId: "session-A" });
				const cache = new CacheManager(false);
				writeGitGuardRecord(
					cache,
					runtime,
					env.tmpDir,
					record({
						content: blockerContent,
						blockerContent,
						hasBlockers: true,
						affectedFiles: [other],
						blockingFiles: [other],
						sessionId: "session-A",
					}),
				);

				syncGitGuardRecord(runtime, cache, env.tmpDir, clean);

				expect(
					cache.readCache<Partial<TurnEndFindingsCache>>(
						"turn-end-findings",
						env.tmpDir,
					)?.data?.blockerContent,
				).toBe(blockerContent);
				expect(runtime.gitGuardCacheUnknownReason).toBe(
					"blocking_provenance_untrusted",
				);
				expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
					block: true,
					unknown: true,
				});
			} finally {
				env.cleanup();
			}
		},
	);

	it("#3282: a 4.2.1 record whose blocker text names no file stays untrusted", () => {
		// Old-record direction: this fix adds no field and changes no writer, so a
		// record persisted by 4.2.1 is read with the SAME verdict as before. The
		// fixture's `blockerContent` opens no section at all, so there is nothing
		// `blockingFiles` can be checked against — fail closed, exactly as today.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-legacy-");
		try {
			const file = path.join(env.tmpDir, "legacy.ts");
			fs.writeFileSync(file, "alpha();\n");
			const fixture = JSON.parse(
				fs.readFileSync(
					path.join(
						import.meta.dirname,
						"../fixtures/git-guard-records/4.2.1-turn-end-findings.json",
					),
					"utf-8",
				),
			) as TurnEndFindingsCache;
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			writeGitGuardRecord(cache, runtime, env.tmpDir, {
				...fixture,
				sessionId: "session-A",
				affectedFiles: [file],
				blockingFiles: [file],
			});

			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(runtime.gitGuardCacheUnknownReason).toBe(
				"blocking_provenance_untrusted",
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("#3282 acceptance 5: clearing the record as clean clears the unknown reason", () => {
		// `clearGitGuardCacheUnknown` had exactly one caller, a successful
		// `writeGitGuardRecord` (`clients/git-guard.ts:800`). A sync that finds
		// nothing left to record takes the `clearCache` branch instead and never
		// reached it, so a reason latched earlier in the session outlived the
		// record it described and refused every commit after it.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-latch-life-");
		try {
			const file = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(file, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			// A pipeline error earlier in the session — the one mark that is set
			// AFTER the sync it belongs to (`clients/runtime-tool-result.ts:2551`).
			runtime.markGitGuardCacheUnknown("pipeline_error");

			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(runtime.gitGuardCacheUnknownReason).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("allows a missing record and blocks an old unstructured record", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-empty-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cache = new CacheManager(false);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
			cache.writeCache(
				"turn-end-findings",
				{ content: "legacy blocker" },
				env.tmpDir,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
		} finally {
			env.cleanup();
		}
	});
});

/** Move the record's meta timestamp back by `ageMs` (a day: past the window). */
function ageRecord(cwd: string, ageMs = 86_400_000): void {
	const metaPath = path.join(
		getProjectDataDir(cwd),
		"cache",
		"turn-end-findings.meta.json",
	);
	fs.writeFileSync(
		metaPath,
		JSON.stringify({ timestamp: new Date(Date.now() - ageMs).toISOString() }),
	);
}

/** The stored record, read whatever its age. */
function storedData(
	cache: CacheManager,
	cwd: string,
): Partial<TurnEndFindingsCache> | undefined {
	return cache.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
		Number.POSITIVE_INFINITY,
	)?.data;
}

/** The turn-end composer's section shape for each file, as one record text. */
function composerSections(files: readonly string[]): string {
	return files
		.map(
			(file, index) =>
				`Unresolved from this turn — ${file}:\n${productionSummary(file, [`issue ${index + 1} is unsafe`])}`,
		)
		.join("\n\n");
}

function sessionA(cwd: string): RuntimeCoordinator {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = cwd;
	runtime.setTelemetryIdentity({ sessionId: "session-A" });
	return runtime;
}

describe("#4725: the record's writers read it whatever its age", () => {
	it("clears this session's own day-old record once its blocked file dispatches clean", () => {
		// RECURRENCE GUARDED: #4725 F5. `cacheRecord` read through the cache's
		// freshness window, so a clean dispatch of the blocked file met "no
		// record", latched `cache_stale` and left the record in place.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-own-stale-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([file]);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
				}),
			);
			ageRecord(env.tmpDir);

			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(runtime.gitGuardCacheUnknownReason).toBeUndefined();
			expect(storedData(cache, env.tmpDir)).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("drops a clean file's sections from another session's record, keeps it that session's, and clears it at the last one", () => {
		// RECURRENCE GUARDED: #4725 F8. A record another session wrote was never
		// cleared by anything this session did: every clean write latched
		// `session_mismatch` and returned, so the refusal had no true action.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-foreign-");
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections(files);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: files,
					blockingFiles: files,
					sessionId: "an-earlier-session",
					consumed: true,
				}),
			);

			// A clean write that reached a whole-file verdict (#4733 r1 F2): only
			// such a write speaks for another session's section.
			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0], "session", true);

			const after = storedData(cache, env.tmpDir);
			expect(after?.sessionId).toBe("an-earlier-session");
			expect(after?.consumed).toBe(true);
			expect(after?.blockerContent).toContain("issue 2 is unsafe");
			expect(after?.blockerContent).not.toContain("issue 1 is unsafe");
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal).toMatchObject({ block: true, unknown: true });
			expect(refusal.reason).toContain("session_mismatch");
			expect(refusal.reason).toContain("The record names blockers in b.ts ");
			expect(refusal.reason).toContain("write each file again");

			syncGitGuardRecord(runtime, cache, env.tmpDir, files[1], "session", true);

			expect(storedData(cache, env.tmpDir)).toBeUndefined();
			expect(runtime.gitGuardCacheUnknownReason).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("keeps another session's record whose blocker names no file, and says no re-check of one file clears it", () => {
		// The fail-closed control (#4725 F7, #1561): a section no file owns, such
		// as a project scanner's report, is never cleared by a clean dispatch of
		// the file beside it.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-unattributed-");
		try {
			const file = path.join(env.tmpDir, "legacy.ts");
			fs.writeFileSync(file, "alpha();\n");
			const fixture = JSON.parse(
				fs.readFileSync(
					path.join(
						import.meta.dirname,
						"../fixtures/git-guard-records/4.2.1-turn-end-findings.json",
					),
					"utf-8",
				),
			) as TurnEndFindingsCache;
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			writeGitGuardRecord(cache, runtime, env.tmpDir, {
				...fixture,
				affectedFiles: [file],
				blockingFiles: [file],
			});

			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(storedData(cache, env.tmpDir)?.blockerContent).toBe(
				fixture.blockerContent,
			);
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal).toMatchObject({ block: true, unknown: true });
			expect(refusal.reason).toContain(
				"cannot attribute to a file, so no re-check of one file clears them",
			);
			expect(refusal.reason).not.toContain("fresh session");

			// A record that makes no claim (3.8.74's `{ content }`, and the
			// `--lens-guard`-off writer's record) is not a re-check's either: a
			// settled turn end clears it (#4733 r1 F3), and the remedy says so.
			const fresh = sessionA(env.tmpDir);
			cache.writeCache(
				"turn-end-findings",
				{ content: "🔴 STOP — 1 issue(s) must be fixed:\n  L1: alpha" },
				env.tmpDir,
			);
			expect(evaluateGitGuard(fresh, cache, env.tmpDir).reason).toContain(
				"cache_malformed). The record makes no blocker claim pi-lens can check",
			);
		} finally {
			env.cleanup();
		}
	});

	it("clears this session's two-file record one clean file at a time, with no untrusted latch", () => {
		// RECURRENCE GUARDED: the per-file clear kept the cleaned file's own
		// section while dropping it from `blockingFiles`, so the next clean file's
		// lookup found a section nobody owned and latched
		// `blocking_provenance_untrusted` (the same seam #4725's foreign-record
		// clear depends on).
		const env = setupTestEnvironment("pi-lens-git-guard-4725-own-two-");
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections(files);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: files,
					blockingFiles: files,
				}),
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);
			syncGitGuardRecord(runtime, cache, env.tmpDir, files[1]);

			expect(runtime.gitGuardCacheUnknownReason).toBeUndefined();
			expect(storedData(cache, env.tmpDir)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("keeps a day-old record's blocker text when a test failure joins it", () => {
		// RECURRENCE GUARDED: #4725 F6. The merge read the record through the
		// freshness window, met "no record", and wrote the test failure over the
		// blocker it carried.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-merge-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([file]);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
				}),
			);
			ageRecord(env.tmpDir);

			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/1f", [
				file,
			]);

			expect(storedData(cache, env.tmpDir)?.blockerContent).toBe(text);
		} finally {
			env.cleanup();
		}
	});

	it("retires a day-old record's test failures on a passing run", () => {
		// RECURRENCE GUARDED: #4725 F6. A passing run met "no record" through the
		// freshness window and returned, so the old failure kept the gate closed.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-test-pass-");
		try {
			const file = path.join(env.tmpDir, "a.test.ts");
			fs.writeFileSync(file, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/1f", [
				file,
			]);
			ageRecord(env.tmpDir);

			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [file]);

			expect(storedData(cache, env.tmpDir)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("refuses a record that says it has no blocker beside a test failure", () => {
		// The gate admits a no-blocker claim at any age (#4725), so the one form
		// left past it, a contradiction no writer produces, must fail closed
		// rather than ride the old `!hasBlockers` allow.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-contradiction-");
		try {
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({ content: "FAIL", hasBlockers: false, testFailures: true }),
				env.tmpDir,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("keeps refusing a stored value that is not a record, and names no file", () => {
		// The fail-closed control for the any-age read (#4725): a value with no
		// record shape claims nothing, so the turn end may not retire it, and
		// the refusal must not offer a re-check that cannot clear it.
		// Recurrence: reading such a value as "no record" gave it the re-check
		// remedy (and one step further, would allow the commit).
		for (const value of [null, "garbage", 7]) {
			const env = setupTestEnvironment("pi-lens-git-guard-4725-non-record-");
			try {
				const runtime = sessionA(env.tmpDir);
				const cache = new CacheManager(false);
				cache.writeCache("turn-end-findings", value, env.tmpDir);
				expect(
					cache.inspectCache("turn-end-findings", env.tmpDir),
					String(value),
				).toBe("fresh");

				expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
					false,
				);
				const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
				expect(refusal, String(value)).toMatchObject({
					block: true,
					unknown: true,
				});
				expect(refusal.reason).toContain(
					"cache_malformed). The record holds blockers pi-lens cannot attribute",
				);
			} finally {
				env.cleanup();
			}
		}
	});

	it("names a write as the action for this session's own unknown state, never a fresh session", () => {
		// #4725 acceptance 3: a fresh session reads the same record, so the old
		// "or start a fresh session" named an action that clears nothing.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-own-remedy-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			// This session's own fresh record: its blockers are not "unconfirmed",
			// so the refusal must not borrow the other-session remedy.
			const text = composerSections([file]);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
				}),
			);
			runtime.markGitGuardCacheUnknown("pipeline_error");
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal.reason).toContain(
				"Write the affected files again so pi-lens re-checks them",
			);
			expect(refusal.reason).not.toContain("cannot confirm");
			expect(refusal.reason).not.toContain("fresh session");
		} finally {
			env.cleanup();
		}
	});

	it("caps the files a refusal names and says how many it left out, and names failing tests", () => {
		// An agent-facing list is bounded and discloses its cut (AGENTS.md
		// shape 10); a record that also holds test failures says what clears
		// them (#4725 acceptance 3).
		const env = setupTestEnvironment("pi-lens-git-guard-4725-remedy-cap-");
		try {
			const files = ["a", "b", "c", "d", "e", "f"].map((name) =>
				path.join(env.tmpDir, `${name}.ts`),
			);
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections(files);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: files,
					blockingFiles: files,
					sessionId: "an-earlier-session",
					testFailures: true,
					testFailureContent: "FAIL 0p/1f",
					testFailureFiles: [files[0]],
				}),
				env.tmpDir,
			);
			const reason = evaluateGitGuard(runtime, cache, env.tmpDir).reason ?? "";
			expect(reason).toContain(
				"The record names blockers in a.ts, b.ts, c.ts, d.ts, e.ts and 1 more that pi-lens cannot confirm.",
			);
			expect(reason).toContain(
				"Run the failing tests again: a passing run clears them.",
			);
		} finally {
			env.cleanup();
		}
	});

	it("leaves this session's record text byte for byte when an unrelated file dispatches clean", () => {
		// The per-file clear rewrites the text only when it drops a section, so
		// a record in `syncGitGuardRecord`'s own one-newline join is not
		// re-joined by a dispatch that owns none of it.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-bytes-");
		try {
			const files = ["a.ts", "b.ts", "c.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = files
				.slice(0, 2)
				.map(
					(file) => `${file}: ${productionSummary(file, ["alpha is unsafe"])}`,
				)
				.join("\n");
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: files.slice(0, 2),
					blockingFiles: files.slice(0, 2),
				}),
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, files[2]);

			expect(storedData(cache, env.tmpDir)?.blockerContent).toBe(text);
		} finally {
			env.cleanup();
		}
	});

	it("retires at a settled turn end only a record that is this session's, claims no blocker, or makes no claim", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-4725-retire-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([file]);
			const blocker = record({
				content: text,
				blockerContent: text,
				hasBlockers: true,
				affectedFiles: [file],
				blockingFiles: [file],
			});
			const cells: Array<[string, unknown, boolean]> = [
				["own blocker record", blocker, true],
				[
					"own record with a test failure",
					{ ...blocker, testFailures: true },
					false,
				],
				[
					"another session's blocker record",
					{ ...blocker, sessionId: "other" },
					false,
				],
				[
					"another session's no-blocker claim",
					record({ content: "advisory", sessionId: "other" }),
					true,
				],
				[
					"a bare no-blocker claim",
					{ content: "old", hasBlockers: false },
					true,
				],
				[
					"a no-blocker claim beside blocker text",
					{ content: "x", hasBlockers: false, blockerContent: text },
					false,
				],
				// #4733 r1 F3: a record that makes no claim (only the delivery
				// fields the `--lens-guard`-off writer and 3.8.74 wrote) answers to
				// no file, so this session's settled turn end replaces it.
				["a record with no claim", { content: "legacy blocker" }, true],
				[
					"the --lens-guard-off writer's record",
					readFixtureRecord("4.4.4-guard-off-turn-end-findings.json"),
					true,
				],
				[
					"a record with no claim but a session id",
					{ content: "x", sessionId: "other" },
					false,
				],
				[
					"a record with a claim no writer makes",
					{ content: "x", hasBlockers: "yes" },
					false,
				],
				["a record with no content", { affectedFiles: [] }, false],
				["a null record", null, false],
				["an array", [], false],
			];
			const verdicts = cells.map(([label, data]) => {
				cache.writeCache("turn-end-findings", data, env.tmpDir);
				ageRecord(env.tmpDir);
				const retired = retireSettledGitGuardRecord(runtime, cache, env.tmpDir);
				const gone = !fs.existsSync(
					path.join(
						getProjectDataDir(env.tmpDir),
						"cache",
						"turn-end-findings.json",
					),
				);
				cache.clearCache("turn-end-findings", env.tmpDir);
				return [label, retired && gone];
			});
			expect(verdicts).toEqual(cells.map(([label, , want]) => [label, want]));
		} finally {
			env.cleanup();
		}
	});

	it("reads every released record shape with the verdict its claim allows, fresh and a day old", () => {
		// Fixture corpus (principles §2): one record per writer that ever wrote
		// it — 3.8.74's `{ content }` (`clients/runtime-turn.ts` at v3.8.74), the
		// 4.2.1 lens-guard blocker record, and both 4.4.4 writers (the lens-guard
		// advisory-only record, and the record written with --lens-guard off).
		// Only an explicit no-blocker claim is admitted; every other shape fails
		// closed at either age, and a clean write retires only the admitted one.
		// [fixture, admitted by the gate and a clean write, retired by a settled
		// turn end]. #4733 r1 F3: a record with no claim is retired at the turn
		// end, never admitted.
		const corpus: Array<[string, boolean, boolean]> = [
			["3.8.74-turn-end-findings.json", false, true],
			["4.2.1-turn-end-findings.json", false, false],
			["4.4.4-advisory-turn-end-findings.json", true, true],
			["4.4.4-guard-off-turn-end-findings.json", false, true],
		];
		const env = setupTestEnvironment("pi-lens-git-guard-4725-corpus-");
		try {
			const file = path.join(env.tmpDir, "clean.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const cache = new CacheManager(false);
			const observed = corpus.flatMap(([name]) => {
				const data = JSON.parse(
					fs.readFileSync(
						path.join(
							import.meta.dirname,
							"../fixtures/git-guard-records",
							name,
						),
						"utf-8",
					),
				);
				return [false, true].map((old) => {
					const runtime = sessionA(env.tmpDir);
					cache.writeCache("turn-end-findings", data, env.tmpDir);
					if (old) ageRecord(env.tmpDir);
					const allowed = !evaluateGitGuard(runtime, cache, env.tmpDir).block;
					syncGitGuardRecord(runtime, cache, env.tmpDir, file, "session", true);
					const retired = storedData(cache, env.tmpDir) === undefined;
					cache.writeCache("turn-end-findings", data, env.tmpDir);
					if (old) ageRecord(env.tmpDir);
					const settled = retireSettledGitGuardRecord(
						sessionA(env.tmpDir),
						cache,
						env.tmpDir,
					);
					cache.clearCache("turn-end-findings", env.tmpDir);
					return [name, old ? "day-old" : "fresh", allowed, retired, settled];
				});
			});
			expect(observed).toEqual(
				corpus.flatMap(([name, admitted, settled]) =>
					["fresh", "day-old"].map((age) => [
						name,
						age,
						admitted,
						admitted,
						settled,
					]),
				),
			);
		} finally {
			env.cleanup();
		}
	});
});

/** A blocker in `blocked` and a failing `testFile`, under another session. */
function foreignBlockerAndTestRecord(
	blocked: string,
	testFile: string,
): TurnEndFindingsCache {
	const text = composerSections([blocked]);
	return record({
		content: `${text}\n\nFAIL 0p/1f`,
		blockerContent: text,
		hasBlockers: true,
		affectedFiles: [blocked, testFile],
		blockingFiles: [blocked],
		sessionId: "an-earlier-session",
		consumed: true,
		testFailures: true,
		testFailureContent: "FAIL 0p/1f",
		testFailureFiles: [testFile],
	});
}

function readFixtureRecord(name: string): unknown {
	return JSON.parse(
		fs.readFileSync(
			path.join(import.meta.dirname, "../fixtures/git-guard-records", name),
			"utf-8",
		),
	);
}

describe("#4725 r2: a writer never takes another session's record", () => {
	it("keeps another session's owner when its failing tests pass, so a clean turn end keeps its blocker", () => {
		// RECURRENCE GUARDED: #4733 r1 F1 (Greptile "Passing tests erase
		// unrelated blockers"). The passing run rewrote the record under this
		// session's id; the next clean turn end then retired it as this
		// session's own, and the commit ran with a.ts never re-checked.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-clear-owner-");
		try {
			const blocked = path.join(env.tmpDir, "a.ts");
			const testFile = path.join(env.tmpDir, "b.test.ts");
			fs.writeFileSync(blocked, "debugger;\n");
			fs.writeFileSync(testFile, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				foreignBlockerAndTestRecord(blocked, testFile),
				env.tmpDir,
			);
			ageRecord(env.tmpDir);

			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [testFile]);

			const after = storedData(cache, env.tmpDir);
			expect(after?.sessionId).toBe("an-earlier-session");
			expect(after?.testFailures).toBe(false);
			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal).toMatchObject({ block: true, unknown: true });
			expect(refusal.reason).toContain("The record names blockers in a.ts ");
		} finally {
			env.cleanup();
		}
	});

	it("keeps another session's owner when a test failure joins its blocker record", () => {
		// RECURRENCE GUARDED: #4733 r1 F1, the merge half: the merge stamped this
		// session's id on another session's blocker, and its passing run and a
		// clean turn end then deleted it.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-merge-owner-");
		try {
			const blocked = path.join(env.tmpDir, "a.ts");
			const testFile = path.join(env.tmpDir, "b.test.ts");
			fs.writeFileSync(blocked, "debugger;\n");
			fs.writeFileSync(testFile, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([blocked]);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [blocked],
					blockingFiles: [blocked],
					sessionId: "an-earlier-session",
				}),
				env.tmpDir,
			);
			ageRecord(env.tmpDir);

			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/1f", [
				testFile,
			]);
			expect(storedData(cache, env.tmpDir)?.sessionId).toBe(
				"an-earlier-session",
			);
			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [testFile]);

			expect(storedData(cache, env.tmpDir)?.sessionId).toBe(
				"an-earlier-session",
			);
			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("stamps this session on a test failure it merges into a record that held no blocker", () => {
		// The other side of the owner rule: with no stored blocker section left
		// to speak for, the record is this session's evidence, so this session's
		// own settled turn end may judge it once its test passes.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-merge-own-");
		try {
			const testFile = path.join(env.tmpDir, "b.test.ts");
			fs.writeFileSync(testFile, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({ content: "advisory", sessionId: "an-earlier-session" }),
				env.tmpDir,
			);

			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/1f", [
				testFile,
			]);

			expect(storedData(cache, env.tmpDir)?.sessionId).toBe("session-A");
		} finally {
			env.cleanup();
		}
	});

	it("keeps another session's section when the write reached no whole-file clean verdict", () => {
		// RECURRENCE GUARDED: #4733 r1 F2 (Greptile "Unanswered checks clear
		// blockers"). The trim read "this session's map has no entry for the
		// file" as "this session checked it clean", so a timed-out or
		// unanswered run dropped another session's section, and the last one
		// cleared the record (AGENTS.md shape 10: a run with no verdict
		// observes nothing).
		const env = setupTestEnvironment("pi-lens-git-guard-4733-no-verdict-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([file]);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
					sessionId: "an-earlier-session",
				}),
				env.tmpDir,
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(storedData(cache, env.tmpDir)?.blockerContent).toBe(text);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);

			syncGitGuardRecord(runtime, cache, env.tmpDir, file, "session", true);

			expect(storedData(cache, env.tmpDir)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("retires a day-old record the guard-off writer left at a settled turn end, and the commit runs", () => {
		// RECURRENCE GUARDED: #4733 r1 F3. The `--lens-guard`-off writer
		// (`clients/runtime-turn.ts`, the `else` branch) writes a record with no
		// claim. Past the delivery window nothing consumed it, so it refused
		// every guarded commit in every session: a clean write latched
		// `cache_stale` and the turn end kept it.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-guard-off-");
		try {
			const file = path.join(env.tmpDir, "clean.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				readFixtureRecord("4.4.4-guard-off-turn-end-findings.json"),
				env.tmpDir,
			);
			ageRecord(env.tmpDir);

			syncGitGuardRecord(runtime, cache, env.tmpDir, file, "session", true);
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal).toMatchObject({ block: true, unknown: true });
			expect(refusal.reason).toContain(
				"The record makes no blocker claim pi-lens can check, so no re-check of one file clears it; a turn that ends with no blocker clears it. Then retry.",
			);

			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				true,
			);
			expect(runtime.gitGuardCacheUnknownReason).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("keeps a latch about a dispatch when a settled turn end retires the record", () => {
		// The latch rule's other side: `pipeline_error` describes a write pi-lens
		// could not check, not the record, so retiring the record leaves it.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-dispatch-latch-");
		try {
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				{ content: "old", hasBlockers: false },
				env.tmpDir,
			);
			runtime.markGitGuardCacheUnknown("pipeline_error");

			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				true,
			);

			expect(runtime.gitGuardCacheUnknownReason).toBe("pipeline_error");
		} finally {
			env.cleanup();
		}
	});

	it("releases the latch about a record when a passing run deletes that record", () => {
		// RECURRENCE GUARDED: #4733 r1 F4. The passing run (the action the
		// refusal named) deleted the record and left `session_mismatch`
		// latched, so the gate still refused, with a different remedy.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-latch-");
		try {
			const other = path.join(env.tmpDir, "other.ts");
			const testFile = path.join(env.tmpDir, "b.test.ts");
			fs.writeFileSync(other, "const x = 1;\n");
			fs.writeFileSync(testFile, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: "FAIL 0p/1f",
					hasBlockers: true,
					affectedFiles: [testFile],
					sessionId: "an-earlier-session",
					testFailures: true,
					testFailureContent: "FAIL 0p/1f",
					testFailureFiles: [testFile],
				}),
				env.tmpDir,
			);
			ageRecord(env.tmpDir);
			syncGitGuardRecord(runtime, cache, env.tmpDir, other, "session", true);
			expect(runtime.gitGuardCacheUnknownReason).toBe("session_mismatch");

			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [testFile]);

			expect(storedData(cache, env.tmpDir)).toBeUndefined();
			expect(runtime.gitGuardCacheUnknownReason).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("names the passing run for this session's own fresh record that holds test failures", () => {
		// RECURRENCE GUARDED: #4733 r1 F5 (Sourcery "Test-failure remedy is
		// omitted"). A fresh own record returned before the test sentence, so
		// the refusal named only a write, which clears no test failure.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-own-tests-");
		try {
			const testFile = path.join(env.tmpDir, "b.test.ts");
			fs.writeFileSync(testFile, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/1f", [
				testFile,
			]);
			runtime.markGitGuardCacheUnknown("pipeline_error");

			const reason = evaluateGitGuard(runtime, cache, env.tmpDir).reason ?? "";

			expect(reason).toContain(
				"Run the failing tests again: a passing run clears them.",
			);
			expect(reason).toContain("Write the affected files again");
		} finally {
			env.cleanup();
		}
	});

	it("does not print a blocker path outside the project in the refusal", () => {
		// RECURRENCE GUARDED: #4733 r1 F6. `toProjectRelativePath` returns an
		// outside path unchanged, so the model-facing refusal printed it.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-outside-");
		try {
			const inside = path.join(env.tmpDir, "a.ts");
			const outside = path.join(
				path.dirname(env.tmpDir),
				"outside-4733-probe",
				"secret.ts",
			);
			fs.writeFileSync(inside, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([inside, outside]);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [inside, outside],
					blockingFiles: [inside, outside],
					sessionId: "an-earlier-session",
				}),
				env.tmpDir,
			);

			const reason = evaluateGitGuard(runtime, cache, env.tmpDir).reason ?? "";

			expect(reason).toContain(
				"The record names blockers in a.ts and 1 file outside the project that pi-lens cannot confirm.",
			);
			expect(reason).not.toContain("outside-4733-probe");
		} finally {
			env.cleanup();
		}
	});

	it("refuses a no-blocker claim beside test-failure text or files", () => {
		// RECURRENCE GUARDED: #4733 r1 F7. The contradiction refusal read
		// `testFailures` and `blockerContent` only, so `hasBlockers: false`
		// beside a test failure's text or files was admitted and allowed.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-claim-");
		try {
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			for (const extra of [
				{ testFailureContent: "FAIL 0p/1f" },
				{ testFailureFiles: [path.join(env.tmpDir, "b.test.ts")] },
			]) {
				cache.writeCache(
					"turn-end-findings",
					record({ content: "x", hasBlockers: false, ...extra }),
					env.tmpDir,
				);
				expect(
					evaluateGitGuard(runtime, cache, env.tmpDir),
					Object.keys(extra)[0],
				).toMatchObject({ block: true, unknown: true });
			}
		} finally {
			env.cleanup();
		}
	});
});
