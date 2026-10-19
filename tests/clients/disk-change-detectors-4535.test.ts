// flake-shape: real-process-spawn — a HEAD move exists only in a real repository that git checks out; a stubbed git could not rewrite the files the look lists in its delta.
/**
 * #4535 slice 2: the two detectors that still named a consumer now publish.
 *
 * Before this slice the HEAD look (`lookAtHead`) and the bash write path
 * (`handleToolResult`'s bash branch) each drove the LSP consumer themselves:
 * filter the population to held documents, send the stale ones to the primary
 * servers and wait out their drain barrier, then run the drift pass detached.
 * Both call sites are deleted; the publish is the only delivery, so these
 * cases drive the real detector entry points (`resyncHeadMove`, the two hook
 * handlers) and assert the record a subscriber receives and the calls the LSP
 * subscriber makes, through a service double at the host boundary.
 *
 * The red half of every case here is the publish itself: on base, neither
 * detector publishes anything, so the observer sees no record and no origin
 * ever reaches a subscriber.
 */
import fs from "node:fs";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { hashContentBytes } from "../../clients/content-stamp.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	type DiskChange,
	publishDiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import {
	BASH_RECOVERY_DRIFT_SOURCE,
	BASH_WRITE_SOURCE,
	LSP_CONSUMER,
	readHeldDocumentsAnswer,
	SAME_HEAD_DISCARD_SOURCE,
} from "../../clients/disk-change-subscribers.js";
import {
	getLSPService,
	resetLSPService,
} from "../../clients/lsp/capabilities.js";
import { configureLspServiceLifecycle } from "../../clients/lsp/service-singleton.js";
import { HOOK_WALL_BUDGET_MS } from "../../clients/hook-budgets.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";
import { getGlobalPiLensLogDir } from "../../clients/probe-home-state.js";
import {
	captureGitDirtyPaths,
	observeGitHead,
	SAME_HEAD_DIRTY_SET_CAP,
} from "../../clients/opaque-mutation-scan.js";
import { lookForOutOfBandChanges } from "../../clients/out-of-band-changes.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { resetSessionScopedState } from "../../clients/runtime-session.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import {
	handleToolResult,
	resyncHeadMove,
} from "../../clients/runtime-tool-result.js";
import { execFileSync } from "../support/git-fixture-env.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { setupTestEnvironment } from "./test-utils.js";

interface ServiceCalls {
	primaries: Array<{ paths: string[]; drainMs: number }>;
	drift: Array<{ paths: string[]; maxPasses: number | undefined }>;
}

interface Harness {
	root: string;
	runtime: RuntimeCoordinator;
	publishes: DiskChange[];
	calls: ServiceCalls;
	/** Everything a case must undo, in order. */
	cleanups: Array<() => void>;
}

let tmp: string;

function git(cwd: string, ...args: string[]): string {
	return String(
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t.local",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t.local",
			},
		}),
	).trim();
}

/**
 * One case's world: a project directory, a real coordinator, a service double
 * recording the two LSP consumer calls, and a subscriber that records every
 * publish. The LSP service is the host boundary (a real one would spawn a
 * server per case); everything the detectors do — git, the baseline, the
 * publisher, the change log — is real.
 */
function harness(name: string, held: string[]): Harness {
	const root = path.join(tmp, name);
	fs.mkdirSync(root, { recursive: true });
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = root;
	resetDegradationLedger();
	// The sanctioned per-case session reset, not a hand-picked subset: it owns
	// the opaque baselines, the workspace diagnostics cache and the session
	// caches these cases would otherwise inherit from the one before them.
	resetSessionScopedState(root);
	const publishes: DiskChange[] = [];
	const calls: ServiceCalls = { primaries: [], drift: [] };
	const caseCleanups: Array<() => void> = [];
	cleanups = caseCleanups;
	caseCleanups.push(
		subscribeDiskChange("slice2-observes-publish", (change) => {
			publishes.push(change);
		}),
	);
	resetLSPService();
	const service = makeLspServiceDouble({
		getOpenDocumentPaths: () => held,
		getTrackedContent: () => ({ hash: "the-bytes-the-server-holds" }),
		resyncHeldPrimaries: async (paths: readonly string[], drainMs: number) => {
			calls.primaries.push({ paths: [...paths], drainMs });
			return { sent: paths.length, drained: true };
		},
		resyncGitChangedFiles: async (
			paths: readonly string[],
			options: { maxPasses?: number } = {},
		) => {
			calls.drift.push({ paths: [...paths], maxPasses: options.maxPasses });
			return new Map<string, string>([["resynced", "resynced"]]);
		},
	});
	configureLspServiceLifecycle<Record<string, unknown>>({
		create: () => service,
		beforeReset: () => undefined,
		destroy: async () => undefined,
	});
	getLSPService();
	return { root, runtime, publishes, calls, cleanups: caseCleanups };
}

