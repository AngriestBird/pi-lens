/**
 * #4532 gap 12 and gap 3b: the out-of-band look forwards the config files a
 * language server reads once, and Python `.pyi` stubs, as exact-URI
 * watched-files events.
 *
 * Recurrence (gap 12): a `pyrightconfig.json` with `extraPaths` created after
 * pyright answered left the importer's "could not be resolved" finding in
 * place for the server's life (20 polls over 11.9 s), because the look
 * forwarded only `.d.ts` files and no event ever named the config. Recurrence
 * (gap 3b): a `.pyi` stub added or edited outside pi was not a declaration
 * file to the look, so pyright kept the bytes of the stub it had read.
 *
 * The language server is the host boundary (a service double that records the
 * events the subscriber asks it to send); the real LSP routing of a config
 * name to its server is driven in `smoke-tools-born-after-start.test.ts`. The
 * detector, the publisher, the diagnostics-cache clock and the latency sink are
 * real.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import {
	type DiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	getLSPService,
	resetLSPService,
} from "../../clients/lsp/capabilities.js";
import {
	resetWorkspaceDiagnosticsCacheSession,
	workspaceFileCreatedAtFor,
} from "../../clients/lsp/workspace-diagnostics-session.js";
import { lookForOutOfBandChanges } from "../../clients/out-of-band-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";

let tmp: string;
let notified: Array<{ filePath: string; type: number }>;
let restarted: string[];
let runtime: RuntimeCoordinator;
const cleanups: Array<() => void> = [];

const cacheRefusedAt = () =>
	workspaceFileCreatedAtFor(
		() => true,
		() => true,
	);

function recordPublishes(): DiskChange[] {
	const seen: DiskChange[] = [];
	cleanups.push(
		subscribeDiskChange("4532-g12-observes-publish", (change) => {
			seen.push(change);
		}),
	);
	return seen;
}

/** One look after `change`, against the baseline the first look recorded. */
async function lookAfter(change: () => void): Promise<DiskChange[]> {
	await lookForOutOfBandChanges(tmp, "tool_result", runtime);
	change();
	const seen = recordPublishes();
	await lookForOutOfBandChanges(tmp, "tool_result", runtime);
	return seen;
}

