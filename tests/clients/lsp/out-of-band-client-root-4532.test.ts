/**
 * #4532 half 1 / gap 7: the install look runs at the roots of the LIVE primary
 * clients, not only at the session's cwd.
 *
 * Recurrence it prevents: a pi session whose cwd was a main checkout edited a
 * file in a LINKED WORKTREE that had no `node_modules`. The `typescript` server
 * rooted at the worktree published seven `@types/node` gaps; the agent
 * symlinked another checkout's install into the worktree and `tsc` was clean,
 * and the server kept republishing the same seven codes for fourteen minutes.
 * The out-of-band install look (#4476) ran only at `opaquePrescanRoot(deps.cwd,
 * workspaceRoot)` — the session cwd — so no look ever read the worktree's
 * install stamp and no client restarted. The session log held zero
 * `lsp_out_of_band_change` rows.
 *
 * Real: `handleToolResult` (the bash branch pi actually runs), the real
 * out-of-band look, the real disk-change publisher and its two subscribers, the
 * real diagnostics-cache refusal clock, and the real degradation ledger.
 * Doubled only at the process boundary: the language-server service behind the
 * real `clients/lsp/capabilities.js` lifecycle seam, so nothing here spawns a
 * server and the restart is observed as the call production makes.
 *
 * A `ln -s` writes no project file, so the look is keyed on the live client
 * ROOTS, not on the command's written set — that is the cell "a symlink alone
 * restarts the worktree's client". The first look at a root is the other half:
 * it may only publish an install that appeared AFTER that root's client
 * spawned, which is what the `since` epoch decides.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	getLSPService,
	resetLSPService,
} from "../../../clients/lsp/capabilities.js";
import { configureLspServiceLifecycle } from "../../../clients/lsp/service-singleton.js";
import { workspaceFileCreatedAtFor } from "../../../clients/lsp/workspace-diagnostics-session.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../../clients/runtime-tool-result.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { setupTestEnvironment } from "../test-utils.js";

let env: { tmpDir: string; cleanup: () => void };
let main: string;
let worktree: string;
let runtime: RuntimeCoordinator;
let restarts: string[];
let clientRoots: Array<{ root: string; spawnedAt: number }>;

function installService(): void {
	resetLSPService();
	const service = makeLspServiceDouble({
		livePrimaryClientRoots: () => clientRoots,
		restartPrimaryClientsUnder: async (root: string) => {
			restarts.push(normalizeMapKey(root));
			return 1;
		},
		getOpenDocumentPaths: () => [],
	});
	configureLspServiceLifecycle<Record<string, unknown>>({
		create: () => service as Record<string, unknown>,
		beforeReset: () => undefined,
		destroy: async () => undefined,
	});
	getLSPService();
}

/** One bash `tool_result`, the shape pi delivers for a finished command. */
async function bashResult(command: string): Promise<void> {
	const deps = {
		event: {
			toolName: "bash",
			toolCallId: `4532-${Math.random().toString(36).slice(2)}`,
			input: { command },
			content: [{ type: "text", text: "ok" }],
		},
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cwd: main,
		cacheManager: new CacheManager(false),
		biomeClient: {},
		ruffClient: {},
		testRunnerClient: {},
		metricsClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
		sessionId: "pi-lens-4532-client-root",
	} as unknown as Parameters<typeof handleToolResult>[0];
	await handleToolResult(deps);
}

/** The deferred engine's install markers, as a real checkout carries them. */
function plantInstall(root: string): void {
	fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "node_modules", "dep", "index.d.ts"),
		"export type Dep = number;\n",
	);
	fs.writeFileSync(
		path.join(root, "node_modules", ".package-lock.json"),
		"{}\n",
	);
}

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-4532-client-root-");
	main = path.join(env.tmpDir, "main-checkout");
	worktree = path.join(env.tmpDir, "linked-worktree");
	fs.mkdirSync(path.join(main, "src"), { recursive: true });
	fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
	fs.writeFileSync(path.join(main, "package.json"), "{}\n");
	fs.writeFileSync(path.join(worktree, "package.json"), "{}\n");
	fs.writeFileSync(
		path.join(worktree, "src", "admission-limiter.ts"),
		'import { randomUUID } from "node:crypto";\nexport const x = randomUUID();\n',
	);
	plantInstall(main);
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = main;
	runtime.setTelemetryIdentity({ sessionId: "pi-lens-4532-client-root" });
	runtime.beginTurn();
	restarts = [];
	clientRoots = [];
	resetDegradationLedger();
});

