import { beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/latency-logger.js", () => ({ logLatency }));

import {
	probeTsserverProjectIdentity,
	type TsserverProjectIdentityCommandChannel,
} from "../../../clients/lsp/tsserver-sync.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";

function options(
	executeCommand: NonNullable<
		TsserverProjectIdentityCommandChannel["executeCommand"]
	>,
) {
	return {
		serverId: "typescript",
		launchVariant: "classic" as const,
		clientRoot: "/repo",
		file: "/repo/src/app.ts",
		probedFiles: new Set<string>(),
		commandChannel: { executeCommand },
	};
}

describe("classic TypeScript project-identity telemetry (#1412)", () => {
	beforeEach(() => {
		logLatency.mockReset();
	});

	it("logs a configured project after a successful projectInfo response", async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			executed: true,
			result: {
				success: true,
				body: {
					configFileName: "/repo/tsconfig.json",
					languageServiceDisabled: false,
				},
			},
		});
		await probeTsserverProjectIdentity(options(executeCommand));

		expect(executeCommand).toHaveBeenCalledWith(
			"typescript.tsserverRequest",
			["projectInfo", { file: "/repo/src/app.ts", needFileNameList: false }],
		);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_typescript_project_identity",
				filePath: normalizeMapKey("/repo/src/app.ts"),
				metadata: expect.objectContaining({
					serverId: "typescript",
					launchVariant: "classic",
					clientRoot: "/repo",
					projectKind: "configured",
					configFile: "/repo/tsconfig.json",
					association: "associated",
				}),
			}),
		);
	});

	it("classifies the inferred-project sentinel", async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			executed: true,
			result: {
				success: true,
				body: { configFileName: "/dev/null/inferredProject1*" },
			},
		});
		await probeTsserverProjectIdentity(options(executeCommand));

		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					projectKind: "inferred",
					association: "associated",
				}),
			}),
		);
	});

	it.each([
		["error", vi.fn().mockRejectedValue(new Error("projectInfo failed"))],
		["timeout", vi.fn().mockResolvedValue({ executed: false, reason: "timed out" })],
	])("silently ignores a command %s", async (_name, executeCommand) => {
		await expect(
			probeTsserverProjectIdentity(options(executeCommand)),
		).resolves.toBeUndefined();
		expect(logLatency).not.toHaveBeenCalled();
	});

	it("deduplicates normalized aliases once per client and file", async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			executed: true,
			result: { success: true, body: {} },
		});
		const first = { ...options(executeCommand), file: "C:\\Repo\\src\\app.ts" };
		await probeTsserverProjectIdentity(first);
		await probeTsserverProjectIdentity({ ...first, file: "c:\\repo\\src\\APP.ts" });

		expect(executeCommand).toHaveBeenCalledTimes(1);
		expect(logLatency).toHaveBeenCalledTimes(1);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					projectKind: "unassociated",
					association: "unassociated",
				}),
			}),
		);
	});

	it("is a no-op for native TS7", async () => {
		const executeCommand = vi.fn();
		await probeTsserverProjectIdentity({
			...options(executeCommand),
			launchVariant: "native-ts7",
		});
		expect(executeCommand).not.toHaveBeenCalled();
	});
});