let previousTestMode: string | undefined;

/**
 * Every case's undo, run in `afterEach` in reverse order. The publisher's
 * registry is process-wide and a worker may run several files, so an observer
 * that outlives its case would keep recording into a dead case's array and
 * answer the next file's publishes (review round 2, Greptile
 * "test observer survives teardown").
 */
let cleanups: Array<() => void> = [];

beforeAll(() => {
	// latency.log writes are off under PI_LENS_TEST_MODE (#1742); the
	// `opaque_mutation_head_moved` row is read back from the real sink.
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
});

afterAll(() => {
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
});

beforeEach(() => {
	// A harness-owned root under the worker's TMPDIR, registered with
	// `tests/support/tmp-root-registry.ts` so `vitest-setup` removes it at file
	// teardown and on SIGTERM. Before this the root was hand rolled inside the
	// checkout, which bypassed the registry and the sweep: a killed worker left
	// an untracked directory in the tree (review round 2, F8).
	//
	// `rootMarker: false` because every case below builds its own repository or
	// asserts on a directory that has none, and the shared marker would plant an
	// empty `.git` at the PARENT of every case: the project-root walk from
	// `tmp/<case>` then stops at the parent, and a case with no repository is
	// graded against a fake one instead of against its own directory.
	tmp = setupTestEnvironment("pi-lens-4535-slice2-", {
		rootMarker: false,
	}).tmpDir;
});

afterEach(() => {
	resetLSPService();
	for (const cleanup of cleanups.reverse()) cleanup();
	cleanups = [];
});

const headKey = (h: Harness) => `slice2|${h.root}`;

/** One look, as the hooks drive it. */
function look(
	h: Harness,
	trigger: "tool_call" | "tool_result" = "tool_call",
): Promise<void> {
	return resyncHeadMove({
		root: h.root,
		key: headKey(h),
		trigger,
		label: trigger === "tool_call" ? "read" : "git checkout B",
	});
}

/**
 * A repository on branch `A` whose branch `B` rewrites `lib.ts`, with the
 * session's first look already taken and branch `B` already checked out: the
 * next look is the one that sees a move (a first observation only records
 * HEAD).
 */
async function repoAfterMove(h: Harness): Promise<string> {
	const dir = h.root;
	fs.writeFileSync(path.join(dir, "lib.ts"), "export const v = 1;\n");
	fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n");
	// Commit ids stay unique per case so this file can pick its own row out of
	// the shared latency sink without matching a sibling case's move.
	fs.writeFileSync(path.join(dir, "repo-id.txt"), `${path.basename(dir)}\n`);
	git(dir, "init", "-q", "-b", "A");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "base");
	git(dir, "branch", "B");
	git(dir, "checkout", "-q", "B");
	fs.writeFileSync(path.join(dir, "lib.ts"), "export const v = 2;\n");
	fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n\nmore\n");
	git(dir, "commit", "-qam", "B");
	git(dir, "checkout", "-q", "A");
	await look(h);
	git(dir, "checkout", "-q", "B");
	return dir;
}

/**
 * The `opaque_mutation_head_moved` rows this case's repository wrote. Each
 * fixture commits a `repo-id.txt` naming its own directory, so the commit ids
 * unique to it are the filter and no sibling case's row can match.
 */
async function headMovedRows(
	h: Harness,
): Promise<Array<{ result: string; metadata: Record<string, unknown> }>> {
	await flushLatencyLog();
	const to = git(h.root, "rev-parse", "B").slice(0, 12);
	const log = path.join(getGlobalPiLensLogDir(), "latency.log");
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.includes('"opaque_mutation_head_moved"'))
		.map(
			(line) =>
				JSON.parse(line) as {
					result: string;
					metadata: Record<string, unknown>;
				},
		)
		.filter((row) => row.metadata.to === to);
}

