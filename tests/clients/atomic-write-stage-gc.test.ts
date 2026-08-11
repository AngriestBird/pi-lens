import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ATOMIC_STAGE_SWEEP_MAX_ENTRIES,
	sweepAtomicWriteStages,
} from "../../clients/instance-reaper.js";

const cleanup: string[] = [];

function makeDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-stage-gc-"));
	cleanup.push(dir);
	return dir;
}

function stage(dir: string, name: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, "staging");
	return file;
}

afterEach(() => {
	while (cleanup.length > 0) {
		fs.rmSync(cleanup.pop() as string, { recursive: true, force: true });
	}
});

describe("sweepAtomicWriteStages (#1228)", () => {
	it("removes dead-owner files in all supported old and current naming shapes", async () => {
		const dir = makeDir();
		const dead = [
			stage(dir, "state.json.tmp-41001"),
			stage(dir, "state.json.tmp-41002-7"),
			stage(dir, "state.json.tmp-41003-2-7"),
		];

		const result = await sweepAtomicWriteStages([dir], {
			isPidAlive: () => false,
		});

		expect(result.removed).toBe(3);
		expect(dead.every((file) => !fs.existsSync(file))).toBe(true);
	});

	it("preserves live foreign owners and every current-process staging file", async () => {
		const dir = makeDir();
		const liveForeign = stage(dir, "state.json.tmp-42001-3-9");
		const currentProcess = stage(
			dir,
			`state.json.tmp-${process.pid}-0-99`,
		);
		const unrelated = stage(dir, "state.json.tmp-42001-3-9-extra");
		const ordinary = stage(dir, "state.json");

		await sweepAtomicWriteStages([dir], {
			isPidAlive: (pid) => pid === 42001,
		});

		expect(fs.existsSync(liveForeign)).toBe(true);
		expect(fs.existsSync(currentProcess)).toBe(true);
		expect(fs.existsSync(unrelated)).toBe(true);
		expect(fs.existsSync(ordinary)).toBe(true);
	});

	it("does not remove directories or malformed/non-atomic names", async () => {
		const dir = makeDir();
		const namedDirectory = path.join(dir, "nested.tmp-43001");
		fs.mkdirSync(namedDirectory);
		const malformed = [
			stage(dir, "state.tmp-43001-1-2-3"),
			stage(dir, "state.tmp-43001-"),
			stage(dir, "state.TMP-43001"),
		];

		await sweepAtomicWriteStages([dir], { isPidAlive: () => false });

		expect(fs.existsSync(namedDirectory)).toBe(true);
		expect(malformed.every((file) => fs.existsSync(file))).toBe(true);
	});

	it("stops after the configured bounded number of directory entries", async () => {
		const dir = makeDir();
		const files = Array.from({ length: 3 }, (_, i) =>
			stage(dir, `state-${i}.tmp-4400${i}`),
		);

		const result = await sweepAtomicWriteStages([dir], {
			maxEntries: 2,
			isPidAlive: () => false,
		});

		expect(result.scanned).toBe(2);
		expect(result.removed).toBe(2);
		expect(result.truncated).toBe(true);
		expect(files.filter((file) => fs.existsSync(file))).toHaveLength(1);
	});

	it("fails closed for missing directories and invalid owner pids", async () => {
		const dir = makeDir();
		const zeroPid = stage(dir, "state.tmp-0");
		const hugePid = stage(dir, "state.tmp-999999999999999999999");

		await expect(
			sweepAtomicWriteStages(
				[path.join(dir, "missing"), dir],
				{ isPidAlive: () => false },
			),
		).resolves.toMatchObject({ directories: 2, removed: 0 });
		expect(fs.existsSync(zeroPid)).toBe(true);
		expect(fs.existsSync(hugePid)).toBe(true);
		expect(ATOMIC_STAGE_SWEEP_MAX_ENTRIES).toBeGreaterThan(0);
	});
});
