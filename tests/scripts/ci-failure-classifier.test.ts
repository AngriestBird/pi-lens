// Unit tests for the CI failure classifier (#2103): infra-oom / infra-net /
// real, plus the once-per-SHA rerun guard and the sticky-comment upsert
// shape.
//
// Log fixtures under tests/fixtures/ci-failure-logs/ are REAL captured
// output (AGENTS.md shape 16 -- never hand-write a fixture for an external
// system's behavior):
//   - real-assertion-failure.real.log: run 32913518938, job 98012237782
//     (fetch: `gh api repos/apmantza/pi-lens/actions/jobs/98012237782/logs`)
//   - infra-oom-wrapper-killed.real.log: run 32908647308 attempt 1, job
//     97998085238 -- the OOM killer took the with-memory-watch.mjs wrapper
//     itself, so there is no "[mem-watch] done"/"KILLED" verdict line at all
//   - infra-oom-bare-killed-pre-wrapper.real.log: run 32888174877 (PR #2058,
//     pre-#2042), job 97933472353 -- predates the wrapper entirely, so a
//     bare "Killed" is the only signal
// infra-net-getaddrinfo.unverified.log is NOT a captured fixture: no real
// pi-lens Unit-tests run with a DNS/network failure was found in the
// accessible run history for this issue (the "CodeQL tarball DNS error"
// #2103 cites ran in a different job/workflow). It is documented as
// unverified in scripts/lib/ci-failure-classifier.mjs and here, per the
// shape-16 screen: label the claim, don't fake verification.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildCommentBody,
	buildMarker,
	classifyFailureLog,
	decideClassifierAction,
	parseClassifierMarker,
	runClassifier,
	shouldTriggerRerun,
} from "../../scripts/lib/ci-failure-classifier.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures", "ci-failure-logs");
function fixture(name: string) {
	return readFileSync(join(fixturesDir, name), "utf8");
}

describe("classifyFailureLog (#2103)", () => {
	it("classifies a real assertion failure and extracts the failing test", () => {
		const result = classifyFailureLog(
			fixture("real-assertion-failure.real.log"),
		);
		expect(result.kind).toBe("real");
		expect(result.detail).toContain(
			"tests/clients/word-index-lifecycle.test.ts",
		);
		expect(result.detail).toContain(
			"reuses a fresh persisted snapshot without rebuilding",
		);
	});

	it("classifies the wrapper-as-victim OOM shape (no mem-watch verdict at all)", () => {
		const result = classifyFailureLog(
			fixture("infra-oom-wrapper-killed.real.log"),
		);
		expect(result.kind).toBe("infra-oom");
		// The real log's last sample before the kill (line 30 of the fixture) --
		// proves the classifier reads the actual samples rather than emitting a
		// generic "OOM happened" string with no evidence behind it.
		expect(result.detail).toContain("availableMb=12999 of 15989");
	});

	it("classifies the pre-#2042 bare-Killed OOM shape (no wrapper existed yet)", () => {
		const result = classifyFailureLog(
			fixture("infra-oom-bare-killed-pre-wrapper.real.log"),
		);
		expect(result.kind).toBe("infra-oom");
		expect(result.detail).toContain(
			"no [mem-watch] verdict line -- the OOM killer took the wrapper itself",
		);
	});

	it("classifies the mem-watch KILLED verdict when the wrapper survives to report it", () => {
		// Exercises the literal string formatVerdict() in
		// scripts/lib/memory-watch.mjs actually emits (verified against that
		// shipped source, not guessed) -- no real captured log has this shape
		// on hand because it requires the wrapper to survive the kill, which
		// the two real OOM fixtures above did not.
		const log =
			"...\n[mem-watch] KILLED — no failing assertion means the OS reclaimed memory, not a test failure. signal=SIGKILL totalMb=15990 lowWaterAvailableMb=102 lowWaterAt=12:00:00\n##[error]Process completed with exit code 137.\n";
		const result = classifyFailureLog(log);
		expect(result.kind).toBe("infra-oom");
		expect(result.detail).toContain("[mem-watch] KILLED");
	});

	it("classifies a getaddrinfo/DNS network failure as infra-net (UNVERIFIED shape, see file header)", () => {
		const result = classifyFailureLog(
			fixture("infra-net-getaddrinfo.unverified.log"),
		);
		expect(result.kind).toBe("infra-net");
		expect(result.detail).toContain("ENOTFOUND");
	});

	// Acceptance criterion: "Real failures are never rerun automatically and
	// never labeled infra." A real FAIL block can coexist with an unrelated
	// "Killed" elsewhere in the same log (a spawned linter's child process,
	// noise from a different tool) -- the real classification must win.
	it("never labels a log infra when it also contains a FAIL block, even alongside Killed/137 noise", () => {
		const log =
			`${fixture("infra-oom-wrapper-killed.real.log")}\n` +
			`${fixture("real-assertion-failure.real.log")}`;
		const result = classifyFailureLog(log);
		expect(result.kind).toBe("real");
	});

	// Spec default (#2103 proposal step 1: "otherwise real"). An unrecognized
	// failure shape must default to real, not infra -- treating "we don't
	// understand this" as infra would make an unknown, possibly-persistent
	// failure eligible for an automatic rerun loop.
	it("defaults an unrecognized failure shape to real, not infra", () => {
		const log =
			"some tool crashed with a stack trace\n##[error]Process completed with exit code 1.\n";
		const result = classifyFailureLog(log);
		expect(result.kind).toBe("real");
	});
});