describe("the HEAD look publishes instead of calling the LSP consumer", () => {
	it("publishes the moved delta and the LSP consumer resyncs the held document", async () => {
		const dir = path.join(tmp, "head-move");
		const lib = path.join(dir, "lib.ts");
		const h = harness("head-move", [normalizeMapKey(lib)]);
		await repoAfterMove(h);

		await look(h, "tool_result");

		const moved = h.publishes.filter((change) => change.origin === "head-move");
		expect(moved).toHaveLength(1);
		expect(moved[0]).toMatchObject({
			root: normalizeMapKey(dir),
			kind: "inferred",
			// A HEAD move records no mutation (#4493): the publish carries no
			// sequence, and a subscriber must read 0 as "no seq evidence".
			seq: 0,
		});
		expect([...(moved[0]?.paths ?? [])]).toEqual(
			expect.arrayContaining([normalizeMapKey(lib)]),
		);
		// The held document is the only one that reaches the primary phase.
		expect(h.calls.primaries).toEqual([
			{
				paths: [normalizeMapKey(lib)],
				drainMs: HOOK_WALL_BUDGET_MS.tool_result_read_only,
			},
		]);
		await expect.poll(() => h.calls.drift.length, { timeout: 5000 }).toBe(1);
		expect(h.calls.drift[0]).toEqual({
			paths: [normalizeMapKey(lib)],
			maxPasses: 16,
		});
	}, 30_000);

	it("publishes an unlistable delta as unenumerable so no held document is skipped", async () => {
		const dir = path.join(tmp, "head-move-unknown");
		const lib = path.join(dir, "lib.ts");
		const h = harness("head-move-unknown", [normalizeMapKey(lib)]);
		await repoAfterMove(h);
		// The old HEAD is garbage, so `git diff` fails: the delta is unknown.
		observeGitHead(headKey(h), "0".repeat(40));

		await look(h);

		const moved = h.publishes.filter((change) => change.origin === "head-move");
		expect(moved).toHaveLength(1);
		expect(moved[0]?.paths).toBe("unknown");
		// An unknown population leaves every held document as a candidate.
		expect(h.calls.primaries.map((call) => call.paths)).toEqual([
			[normalizeMapKey(lib)],
		]);
		// `held` counts a different population on this branch, and the row says
		// which one it counted (review F5).
		const rows = await headMovedRows(h);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata.heldPopulation).toBe("all-held");
	}, 30_000);

	it("sends nothing and starts no drift pass when the move leaves held bytes current", async () => {
		const dir = path.join(tmp, "head-move-current");
		const lib = path.join(dir, "lib.ts");
		const h = harness("head-move-current", [normalizeMapKey(lib)]);
		await repoAfterMove(h);
		// A second service answer: the server already holds the disk bytes.
		configureLspServiceLifecycle<Record<string, unknown>>({
			create: () =>
				makeLspServiceDouble({
					getOpenDocumentPaths: () => [normalizeMapKey(lib)],
					getTrackedContent: () => ({
						hash: hashContentBytes(
							Buffer.from(fs.readFileSync(lib, "utf8"), "utf8"),
						),
					}),
					resyncHeldPrimaries: async (paths: readonly string[]) => {
						h.calls.primaries.push({ paths: [...paths], drainMs: 0 });
						return { sent: paths.length, drained: true };
					},
					// Recorded by the REPLACEMENT too, so the "no drift pass" case
					// below asserts an effect it can see rather than an empty array no
					// double ever filled (review round 2, Greptile "drift calls go
					// unobserved").
					resyncGitChangedFiles: async (
						paths: readonly string[],
						options: { maxPasses?: number } = {},
					) => {
						h.calls.drift.push({
							paths: [...paths],
							maxPasses: options.maxPasses,
						});
						return new Map();
					},
				}),
			beforeReset: () => undefined,
			destroy: async () => undefined,
		});
		resetLSPService();
		getLSPService();

		await look(h, "tool_result");

		expect(
			h.publishes.filter((change) => change.origin === "head-move"),
		).toHaveLength(1);
		expect(h.calls.primaries).toEqual([]);
		expect(h.calls.drift).toEqual([]);
	}, 30_000);

	it("reports a throwing LSP consumer as failed, never as a clean zero", async () => {
		const dir = path.join(tmp, "head-move-threw");
		const lib = path.join(dir, "lib.ts");
		const h = harness("head-move-threw", [normalizeMapKey(lib)]);
		await repoAfterMove(h);
		// The consumer itself throws. `getOpenDocumentPaths` is the first call it
		// makes, and before this round `fanOut` left the consumer out of the
		// results map, which read as "no LSP consumer" — a clean zero for
		// documents that were never looked at.
		configureLspServiceLifecycle<Record<string, unknown>>({
			create: () =>
				makeLspServiceDouble({
					getOpenDocumentPaths: () => {
						throw new Error("consumer exploded");
					},
					getTrackedContent: () => ({ hash: "the-bytes-the-server-holds" }),
					resyncHeldPrimaries: async () => ({ sent: 0, drained: true }),
					resyncGitChangedFiles: async () => new Map(),
				}),
			beforeReset: () => undefined,
			destroy: async () => undefined,
		});
		resetLSPService();
		getLSPService();
		resetDegradationLedger();

		await look(h, "tool_result");

		const rows = await headMovedRows(h);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			result: "resync-failed",
			// `-1`: the documents were never checked, so this is not a count.
			metadata: { held: -1, failed: expect.any(Number) },
		});
		const kinds = getDegradationSummary().map((group) => group.kind);
		expect(kinds).toContain("disk-change-subscriber-failed");
		// The registry case's row must not answer for a consumer that did answer.
		expect(kinds).not.toContain("disk-change-lsp-consumer-missing");
	}, 30_000);
});