afterEach(() => {
	resetLSPService();
	env.cleanup();
});

describe("the install look at a live client root (#4532 gap 7)", () => {
	it("restarts the worktree's client when node_modules is symlinked in after it spawned", async () => {
		// The server is already rooted at the worktree and spawned BEFORE the
		// install: exactly the reported order.
		const spawnedAt = Date.now();
		clientRoots = [{ root: worktree, spawnedAt }];
		installService();
		fs.symlinkSync(
			path.join(main, "node_modules"),
			path.join(worktree, "node_modules"),
		);

		// The command that made the install ran; a `ln -s` writes no project file.
		await bashResult("ln -s ../main-checkout/node_modules node_modules");

		// The look at the CLIENT root published the install and restarted that
		// root's primary client. Pre-fix this array was empty: the only look ran
		// at the session cwd (`main`), whose stamp never changed.
		expect(restarts).toContain(normalizeMapKey(worktree));
		// …and the diagnostics cache refuses every entry scanned before the
		// install, which is what makes the next read miss the stale finding.
		expect(
			workspaceFileCreatedAtFor(
				() => true,
				() => true,
			),
		).toBeGreaterThan(0);
	});

	it("publishes nothing on a first look at a root whose install predates its client", async () => {
		// A lockfile the package manager wrote BEFORE the server spawned: the
		// client already read it, so a restart would be pure churn.
		const lockfile = path.join(worktree, "package-lock.json");
		fs.writeFileSync(lockfile, "{}\n");
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(lockfile, old, old);
		clientRoots = [{ root: worktree, spawnedAt: Date.now() }];
		installService();

		await bashResult("true");

		expect(restarts).not.toContain(normalizeMapKey(worktree));
	});

	it("restarts only the root whose install changed, never an unrelated one", async () => {
		// The unrelated root's own install predates its client, so its first look
		// must record it and change nothing: only `main`'s install is fresh.
		const other = path.join(env.tmpDir, "other-project");
		plantInstall(other);
		const old = new Date(Date.now() - 60_000);
		for (const marker of ["node_modules/.package-lock.json"]) {
			const target = path.join(other, marker);
			fs.utimesSync(target, old, old);
		}
		clientRoots = [
			{ root: worktree, spawnedAt: Date.now() },
			{ root: other, spawnedAt: Date.now() },
		];
		installService();
		const mainLock = path.join(main, "package-lock.json");
		fs.writeFileSync(mainLock, '{"lockfileVersion":3}\n');

		// First look records every root and changes nothing.
		await bashResult("true");
		expect(restarts).toEqual([]);

		// An install at the SESSION root only.
		fs.writeFileSync(mainLock, '{"lockfileVersion":3,"packages":{}}\n');
		await bashResult("true");

		expect(restarts).toEqual([normalizeMapKey(main)]);
		expect(restarts).not.toContain(normalizeMapKey(worktree));
		expect(restarts).not.toContain(
			normalizeMapKey(path.join(env.tmpDir, "other-project")),
		);
	});

	it("records the client-root look cap instead of silently skipping the rest", async () => {
		clientRoots = Array.from({ length: 6 }, (_, index) => ({
			root: path.join(env.tmpDir, `project-${index}`),
			spawnedAt: Date.now(),
		}));
		for (const entry of clientRoots)
			fs.mkdirSync(path.join(entry.root, "src"), { recursive: true });
		installService();

		await bashResult("true");

		const capped = getDegradationSummary().filter(
			(group) => group.kind === "lsp-client-root-look-capped",
		);
		expect(capped).toHaveLength(1);
		expect(capped[0].count).toBe(1);
	});
});
