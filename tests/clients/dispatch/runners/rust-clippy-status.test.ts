/**
 * #3751 — the rust-clippy runner reported `status: "failed"` both when clippy
 * could not produce a usable result and when it succeeded and found a
 * deny-level lint. `status` must carry the execution outcome only; severity
 * lives in `semantic` and the diagnostics (CONTRIBUTING.md, "Adding a dispatch
 * runner"). These tests drive the real runner and the real `dispatchForFile`
 * so a deny-level clippy lint still blocks.
 *
 * clippy is not installed on the CI host, so the process boundary is a recorded
 * `cargo clippy --message-format=json` stream
 * (`tests/fixtures/clippy/eq-op-deny.jsonl`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { resetDispatchAvailabilityState } from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import type { RunnerResult } from "../../../../clients/dispatch/types.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, tryLazyInstall, findCargoPathAsync } = vi.hoisted(
	() => ({
		safeSpawnAsync: vi.fn(),
		tryLazyInstall: vi.fn(async () => true),
		findCargoPathAsync: vi.fn(async () => "cargo"),
	}),
);

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/lazy-installer.js",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		tryLazyInstall,
	}),
);

vi.mock("../../../../clients/rust-client.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	rustClient: { findCargoPathAsync },
}));

const CLIPPY_FIXTURE = path.resolve("tests/fixtures/clippy/eq-op-deny.jsonl");

function writeCrate(tmpDir: string): string {
	fs.writeFileSync(
		path.join(tmpDir, "Cargo.toml"),
		'[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	const filePath = path.join(tmpDir, "src", "main.rs");
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "fn main() {\n    let y = x == x;\n}\n");
	return filePath;
}

async function dispatchClippy(tmpDir: string, filePath: string) {
	const { createDispatchContext, dispatchForFile, RunnerRegistry } =
		await import("../../../../clients/dispatch/dispatcher.js");
	const runner = (
		await import("../../../../clients/dispatch/runners/rust-clippy.js")
	).default;
	const registry = new RunnerRegistry();
	registry.register(runner);
	let observed: RunnerResult | undefined;
	const result = await dispatchForFile(
		createDispatchContext(
			filePath,
			tmpDir,
			{ getFlag: () => false },
			new FactStore(),
		),
		[{ mode: "all", runnerIds: ["rust-clippy"] }],
		registry,
		(_id, res) => {
			observed = res;
		},
	);
	return { observed, result };
}

describe("rust-clippy status is the execution outcome (#3751)", () => {
	beforeEach(() => {
		safeSpawnAsync.mockReset();
		tryLazyInstall.mockClear();
		resetDispatchAvailabilityState();
	});

	it("a deny-level lint is a successful run that still blocks", async () => {
		const env = setupTestEnvironment("pi-lens-clippy-status-");
		try {
			const filePath = writeCrate(env.tmpDir);
			const output = fs.readFileSync(CLIPPY_FIXTURE, "utf8");
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: { stdout: output, stderr: "", status: 101 },
			);

			const { observed, result } = await dispatchClippy(env.tmpDir, filePath);

			// The run succeeded: clippy executed and produced parseable output.
			expect(observed?.status).toBe("succeeded");
			// The severity is carried by semantic and the diagnostic itself.
			expect(observed?.semantic).toBe("blocking");
			expect(observed?.diagnostics.map((d) => d.rule)).toEqual([
				"clippy::eq_op",
			]);
			// The lint still blocks through the real dispatch path: the
			// dispatcher derives blockers from `semantic`, never from `status`.
			expect(result.hasBlockers).toBe(true);
			expect(result.blockers.map((d) => d.rule)).toEqual(["clippy::eq_op"]);
		} finally {
			env.cleanup();
		}
	});

	it("unparsable clippy output is the arm that reports failed", async () => {
		const env = setupTestEnvironment("pi-lens-clippy-unparsable-");
		try {
			const filePath = writeCrate(env.tmpDir);
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				args.includes("--version")
					? { stdout: "clippy 0.1.0", stderr: "", status: 0 }
					: {
							stdout: "cargo clippy failed without json",
							stderr: "",
							status: 101,
						},
			);

			const { observed } = await dispatchClippy(env.tmpDir, filePath);

			// A run that produced no usable result is the only failure left.
			expect(observed?.status).toBe("failed");
			expect(observed?.semantic).toBe("warning");
		} finally {
			env.cleanup();
		}
	});
});