/**
 * One bash call, as the two hooks drive it: the `tool_call` that records the
 * call's baseline and the `tool_result` that publishes what it wrote. Shared
 * by every describe below that needs a real bash write.
 */
function sessionFor(h: Harness) {
	let n = 0;
	const callDeps = (input: unknown, toolCallId: string) =>
		({
			event: { toolName: "bash", toolCallId, input },
			ctx: { cwd: h.root },
			lensEnabled: true,
			getFlag: () => false,
			dbg: () => {},
			runtime: h.runtime,
			cacheManager: new CacheManager(false),
			ensureLSPConfigInitialized: async () => {},
			updateLspStatus: () => {},
			resetLSPService: () => {},
			sessionId: "slice2-session",
		}) as Parameters<typeof handleToolCall>[0];
	const resultDeps = (command: string, toolCallId: string) =>
		({
			event: {
				toolName: "bash",
				toolCallId,
				input: { command },
				content: [{ type: "text", text: "ok" }],
			},
			getFlag: () => false,
			dbg: () => {},
			runtime: h.runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			testRunnerClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
			sessionId: "slice2-session",
		}) as unknown as Parameters<typeof handleToolResult>[0];
	return async (command: string, run: () => void): Promise<void> => {
		const toolCallId = `slice2-c${++n}`;
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(callDeps({ command }, toolCallId)),
		);
		run();
		await handleToolResult(resultDeps(command, toolCallId));
	};
}

describe("a bash command's written documents publish instead of calling the LSP consumer", () => {
	it("publishes the written set for the primary phase from a parser-recognized write", async () => {
		const target = path.join(tmp, "bash-write", "a.ts");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "export const a = 1;\n");
		const file = normalizeMapKey(target);
		const h = harness("bash-write", [file]);

		await sessionFor(h)("sed -i s/1/2/ a.ts", () => {
			fs.writeFileSync(target, "export const a = 2;\n");
		});

		const published = h.publishes.filter(
			(change) => change.origin === "bash-recovery",
		);
		const primary = published.filter((change) =>
			change.sources.includes(BASH_WRITE_SOURCE),
		);
		expect(primary).toHaveLength(1);
		expect(primary[0]).toMatchObject({ kind: "inferred", seq: 0 });
		expect([...(primary[0]?.paths ?? [])]).toEqual([file]);
		// The LSP consumer observed the publish: the held, stale document went
		// to the primary before the synthetic dispatch below it.
		expect(h.calls.primaries).toEqual([
			{ paths: [file], drainMs: HOOK_WALL_BUDGET_MS.tool_result_edit },
		]);
		// A parser-recognized write has no recovered set, so no drift pass.
		expect(
			published.filter((change) =>
				change.sources.includes(BASH_RECOVERY_DRIFT_SOURCE),
			),
		).toEqual([]);
	}, 30_000);

	it("publishes the recovered set for the detached drift pass, after the primary phase", async () => {
		const dir = path.join(tmp, "bash-recovery");
		const h = harness("bash-recovery", [
			normalizeMapKey(path.join(dir, "b.ts")),
		]);
		const target = path.join(dir, "b.ts");
		fs.writeFileSync(target, "export const b = 1;\n");
		const file = normalizeMapKey(target);

		await sessionFor(h)("node codemod.mjs", () => {
			fs.writeFileSync(target, "export const b = 2;\n");
		});

		const published = h.publishes.filter(
			(change) => change.origin === "bash-recovery",
		);
		const drift = published.filter((change) =>
			change.sources.includes(BASH_RECOVERY_DRIFT_SOURCE),
		);
		expect(drift).toHaveLength(1);
		expect(drift[0]).toMatchObject({ kind: "inferred", seq: 0 });
		expect([...(drift[0]?.paths ?? [])]).toEqual([file]);
		const order = published.map((change) => change.sources[0]);
		expect(order.indexOf(BASH_WRITE_SOURCE)).toBeLessThan(
			order.indexOf(BASH_RECOVERY_DRIFT_SOURCE),
		);
		await expect.poll(() => h.calls.drift.length, { timeout: 5000 }).toBe(1);
		expect(h.calls.drift[0]?.paths).toEqual([file]);
	}, 30_000);

	it("still resyncs the whole recovered set when it is over the publisher's path cap", async () => {
		const dir = path.join(tmp, "bash-recovery-capped");
		fs.mkdirSync(dir, { recursive: true });
		const files = Array.from({ length: 65 }, (_, i) =>
			path.join(dir, `m${i}.ts`),
		);
		for (const file of files) fs.writeFileSync(file, "export const v = 1;\n");
		const h = harness("bash-recovery-capped", []);

		await sessionFor(h)("node codemod.mjs", () => {
			for (const file of files) {
				fs.writeFileSync(file, "export const v = 2;\n");
			}
		});

		const drift = h.publishes.filter((change) =>
			change.sources.includes(BASH_RECOVERY_DRIFT_SOURCE),
		);
		// Every recovered publish stays inside the cap, so none of them is
		// reported as unenumerable and the drift pass has a population to run on.
		expect(drift.length).toBeGreaterThan(0);
		expect(drift.filter((change) => change.paths === "unknown")).toEqual([]);
		await expect
			.poll(() => h.calls.drift.flatMap((call) => call.paths).length, {
				timeout: 30_000,
			})
			.toBe(files.length);
		expect(new Set(h.calls.drift.flatMap((call) => call.paths))).toEqual(
			new Set(files.map(normalizeMapKey)),
		);
	}, 60_000);
});

