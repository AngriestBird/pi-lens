import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlatform } from "../../support/platform-stub.js";

const ensureTool = vi.hoisted(() => vi.fn(async () => undefined));
const logExtension = vi.hoisted(() => vi.fn());
// The global-bin fallback is the launcher's OTHER presence seam, and it sits at
// a process boundary (an npm-prefix probe), so it is the one a cell may drive
// to hand the launcher an absolute, present program (#4532 round 4).
const findGlobalBinary = vi.hoisted(() =>
	vi.fn(async () => undefined as string | undefined),
);

vi.mock("../../../clients/extension-log.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/extension-log.js")
	>()),
	logExtension,
}));

class MockChildProcess extends EventEmitter {
	stdin = new EventEmitter();
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	exitCode: number | null = null;
	killed = false;
}

/** A spawn double whose child exits with `code` on the first microtask. */
function exitWith(code: number): () => MockChildProcess {
	return () => {
		const proc = new MockChildProcess();
		queueMicrotask(() => {
			proc.exitCode = code;
			proc.emit("exit", code, null);
		});
		return proc;
	};
}

/**
 * An npm-shaped `.cmd` shim under `parent`, with the JS target it names written
 * to disk: `isCmdShimValid` reads that target, which is the presence evidence
 * the launcher holds after its own pre-spawn validation.
 */
function plantShim(parent: string): { shim: string; target: string } {
	const shim = path.join(parent, "bin", "server.cmd");
	const target = path.join(parent, "pkg", "bin", "server.js");
	fs.mkdirSync(path.dirname(shim), { recursive: true });
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, "// present\n");
	fs.writeFileSync(shim, `@"%~dp0\\..\\pkg\\bin\\server.js" %*`);
	return { shim, target };
}

describe("Windows LSP startup repair classification (#4263)", () => {
	afterEach(() => {
		setPlatform(process.platform);
		vi.resetModules();
		vi.doUnmock("node:child_process");
		vi.doUnmock("../../../clients/installer/index.js");
		vi.doUnmock("../../../clients/package-manager.js");
		vi.clearAllMocks();
		findGlobalBinary.mockReset();
		findGlobalBinary.mockResolvedValue(undefined);
	});

	it("repairs an absent bare command reported as exit-code 1", async () => {
		const originalPlatform = process.platform;
		setPlatform("win32");
		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn(() => ""),
			spawn: vi.fn(exitWith(1)),
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

	// #4532 round 4: presence comes from the launcher's OWN evidence, so this
	// cell hands it a present program through a seam that survives the removed
	// `where` probe — the global-bin fallback resolves the shim's absolute path,
	// and the shim's target exists on disk. An exit code 1 from that program is
	// a runtime failure, never a missing install.
	it("does not repair a present binary that exits with code 1", async () => {
		const originalPlatform = process.platform;
		setPlatform("win32");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4263-"));
		const { shim } = plantShim(path.join(root, "global"));
		const project = path.join(root, "project");
		fs.mkdirSync(project, { recursive: true });
		findGlobalBinary.mockResolvedValue(shim);
		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn(() => ""),
			spawn: vi.fn(exitWith(1)),
		}));
		vi.doMock("../../../clients/package-manager.js", async (importActual) => ({
			...(await importActual<
				typeof import("../../../clients/package-manager.js")
			>()),
			findGlobalBinary,
			isProjectLocalBinPath: vi.fn(() => false),
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
						cwd: project,
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

	// The global-bin fallback's other shape: a resolved path with no shim to
	// validate (`gopls.exe`, a managed archive binary). Presence here is the
	// fallback's own answer — it stats the file before returning it — so the
	// presence arm that reads "the launcher resolved something" is what keeps a
	// code-1 exit a runtime failure.
	it("does not repair a present binary the global fallback resolved without a shim", async () => {
		const originalPlatform = process.platform;
		setPlatform("win32");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4263-exe-"));
		const binary = path.join(root, "global", "bin", "gopls.exe");
		fs.mkdirSync(path.dirname(binary), { recursive: true });
		fs.writeFileSync(binary, "MZ\n");
		findGlobalBinary.mockResolvedValue(binary);
		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn(() => ""),
			spawn: vi.fn(exitWith(1)),
		}));
		vi.doMock("../../../clients/package-manager.js", async (importActual) => ({
			...(await importActual<
				typeof import("../../../clients/package-manager.js")
			>()),
			findGlobalBinary,
			isProjectLocalBinPath: vi.fn(() => false),
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
						candidates: ["gopls"],
						args: ["serve"],
						cwd: path.join(root, "project"),
						managedToolId: "gopls",
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

	// #4532 round 4, red on the pre-fix head: an ABSOLUTE command spelling of a
	// shim whose target is present. The pre-fix classifier re-resolved the
	// spelling after the spawn, and when that second reading could not see the
	// path it answered `tool-not-found` for a binary that was sitting on disk —
	// so `ensureTool` ran. Presence now comes from the launcher's own evidence
	// (the shim it validated before spawning), and the exit code stays a runtime
	// failure.
	it("does not repair a present shim named by an absolute command", async () => {
		const originalPlatform = process.platform;
		setPlatform("win32");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4263-abs-"));
		const { shim } = plantShim(path.join(root, "global"));
		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn(() => ""),
			spawn: vi.fn(exitWith(1)),
		}));
		vi.doMock("../../../clients/package-manager.js", async (importActual) => ({
			...(await importActual<
				typeof import("../../../clients/package-manager.js")
			>()),
			findGlobalBinary,
			isProjectLocalBinPath: vi.fn(() => false),
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
						candidates: [shim],
						args: ["--stdio"],
						cwd: path.join(root, "global"),
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

	it("refuses an unknown-trust local missing-target shim before repair", async () => {
		const originalPlatform = process.platform;
		setPlatform("win32");
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4264-"));
		const binDir = path.join(project, "node_modules", ".bin");
		const shim = path.join(binDir, "server.cmd");
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(shim, `@"%~dp0\\..\\server\\bin\\server.js" %*`);
		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn((command: string) =>
				command === "where" ? `${shim}\\r\\n` : "",
			),
			spawn: vi.fn(() => {
				throw new Error("spawn must not reach an untrusted local shim");
			}),
		}));
		vi.doMock("../../../clients/installer/index.js", async (importActual) => ({
			...(await importActual<
				typeof import("../../../clients/installer/index.js")
			>()),
			ensureTool,
			findManagedToolBinary: vi.fn(async () => undefined),
		}));
		vi.doMock("../../../clients/package-manager.js", async (importActual) => ({
			...(await importActual<
				typeof import("../../../clients/package-manager.js")
			>()),
			isProjectLocalBinPath: vi.fn(() => true),
		}));

		try {
			const { resolveAndLaunch } =
				await import("../../../clients/lsp/server.js");
			await expect(
				resolveAndLaunch(
					{
						candidates: ["server"],
						args: ["--stdio"],
						cwd: project,
						managedToolId: "server",
					},
					true,
				),
			).rejects.toThrow(/project-local binary refused/);
			expect(ensureTool).not.toHaveBeenCalled();
			expect(logExtension).toHaveBeenCalledWith(
				expect.objectContaining({
					message:
						"project-local LSP binary refused: mark the project trusted in pi or upgrade pi",
				}),
			);
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
			setPlatform(originalPlatform);
		}
	});
});