beforeEach(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4532-g12-"));
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = tmp;
	resetDegradationLedger();
	resetWorkspaceDiagnosticsCacheSession(0);
	notified = [];
	restarted = [];
	await installLspServiceDouble({
		restartPrimaryClientsUnder: async (root: string) => {
			restarted.push(root);
			return [root];
		},
		notifyOutOfBandFileChanges: (
			events: ReadonlyArray<{ filePath: string; type: number }>,
		) => {
			notified.push(...events);
		},
	});
	getLSPService();
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	resetLSPService();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe.each(["pyrightconfig.json", "pyproject.toml"])(
	"a %s changed outside pi-lens",
	(name) => {
		const config = () => path.join(tmp, name);

		it("is forwarded as Created when born after the baseline look", async () => {
			const seen = await lookAfter(() => fs.writeFileSync(config(), "{}\n"));
			expect(seen).toHaveLength(1);
			expect(seen[0].sources).toEqual(["config"]);
			expect(seen[0].pathChanges).toEqual([
				{ filePath: config(), type: "created" },
			]);
			expect(notified).toEqual([{ filePath: config(), type: 1 }]);
			// A config changes the analysis of every file under its root.
			expect(seen[0].paths).toBe("unknown");
			expect(cacheRefusedAt()).toBe(seen[0].at);
			// A config is not an install: no server restarts for it.
			expect(restarted).toEqual([]);
		});

		it("is forwarded as Changed when edited and as Deleted when removed", async () => {
			fs.writeFileSync(config(), '{"a":1}\n');
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			fs.writeFileSync(config(), '{"a":22}\n');
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			fs.rmSync(config());
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			expect(notified).toEqual([
				{ filePath: config(), type: 2 },
				{ filePath: config(), type: 3 },
			]);
		});

		it("is only recorded, not forwarded, by the root's first look", async () => {
			fs.writeFileSync(config(), "{}\n");
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			expect(notified).toEqual([]);
		});
	},
);

describe("a file that is not on the closed config list", () => {
	// Recurrence: a gate that enumerates names it knows to be bad passes the
	// next spelling. Only the listed basenames, spelled exactly, are forwarded:
	// typescript-language-server was measured to pick up a late tsconfig.json by
	// itself, so it is not listed.
	it.each([
		"tsconfig.json",
		"jsconfig.json",
		"package.json",
		"setup.py",
		"PyProject.toml",
		"pyrightconfig.json.bak",
		"my-pyrightconfig.json",
	])("%s publishes nothing", async (name) => {
		const seen = await lookAfter(() =>
			fs.writeFileSync(path.join(tmp, name), "{}\n"),
		);
		expect(seen).toEqual([]);
		expect(notified).toEqual([]);
	});

	it("is not looked for below the root (the server hosts a root, not a tree)", async () => {
		fs.mkdirSync(path.join(tmp, "sub"));
		const seen = await lookAfter(() =>
			fs.writeFileSync(path.join(tmp, "sub", "pyrightconfig.json"), "{}\n"),
		);
		expect(seen).toEqual([]);
	});
});

describe("a Python stub (.pyi) changed outside pi-lens (#4532 gap 3b)", () => {
	const stub = () => path.join(tmp, "stubs", "dep.pyi");

	it("is forwarded as Created, Changed and Deleted like a .d.ts", async () => {
		fs.mkdirSync(path.dirname(stub()));
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		fs.writeFileSync(stub(), "VALUE: int\n");
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		fs.writeFileSync(stub(), "VALUE: int\nOTHER: str\n");
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		fs.rmSync(stub());
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		expect(notified).toEqual([
			{ filePath: stub(), type: 1 },
			{ filePath: stub(), type: 2 },
			{ filePath: stub(), type: 3 },
		]);
	});

	it("is not forwarded from an excluded directory (.venv stays unwalked)", async () => {
		fs.mkdirSync(path.join(tmp, ".venv", "lib"), { recursive: true });
		const seen = await lookAfter(() =>
			fs.writeFileSync(path.join(tmp, ".venv", "lib", "dep.pyi"), "X: int\n"),
		);
		expect(seen).toEqual([]);
	});

	it("does not forward an ordinary .py file", async () => {
		const seen = await lookAfter(() =>
			fs.writeFileSync(path.join(tmp, "mod.py"), "X = 1\n"),
		);
		expect(seen).toEqual([]);
	});
});

describe("an unlistable root keeps the config baseline", () => {
	// Recurrence guard for the baseline: reading an unlistable root as "no
	// config files" would publish every config as Created once it lists again.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"publishes no config change when the root lists again unchanged",
		async () => {
			fs.writeFileSync(path.join(tmp, "pyrightconfig.json"), "{}\n");
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			fs.chmodSync(tmp, 0o000);
			try {
				await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			} finally {
				fs.chmodSync(tmp, 0o755);
			}
			const seen = recordPublishes();
			await lookForOutOfBandChanges(tmp, "tool_result", runtime);
			expect(seen.flatMap((change) => change.sources)).not.toContain("config");
			expect(notified).toEqual([]);
		},
	);
});

describe("the look's record", () => {
	it("names the forwarded config files once per look", async () => {
		const saved = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			await lookAfter(() => {
				fs.writeFileSync(path.join(tmp, "pyrightconfig.json"), "{}\n");
				fs.writeFileSync(path.join(tmp, "pyproject.toml"), "\n");
			});
			await flushLatencyLog();
			const rows = fs
				.readFileSync(getLatencyLogPath(), "utf8")
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							phase?: string;
							filePath?: string;
							result?: string;
							metadata?: { configs?: string[] };
						},
				)
				.filter(
					(row) =>
						row.phase === "lsp_out_of_band_change" && row.filePath === tmp,
				);
			expect(rows).toHaveLength(1);
			expect(rows[0].result).toBe("config");
			expect(rows[0].metadata?.configs).toEqual([
				"created:pyrightconfig.json",
				"created:pyproject.toml",
			]);
		} finally {
			if (saved === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = saved;
		}
	});
});