describe("a publish that reaches no LSP consumer", () => {
	it("records one bounded row per root instead of reading as no held document", () => {
		const root = normalizeMapKey(path.join(tmp, "no-consumer"));
		const first = readHeldDocumentsAnswer(new Map(), root, new Set());
		expect(first).toMatchObject({ held: 0, targets: [] });
		const second = readHeldDocumentsAnswer(new Map(), root, new Set());
		expect(second).toMatchObject({ held: 0, targets: [] });
		expect(
			getDegradationSummary().filter(
				(group) => group.kind === "disk-change-lsp-consumer-missing",
			),
		).toEqual([
			expect.objectContaining({ kind: "disk-change-lsp-consumer-missing" }),
		]);
	});

	it("returns the answer the consumer gave when one exists", () => {
		const answer = {
			held: 3,
			targets: [],
			primary: 0,
			failed: false,
			drained: true,
		};
		expect(
			readHeldDocumentsAnswer(
				new Map([[LSP_CONSUMER, answer]]),
				"/x",
				new Set(),
			),
		).toBe(answer);
	});

	it("reads a consumer that answered `undefined` as one that answered", () => {
		// The `settled-sweep` and `drift-heartbeat` branches answer `undefined` on
		// purpose. `results.has` is what separates "answered nothing to check" from
		// "was never asked": reading the two as one recorded a false
		// `disk-change-lsp-consumer-missing` row for a consumer that answered
		// (review round 3, p3-2).
		const root = normalizeMapKey(path.join(tmp, "answered-undefined"));
		resetDegradationLedger();
		expect(
			readHeldDocumentsAnswer(
				new Map([[LSP_CONSUMER, undefined]]),
				root,
				new Set(),
			),
		).toMatchObject({ held: 0, targets: [], failed: false });
		expect(
			getDegradationSummary().filter(
				(group) => group.kind === "disk-change-lsp-consumer-missing",
			),
		).toEqual([]);
	});
});

describe("a publish whose LSP consumer threw", () => {
	it("answers failed and unchecked, never as no held document", () => {
		const root = normalizeMapKey(path.join(tmp, "threw"));
		resetDegradationLedger();
		const answer = readHeldDocumentsAnswer(
			new Map(),
			root,
			new Set([LSP_CONSUMER]),
		);
		expect(answer).toMatchObject({
			held: -1,
			targets: [],
			primary: 0,
			failed: true,
			drained: false,
		});
		// "the consumer threw" and "no consumer answered" are opposite facts, and
		// only the second one is what `disk-change-lsp-consumer-missing` means.
		expect(
			getDegradationSummary().filter(
				(group) => group.kind === "disk-change-lsp-consumer-missing",
			),
		).toEqual([]);
	});
});

describe("a publish over the recorded path cap", () => {
	it("names what it kept and says no sequence was allocated without a runtime", async () => {
		const root = normalizeMapKey(path.join(tmp, "truncated"));
		resetDegradationLedger();
		const { change } = await publishDiskChange({
			root,
			origin: "bash-recovery",
			kind: "inferred",
			paths: Array.from({ length: 65 }, (_, i) => path.join(root, `c${i}.ts`)),
		});
		expect(change.paths).toBe("unknown");
		const [row] = getDegradationSummary().filter(
			(group) => group.kind === "disk-change-paths-truncated",
		);
		expect(row?.latestReasons[0]?.reason).toContain("are named");
		expect(row?.latestReasons[0]?.reason).toContain("no runtime");
	});
});

/**
 * #4612 round 3 (HIGH): a listed population over
 * `DISK_CHANGE_MAX_RECORDED_PATHS` used to be published as `paths: "unknown"`,
 * and the consumer's only honest reading of that is the WHOLE held set. The
 * awaited primary send then left the change: with 65 changed documents and 135
 * unrelated held ones, `changedSent` was 0/65 and `unrelatedSent` 64/135 — a
 * changed document kept its server's pre-change view while the dispatch that
 * ran right after read it. The detector publishes in chunks now, so every
 * publish stays inside the cap and the send is drawn from the change.
 */
