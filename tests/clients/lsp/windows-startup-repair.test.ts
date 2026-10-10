import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlatform } from "../../support/platform-stub.js";

const ensureTool = vi.hoisted(() => vi.fn(async () => undefined));

class MockChildProcess extends EventEmitter {
	stdin = new EventEmitter();
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	exitCode: number | null = null;
	killed = false;
}

describe("Windows LSP startup repair classification (#4263)", () => {
	afterEach(() => {
		setPlatform(process.platform);
		vi.resetModules();
		vi.doUnmock("node:child_process");
		vi.doUnmock("../../../clients/installer/index.js");
		vi.clearAllMocks();
	});

	it("repairs an absent bare command reported as exit-code 1", async () => {
		const originalPlatform = process.platform;
		setPlatform("win32");
		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn(() => ""),
			spawn: vi.fn(() => {
				const proc = new MockChildProcess();
				queueMicrotask(() => {
					proc.exitCode = 1;
					proc.emit("exit", 1, null);
				});
				return proc;
			}),
		}));
		vi.doMock("../../../clients/installer/index.js", async (importActual) => ({
			...(await importActual<
				typeof import("../../../clients/installer/index.js")
			>()),
			ensureTool,
			findManagedToolBinary: vi.fn(async () => undefined),
		}));

		try {
			const { resolveAndLaunch } =
				await import("../../../clients/lsp/server.js");
			await resolveAndLaunch(
				{
					candidates: ["missing-language-server"],
					args: ["--stdio"],
					cwd: "C:\\project",
					managedToolId: "missing-language-server",
				},
				true,
			);
			expect(ensureTool).toHaveBeenCalledWith("missing-language-server");
		} finally {
			setPlatform(originalPlatform);
		}
	});

	it("does not repair a present binary that exits with code 1", async () => {
		const originalPlatform = process.platform;
		setPlatform("win32");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4263-"));
		const shim = path.join(root, "bin", "server.cmd");
		const target = path.join(root, "pkg", "bin", "server.js");
		fs.mkdirSync(path.dirname(shim), { recursive: true });
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "// present\n");
		fs.writeFileSync(shim, `@"%~dp0\\..\\pkg\\bin\\server.js" %*`);
		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn((command: string) =>
				command === "where" ? `${shim}\r\n` : "",
			),
			spawn: vi.fn(() => {
				const proc = new MockChildProcess();
				queueMicrotask(() => {
					proc.exitCode = 1;
					proc.emit("exit", 1, null);
				});
				return proc;
			}),
		}));
		vi.doMock("../../../clients/installer/index.js", async (importActual) => ({
			...(await importActual<
				typeof import("../../../clients/installer/index.js")
			>()),
			ensureTool,
			findManagedToolBinary: vi.fn(async () => undefined),
		}));

		try {
			const { resolveAndLaunch } =
				await import("../../../clients/lsp/server.js");
			await expect(
				resolveAndLaunch(
					{
						candidates: ["server"],
						args: ["--stdio"],
						cwd: "C:\\project",
						managedToolId: "server",
					},
					true,
				),
			).rejects.toThrow(/exited immediately with code 1/);
			expect(ensureTool).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			setPlatform(originalPlatform);
		}
	});
});
