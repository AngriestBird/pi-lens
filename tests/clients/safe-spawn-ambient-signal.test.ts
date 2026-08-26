/**
 * #197 — `safeSpawnAsync` defaults to the ambient turn abort signal.
 *
 * The lifecycle handlers publish pi's `ctx.signal` via `setAmbientAbortSignal`,
 * so dispatches that don't thread their own signal still cancel when the agent
 * is interrupted. These tests pin the defaulting/precedence/clearing behaviour
 * via the deterministic early-abort path (an already-aborted signal resolves
 * without spawning a real process).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	SpawnFailureError,
	safeSpawnAsync,
	setAmbientAbortSignal,
} from "../../clients/safe-spawn.js";
import { truncatedByOutputCap } from "../../clients/spawn-output-cap.js";
import { capKilledSpawnResult } from "../support/spawn-shapes.js";

// A trivial, immediately-exiting node invocation — guaranteed to exist on every
// CI platform via process.execPath.
const NODE = process.execPath;
const EXIT_OK = ["-e", "process.exit(0)"];

afterEach(() => setAmbientAbortSignal(undefined));

describe("safeSpawnAsync ambient abort signal (#197)", () => {
	it("aborts when the ambient signal is already aborted and no explicit signal is passed", async () => {
		setAmbientAbortSignal(AbortSignal.abort());

		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(result.status).toBeNull();
		expect(result.error?.message ?? "").toMatch(/aborted before start/i);
	});

	// `status !== null` means the child actually ran to an exit code rather than
	// being short-circuited by the early-abort path (which yields status null +
	// an "aborted before start" error). The exit code itself is irrelevant here.
	it("does not abort once the ambient signal is cleared", async () => {
		setAmbientAbortSignal(AbortSignal.abort());
		setAmbientAbortSignal(undefined); // cleared in the handler's finally

		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});

	it("an explicit signal takes precedence over the ambient one", async () => {
		// Ambient is aborted, but the call passes its own live signal — the
		// explicit option wins (`options.signal ?? ambient`), so it still runs.
		setAmbientAbortSignal(AbortSignal.abort());
		const live = new AbortController();

		const result = await safeSpawnAsync(NODE, EXIT_OK, { signal: live.signal });

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});

	it("with no ambient and no explicit signal, the spawn runs normally", async () => {
		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});

	it("ignoreAmbientSignal opts out of an aborted ambient signal (installs run to completion)", async () => {
		setAmbientAbortSignal(AbortSignal.abort());

		const result = await safeSpawnAsync(NODE, EXIT_OK, {
			ignoreAmbientSignal: true,
		});

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});

	it("kills a noisy child when the retained output reaches its byte cap", async () => {
		const result = await safeSpawnAsync(
			NODE,
			[
				"-e",
				"process.stdout.write('x'.repeat(100000)); setTimeout(() => {}, 10000);",
			],
			{ timeout: 5000, maxOutputBytes: 1024 },
		);

		expect(result.outputTruncated).toBe(true);
		expect(
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
		).toBeLessThanOrEqual(1024);
		// #2100: the shape every truncation guard downstream must actually match.
		// A cap kill is a SIGTERM, so it arrives as a signal failure carrying
		// `outputTruncated` — never the status-0 pairing the mocks assumed.
		// `capKilledSpawnResult` mirrors this; keep the two in step.
		expect({
			status: result.status,
			failure: result.failure,
			signal: result.signal,
			spawnFailureKind: result.spawnFailure?.kind,
		}).toEqual({
			status: null,
			failure: "signal",
			signal: "SIGTERM",
			spawnFailureKind: "killed",
		});
		expect(result.spawnFailure).toBeInstanceOf(SpawnFailureError);
		expect(capKilledSpawnResult({ stdout: result.stdout })).toMatchObject({
			status: result.status,
			failure: result.failure,
			signal: result.signal,
		});
		expect(truncatedByOutputCap(result)).toBe(true);
	});

	// #2100 review F2: `outputTruncated` is spread into EVERY resolve branch, and
	// `timedOut`/`aborted` are set unconditionally — so a run that hit the cap and
	// then timed out (or was interrupted) carries the flag under a timeout/abort
	// failure. Those endings own their own classification; only the cap's own
	// SIGTERM (or a tool that beat it out the door) is a truncation verdict.
	// Both children ignore SIGTERM so the cap's kill cannot settle them first.
	it("reports a capped run that then timed out as a timeout, not a truncation", async () => {
		const result = await safeSpawnAsync(
			NODE,
			[
				"-e",
				"process.on('SIGTERM', () => {}); setInterval(() => process.stdout.write('x'.repeat(4096)), 1);",
			],
			{ timeout: 300, maxOutputBytes: 1024 },
		);

		expect(result.outputTruncated).toBe(true);
		expect(result.failure).toBe("timeout");
		expect(truncatedByOutputCap(result)).toBe(false);
	});

	it("reports a capped run that was then aborted as an abort, not a truncation", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300).unref();

		const result = await safeSpawnAsync(
			NODE,
			[
				"-e",
				"process.on('SIGTERM', () => {}); setInterval(() => process.stdout.write('x'.repeat(4096)), 1);",
			],
			{ timeout: 10_000, maxOutputBytes: 1024, signal: controller.signal },
		);

		expect(result.outputTruncated).toBe(true);
		expect(result.failure).toBe("aborted");
		expect(truncatedByOutputCap(result)).toBe(false);
	});

	it("retains late output in the tail after an output-cap kill", async () => {
		const result = await safeSpawnAsync(
			NODE,
			[
				"-e",
				"process.stdout.write('h'.repeat(100000)); process.stdout.write('late-rescue');",
			],
			{ timeout: 5000, maxOutputBytes: 1024 },
		);

		expect(result.outputTruncated).toBe(true);
		expect(`${result.stdout}\n${result.stderr}`).toContain("late-rescue");
		expect(
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
		).toBeLessThanOrEqual(1024);
	});
});