describe("an over-cap publish keeps its send inside the change", () => {
	/** Branch `B` rewrites `count` files; `A` has them all. */
	function wideMoveRepo(h: Harness, count: number): string[] {
		const files = Array.from({ length: count }, (_, i) => `m${i}.ts`);
		for (const file of files)
			fs.writeFileSync(path.join(h.root, file), "export const v = 1;\n");
		fs.writeFileSync(
			path.join(h.root, "repo-id.txt"),
			`${path.basename(h.root)}\n`,
		);
		git(h.root, "init", "-q", "-b", "A");
		git(h.root, "add", "-A");
		git(h.root, "commit", "-qm", "base");
		git(h.root, "branch", "B");
		git(h.root, "checkout", "-q", "B");
		for (const file of files)
			fs.writeFileSync(path.join(h.root, file), "export const v = 2;\n");
		git(h.root, "commit", "-qam", "B");
		git(h.root, "checkout", "-q", "A");
		return files.map((file) => normalizeMapKey(path.join(h.root, file)));
	}

	it("sends every changed held document of an over-cap HEAD move and no unrelated one", async () => {
		const dir = path.join(tmp, "wide-move");
		fs.mkdirSync(dir, { recursive: true });
		const changed = Array.from({ length: 65 }, (_, i) =>
			normalizeMapKey(path.join(dir, `m${i}.ts`)),
		);
		// The held set is 200 documents: the 65 the move rewrote and 135 the
		// publish never names. A stale server hash makes every one of them a
		// candidate, so the population the send is drawn from is visible.
		const unrelated = Array.from({ length: 135 }, (_, i) =>
			normalizeMapKey(path.join(dir, "elsewhere", `u${i}.ts`)),
		);
		// The unrelated documents are listed FIRST, which is the state probe E
		// reproduced: an `"unknown"` population spends its capped send on them.
		const h = harness("wide-move", [...unrelated, ...changed]);
		const files = wideMoveRepo(h, 65);
		expect(files).toEqual(changed);
		// The session's first look only records HEAD; the second sees the move.
		await look(h);
		git(dir, "checkout", "-q", "B");

		await look(h, "tool_result");

		// The delivery is the claim: the numbers are probe E's, read as one
		// assertion, because a publish that happened but sent nothing to the
		// change is the defect this cell exists for.
		const sent = new Set(h.calls.primaries.flatMap((call) => call.paths));
		expect({
			changedSent: changed.filter((filePath) => sent.has(filePath)).length,
			unrelatedSent: unrelated.filter((filePath) => sent.has(filePath)).length,
		}).toEqual({ changedSent: 65, unrelatedSent: 0 });
		const published = h.publishes.filter(
			(change) => change.origin === "head-move",
		);
		expect(published.length).toBeGreaterThan(1);
		// No publish is reported as unenumerable: every one of them listed its own
		// population, so the cap never decided this delivery.
		expect(published.filter((change) => change.paths === "unknown")).toEqual(
			[],
		);
		expect(
			new Set(published.flatMap((change) => [...(change.paths as string[])])),
		).toEqual(new Set(changed));
	}, 30_000);

	it("sends every written held document of an over-cap bash write and no unrelated one", async () => {
		const dir = path.join(tmp, "wide-bash");
		fs.mkdirSync(dir, { recursive: true });
		const files = Array.from({ length: 65 }, (_, i) =>
			path.join(dir, `m${i}.ts`),
		);
		for (const file of files) fs.writeFileSync(file, "export const v = 1;\n");
		const written = files.map(normalizeMapKey);
		const unrelated = Array.from({ length: 135 }, (_, i) =>
			normalizeMapKey(path.join(dir, "elsewhere", `u${i}.ts`)),
		);
		const h = harness("wide-bash", [...unrelated, ...written]);

		await sessionFor(h)("node codemod.mjs", () => {
			for (const file of files) fs.writeFileSync(file, "export const v = 2;\n");
		});

		// No drift pass heals this branch, so a send spent outside the change is
		// simply stale: the whole population must reach the primary phase.
		const sent = new Set(h.calls.primaries.flatMap((call) => call.paths));
		expect({
			changedSent: written.filter((filePath) => sent.has(filePath)).length,
			unrelatedSent: unrelated.filter((filePath) => sent.has(filePath)).length,
		}).toEqual({ changedSent: 65, unrelatedSent: 0 });
		const primary = h.publishes.filter(
			(change) =>
				change.origin === "bash-recovery" &&
				change.sources.includes(BASH_WRITE_SOURCE),
		);
		expect(primary.length).toBeGreaterThan(1);
		expect(primary.filter((change) => change.paths === "unknown")).toEqual([]);
		// The row is the monitor's evidence for the same delivery, and it is read
		// back here (#4597): the record the body names is asserted, not described.
		await flushLatencyLog();
		const log = path.join(getGlobalPiLensLogDir(), "latency.log");
		const rows = fs.existsSync(log)
			? fs
					.readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>)
					.filter(
						(row) =>
							String(row.filePath).includes("wide-bash") &&
							row.phase === "bash_write_primary_resync",
					)
			: [];
		expect(rows.map((row) => row.phase)).toContain("bash_write_primary_resync");
		expect(rows.at(-1)?.metadata).toMatchObject({ written: 65, targets: 65 });
	}, 60_000);

	it("records one bounded row when a recovered chunk's drift pass rejects", async () => {
		const dir = path.join(tmp, "chunk-rejects");
		fs.mkdirSync(dir, { recursive: true });
		const files = Array.from({ length: 65 }, (_, i) =>
			path.join(dir, `m${i}.ts`),
		);
		for (const file of files) fs.writeFileSync(file, "export const v = 1;\n");
		const h = harness("chunk-rejects", []);
		resetDegradationLedger();
		// The detached chain awaits each chunk's drift pass; the second chunk's
		// rejection used to leave the rest unpublished with a `dbg` line only.
		configureLspServiceLifecycle<Record<string, unknown>>({
			create: () =>
				makeLspServiceDouble({
					getOpenDocumentPaths: () => [],
					getTrackedContent: () => undefined,
					resyncHeldPrimaries: async () => ({ sent: 0, drained: true }),
					resyncGitChangedFiles: async () => {
						throw new Error("drift refused");
					},
				}),
			beforeReset: () => undefined,
			destroy: async () => undefined,
		});
		resetLSPService();
		getLSPService();

		await sessionFor(h)("node codemod.mjs", () => {
			for (const file of files) fs.writeFileSync(file, "export const v = 2;\n");
		});

		await expect
			.poll(
				() =>
					getDegradationSummary()
						.filter(
							(group) => group.kind === "disk-change-recovered-drift-failed",
						)
						.map((group) => group.latestReasons[0]?.reason ?? ""),
				{ timeout: 30_000 },
			)
			.toEqual([expect.stringContaining("were never republished")]);
		const [row] = getDegradationSummary().filter(
			(group) => group.kind === "disk-change-recovered-drift-failed",
		);
		expect(row?.latestReasons[0]?.reason).toContain("chunk 1 of 2");
		expect(row?.latestReasons[0]?.subject).toBe(normalizeMapKey(dir));
	}, 60_000);
});