describe("marker round-trip (#2103)", () => {
	it("parses back exactly what it built", () => {
		const marker = buildMarker("abc1234", true);
		expect(parseClassifierMarker(`some text ${marker}`)).toEqual({
			sha: "abc1234",
			rerunTriggered: true,
		});
	});

	it("returns null for a comment with no marker", () => {
		expect(parseClassifierMarker("just a regular PR comment")).toBeNull();
		expect(parseClassifierMarker(null)).toBeNull();
		expect(parseClassifierMarker(undefined)).toBeNull();
	});
});

describe("shouldTriggerRerun once-per-SHA guard (#2103)", () => {
	const infra = { kind: "infra-oom" as const, detail: "no failing assertion" };
	const real = {
		kind: "real" as const,
		detail: "some/file.test.ts > some test",
	};

	it("never triggers a rerun for a real classification", () => {
		expect(
			shouldTriggerRerun({
				classification: real,
				sha: "sha1",
				existingMarker: null,
			}),
		).toBe(false);
	});

	it("triggers on the first infra classification for a SHA (no prior comment)", () => {
		expect(
			shouldTriggerRerun({
				classification: infra,
				sha: "sha1",
				existingMarker: null,
			}),
		).toBe(true);
	});

	// Mutation-proof screen: this is the guard itself. Deleting the
	// `existingMarker.sha === sha && existingMarker.rerunTriggered` condition
	// (e.g. replacing the function body with `return true`) turns this
	// specific assertion red -- it is the one case where "already reran, same
	// commit" must block a second rerun.
	it("does NOT re-trigger for the same SHA once the marker already recorded rerun=true", () => {
		expect(
			shouldTriggerRerun({
				classification: infra,
				sha: "sha1",
				existingMarker: { sha: "sha1", rerunTriggered: true },
			}),
		).toBe(false);
	});

	it("does trigger again for a NEW sha, even if the previous sha was already rerun", () => {
		expect(
			shouldTriggerRerun({
				classification: infra,
				sha: "sha2",
				existingMarker: { sha: "sha1", rerunTriggered: true },
			}),
		).toBe(true);
	});

	it("still allows a rerun when the prior marker for this SHA recorded rerun=false", () => {
		// e.g. the first pass classified this SHA as real (rerun=false stored),
		// and a later re-run of the classifier on the same SHA reclassifies as
		// infra -- the guard only blocks an ALREADY-TRIGGERED rerun, not every
		// repeat visit to the SHA.
		expect(
			shouldTriggerRerun({
				classification: infra,
				sha: "sha1",
				existingMarker: { sha: "sha1", rerunTriggered: false },
			}),
		).toBe(true);
	});

	it("simulates two consecutive classifier passes on the same SHA end-to-end via decideClassifierAction", () => {
		const rawLog = fixture("infra-oom-wrapper-killed.real.log");
		const sha = "deadbeef";

		const first = decideClassifierAction({
			rawLog,
			sha,
			existingCommentBody: null,
		});
		expect(first.rerunTriggered).toBe(true);

		// The second pass reads back the comment the first pass would have
		// posted -- this is the realistic call shape the CLI's runClassifier
		// uses (existing comment body -> marker -> guard).
		const second = decideClassifierAction({
			rawLog,
			sha,
			existingCommentBody: first.commentBody,
		});
		expect(second.rerunTriggered).toBe(false);
	});
});

