import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import javacRunner from "../../../clients/dispatch/runners/javac.js";
import type { RunnerResult } from "../../../clients/dispatch/types.js";
import { setupTestEnvironment } from "../test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
}));

vi.mock("../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

vi.mock("../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: (command: string) => ({
		isAvailableAsync: async () => true,
		getCommand: () => command,
	}),
}));

describe("javac dispatcher integration (#1877)", () => {
	beforeEach(() => {
		clearCoverageNoticeState();
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});
	});

	it("reports unavailable analysis when the descriptor gate skips javac", async () => {
		const env = setupTestEnvironment("pi-lens-javac-dispatch-notice-");
		try {
			const filePath = path.join(env.tmpDir, "module", "src", "App.java");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "class App {}\n");
			fs.writeFileSync(path.join(env.tmpDir, "pom.xml"), "<project />\n");

			const registry = createJavaRegistry();
			const outcomes = new Map<string, RunnerResult>();
			const ctx = createDispatchContext(
				filePath,
				env.tmpDir,
				{ getFlag: () => false },
				new FactStore(),
				undefined,
				undefined,
				env.tmpDir,
			);
			const result = await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["lsp", "javac"] }],
				registry,
				(id, runnerResult) => outcomes.set(id, runnerResult),
			);

			expect(outcomes.get("lsp")?.status).toBe("skipped");
			expect(outcomes.get("javac")?.status).toBe("skipped");
			expect(safeSpawnAsync).not.toHaveBeenCalled();
			expect(result.output).toContain("Pi-lens java analysis unavailable");
			expect(result.output).toContain("not a clean result");
		} finally {
			env.cleanup();
		}
	});

	it("does not let a descriptor above projectRoot gate javac", async () => {
		const env = setupTestEnvironment("pi-lens-javac-dispatch-ceiling-");
		try {
			const projectRoot = path.join(env.tmpDir, "session-project");
			const filePath = path.join(projectRoot, "scratch", "App.java");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "class App {}\n");
			fs.writeFileSync(path.join(env.tmpDir, "pom.xml"), "<project />\n");

			const registry = createJavaRegistry();
			const outcomes = new Map<string, RunnerResult>();
			const ctx = createDispatchContext(
				filePath,
				projectRoot,
				{ getFlag: () => false },
				new FactStore(),
				undefined,
				undefined,
				projectRoot,
			);
			await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["lsp", "javac"] }],
				registry,
				(id, runnerResult) => outcomes.set(id, runnerResult),
			);

			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
			expect(outcomes.get("javac")?.status).toBe("succeeded");
		} finally {
			env.cleanup();
		}
	});
});

function createJavaRegistry(): RunnerRegistry {
	const registry = new RunnerRegistry();
	registry.register({
		id: "lsp",
		appliesTo: ["java"],
		priority: 4,
		enabledByDefault: true,
		async run() {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		},
	});
	registry.register(javacRunner);
	return registry;
}