/**
 * #4502: a same-HEAD discard. `git stash`, `git checkout .` and `git restore`
 * rewrite working-tree bytes, keep HEAD, and leave `git status` clean, so both
 * of the head-move detector's signals name nothing while an open document keeps
 * the reverted bytes. The bash call's own baseline is the only evidence: dirty
 * before, clean after. The cells drive the real hooks, a real repository and a
 * real `git stash` / `git checkout .`.
 */
describe("a same-HEAD discard resyncs the documents it reverted", () => {
	/** A repo with `lib.ts` committed at v1 and dirty at v2. */
	function dirtyRepo(name: string): { h: Harness; lib: string } {
		const dir = path.join(tmp, name);
		fs.mkdirSync(dir, { recursive: true });
		const lib = path.join(dir, "lib.ts");
		fs.writeFileSync(lib, "export const v = 1;\n");
		git(dir, "init", "-q", "-b", "main");
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", "base");
		fs.writeFileSync(lib, "export const v = 2;\n");
		return { h: harness(name, [normalizeMapKey(lib)]), lib };
	}

	it("resyncs what `git stash` reverted before the tool_result returns", async () => {
		const { h, lib } = dirtyRepo("discard-stash");

		await sessionFor(h)("git stash", () => {
			git(h.root, "stash", "-q");
		});

		const published = h.publishes.filter(
			(change) => change.origin === "head-move",
		);
		expect(published).toHaveLength(1);
		const discard = published[0];
		expect(discard?.sources).toContain(SAME_HEAD_DISCARD_SOURCE);
		// HEAD did not move: the publish is the discard's, and the row says so.
		expect(discard?.paths).toEqual([normalizeMapKey(lib)]);
		// The awaited send ran before the result returned: the held document's
		// server copy is the discarded bytes, so it had to be resent.
		expect(h.calls.primaries.flatMap((call) => call.paths)).toEqual([
			normalizeMapKey(lib),
		]);
	}, 30_000);

	it("resyncs what `git checkout .` reverted", async () => {
		const { h, lib } = dirtyRepo("discard-checkout");

		await sessionFor(h)("git checkout .", () => {
			git(h.root, "checkout", ".");
		});

		const published = h.publishes.filter(
			(change) => change.origin === "head-move",
		);
		expect(published).toHaveLength(1);
		expect(published[0]?.sources).toContain(SAME_HEAD_DISCARD_SOURCE);
		expect(h.calls.primaries.flatMap((call) => call.paths)).toEqual([
			normalizeMapKey(lib),
		]);
	}, 30_000);

	it("publishes nothing when the command leaves the dirty set dirty", async () => {
		const { h } = dirtyRepo("discard-none");

		// A command that rewrites nothing keeps every dirty path dirty, so no
		// discard happened and no look is published for it.
		await sessionFor(h)("true", () => {});

		expect(
			h.publishes.filter((change) =>
				change.sources.includes(SAME_HEAD_DISCARD_SOURCE),
			),
		).toEqual([]);
	}, 30_000);
});