describe("runClassifier orchestration against a mocked GitHub API (#2103)", () => {
	function jsonResponse(body: unknown, status = 200) {
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
			text: async () => JSON.stringify(body),
		};
	}
	function textResponse(body: string, status = 200) {
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => JSON.parse(body),
			text: async () => body,
		};
	}

	function mockApi({
		existingComments = [] as Array<{ id: number; body: string }>,
	} = {}) {
		const calls: Array<{ method: string; url: string; body?: unknown }> = [];
		const rawLog = fixture("infra-oom-wrapper-killed.real.log");
		const fetcher = async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				method,
				url,
				body:
					typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			if (url.endsWith("/actions/runs/999")) {
				return jsonResponse({
					head_sha: "deadbeef",
					pull_requests: [{ number: 42 }],
				});
			}
			if (url.endsWith("/actions/runs/999/jobs")) {
				return jsonResponse({
					jobs: [
						{ id: 111, name: "Unit tests", conclusion: "failure" },
						{ id: 222, name: "Lint & type-check", conclusion: "success" },
					],
				});
			}
			if (url.endsWith("/actions/jobs/111/logs")) {
				return textResponse(rawLog);
			}
			if (url.includes("/issues/42/comments")) {
				return jsonResponse(existingComments);
			}
			if (/\/issues\/comments\/\d+$/.test(url)) {
				return jsonResponse({ ok: true });
			}
			if (url.endsWith("/actions/runs/999/rerun-failed-jobs")) {
				return jsonResponse({}, 201);
			}
			throw new Error(`unmocked URL in test: ${method} ${url}`);
		};
		return { fetcher, calls };
	}

	it("posts a new comment and triggers a rerun on the first infra failure for a SHA", async () => {
		const { fetcher, calls } = mockApi();
		const result = await runClassifier({
			fetcher,
			owner: "acme",
			repo: "repo",
			runId: 999,
		});

		expect(result.classification.kind).toBe("infra-oom");
		expect(result.rerunTriggered).toBe(true);

		const posted = calls.find(
			(c) => c.method === "POST" && c.url.includes("/comments"),
		);
		expect(posted).toBeDefined();
		expect((posted?.body as { body: string }).body).toContain(
			"ci-classifier: infra-oom",
		);

		const reran = calls.find((c) => c.url.includes("rerun-failed-jobs"));
		expect(reran).toBeDefined();
	});

	it("updates the existing sticky comment in place instead of posting a second one, and skips the rerun once already triggered for this SHA", async () => {
		const priorBody = `ci-classifier: infra-oom (no failing assertion) ${buildMarker("deadbeef", true)}`;
		const { fetcher, calls } = mockApi({
			existingComments: [{ id: 555, body: priorBody }],
		});

		const result = await runClassifier({
			fetcher,
			owner: "acme",
			repo: "repo",
			runId: 999,
		});

		expect(result.rerunTriggered).toBe(false);

		const posted = calls.find(
			(c) => c.method === "POST" && c.url.includes("/comments"),
		);
		expect(posted).toBeUndefined();
		const patched = calls.find(
			(c) => c.method === "PATCH" && c.url.endsWith("/issues/comments/555"),
		);
		expect(patched).toBeDefined();

		const reran = calls.find((c) => c.url.includes("rerun-failed-jobs"));
		expect(reran).toBeUndefined();
	});
});

describe("buildCommentBody (#2103)", () => {
	it("renders one visible line with the marker trailing on the same line", () => {
		const body = buildCommentBody({
			classification: { kind: "infra-oom", detail: "no failing assertion" },
			sha: "abc1234",
			rerunTriggered: true,
		});
		expect(body.split("\n")).toHaveLength(1);
		expect(body).toContain("ci-classifier: infra-oom");
		expect(body).toContain("auto-rerun triggered");
		expect(body).toContain(buildMarker("abc1234", true));
	});

	it("renders the real-failure line without any rerun language", () => {
		const body = buildCommentBody({
			classification: { kind: "real", detail: "tests/x.test.ts > some test" },
			sha: "abc1234",
			rerunTriggered: false,
		});
		expect(body).toBe(
			"ci-classifier: real — first failure: tests/x.test.ts > some test " +
				buildMarker("abc1234", false),
		);
	});
});