/**
 * #4612 round 3, p3-1: the out-of-band look's row read a consumer that THREW as
 * one that restarted nothing (`restarted: 0`), which is the same row a clean
 * look with no install writes. The other two readers were taught to tell
 * "never asked" from "asked and failed" in round 2; this is the third, and on a
 * root whose primary client restart fails it is the only evidence there is.
 */
describe("an out-of-band look whose LSP consumer throws", () => {
	it("reports the restart count as -1, never as a clean zero", async () => {
		const dir = path.join(tmp, "oob-throws");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "types.d.ts"),
			"declare const A: number;\n",
		);
		harness("oob-throws", []);
		configureLspServiceLifecycle<Record<string, unknown>>({
			create: () =>
				makeLspServiceDouble({
					getOpenDocumentPaths: () => [],
					getTrackedContent: () => undefined,
					resyncHeldPrimaries: async () => ({ sent: 0, drained: true }),
					resyncGitChangedFiles: async () => new Map(),
					restartPrimaryClientsUnder: async () => {
						throw new Error("restart refused");
					},
				}),
			beforeReset: () => undefined,
			destroy: async () => undefined,
		});
		resetLSPService();
		getLSPService();
		const previous = process.env.PI_LENS_DECLARATION_LOOK_MS;
		process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
		try {
			// The first look records the install stamp; the lockfile appearing is
			// the second look's `install` source, which is what restarts clients.
			await lookForOutOfBandChanges(dir, "tool_call");
			fs.writeFileSync(path.join(dir, "package-lock.json"), "{}\n");
			await lookForOutOfBandChanges(dir, "tool_result");
		} finally {
			if (previous === undefined)
				delete process.env.PI_LENS_DECLARATION_LOOK_MS;
			else process.env.PI_LENS_DECLARATION_LOOK_MS = previous;
		}

		await flushLatencyLog();
		const log = path.join(getGlobalPiLensLogDir(), "latency.log");
		const rows = fs.existsSync(log)
			? fs
					.readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>)
					.filter(
						(row) =>
							row.phase === "lsp_out_of_band_change" && row.filePath === dir,
					)
			: [];
		expect(rows.map((row) => row.result)).toContain("install");
		expect(rows.at(-1)?.metadata).toMatchObject({ restarted: -1 });
		expect(getDegradationSummary().map((group) => group.kind)).toContain(
			"disk-change-subscriber-failed",
		);
	}, 30_000);
});

/**
 * #4502: the pre-command dirty set is bounded, and a bound on a delivery path
 * says so. `SAME_HEAD_DIRTY_SET_CAP` keeps the pending baseline small; a tree
 * with more dirty paths than that is read up to the cap, and one counted row
 * names the loss instead of a silent truncation (AGENTS.md shape 10).
 */
describe("the pre-command dirty set is bounded and says when it is cut", () => {
	it("keeps SAME_HEAD_DIRTY_SET_CAP paths and records one capped row", async () => {
		const dir = path.join(tmp, "dirty-set-cap");
		fs.mkdirSync(dir, { recursive: true });
		git(dir, "init", "-q", "-b", "main");
		const count = SAME_HEAD_DIRTY_SET_CAP + 1;
		for (let i = 0; i < count; i += 1)
			fs.writeFileSync(path.join(dir, `d${i}.ts`), "export const v = 1;\n");
		resetDegradationLedger();

		const dirty = await captureGitDirtyPaths(dir);

		expect(dirty).toHaveLength(SAME_HEAD_DIRTY_SET_CAP);
		const [row] = getDegradationSummary().filter(
			(group) => group.kind === "same-head-discard-set-capped",
		);
		expect(row?.latestReasons[0]?.reason).toContain(
			"is not detected for this call",
		);
		expect(row?.latestReasons[0]?.subject).toBe(normalizeMapKey(dir));
	}, 30_000);
});
