// flake-shape: service-double — LSPClientInfo is a spawned language-server process; the registry's capacity, lease and idle paths are driven by its liveness and busy answers, which a real server cannot be made to give on demand
// flake-shape: in-process-mock — createLSPClient wraps the language-server child process (JSON-RPC over stdio); the registry's spawn bookkeeping is the subject, the process is the boundary
/**
 * #4449: the extracted ClientRegistry (clients/lsp/client-registry.ts, #4374)
 * driven directly. Every other test reaches the registry through LSPService, so
 * a mutant in the registry survived unless that service path happened to assert
 * it. The Stryker per-test campaign of #4449 (run ids in the PR body) listed the
 * survivors this file pins; each test names the mutant class it keeps out.
 *
 * Real objects throughout: the registry class, its maps, the session-root
 * registry and the degradation ledger. The only fakes sit at the process
 * boundary: the LSP client (`createLSPClient`, a spawned language server) and
 * the server's `spawn()`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import type { LSPClientInfo } from "../../../clients/lsp/client.js";
import {
	ClientRegistry,
	type ClientGenerationHooks,
	type SpawnedServer,
} from "../../../clients/lsp/client-registry.js";
import type { LSPServerInfo } from "../../../clients/lsp/server.js";
import {
	registerSessionRoot,
	resetSessionRootsForTests,
} from "../../../clients/lsp/session-roots.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

process.env.PI_LENS_TEST_MODE = "1";

const createLSPClient = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

type FakeClient = LSPClientInfo & {
	shutdown: ReturnType<typeof vi.fn>;
	setBusy(busy: boolean): void;
	die(at?: number): void;
};

/** A language-server client: the process boundary, so a fake is allowed. */
function fakeClient(
	serverId: string,
	root: string,
	opts: { busy?: boolean } = {},
): FakeClient {
	let alive = true;
	let busy = opts.busy === true;
	let exitedAt: number | undefined;
	const client = {
		serverId,
		root,
		isAlive: () => alive,
		isBusy: () => busy,
		wasShutdownIntentional: () => false,
		getExitedAt: () => exitedAt,
		shutdown: vi.fn(async () => undefined),
		setBusy: (next: boolean) => {
			busy = next;
		},
		die: (at: number = Date.now()) => {
			exitedAt = at;
			alive = false;
		},
	};
	return client as unknown as FakeClient;
}

function server(id: string, extra: Partial<LSPServerInfo> = {}): LSPServerInfo {
	return {
		id,
		name: id,
		extensions: [".fake"],
		root: async () => process.cwd(),
		spawn: async () => undefined,
		...extra,
	} as unknown as LSPServerInfo;
}

/** Records the service-side hooks the registry calls, in order. */
function makeHooks() {
	const calls: string[] = [];
	const hooks: ClientGenerationHooks = {
		releaseNotifyWrite: (key) => calls.push(`releaseNotifyWrite:${key}`),
		forgetReadiness: (key) => calls.push(`forgetReadiness:${key}`),
		forgetNotifyBacklog: (key) => calls.push(`forgetNotifyBacklog:${key}`),
		clearStallDemotion: (key) => calls.push(`clearStallDemotion:${key}`),
		rearmFirstContact: (id) => calls.push(`rearmFirstContact:${id}`),
		noteDiagnosticsPublished: (id) => calls.push(`diagnostics:${id}`),
	};
	return { calls, hooks };
}

/** The registry's private surface the survivors live on. */
type Internals = {
	clientLeases: Map<string, number>;
	clientLastUsedAt: Map<string, number>;
	adoptedClientKeys: Set<string>;
	adoptedRootLastUsedAt: Map<string, number>;
	idleEvictionTimers: Map<string, ReturnType<typeof setTimeout>>;
	admitAdoptedRoot(root: string, filePath: string): boolean;
	makeCapacityForClient(key: string): Promise<boolean>;
};

const internals = (registry: ClientRegistry) =>
	registry as unknown as Internals;

const dirs: string[] = [];
function tempProject(prefix: string, withMarker = true): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `reg4449-${prefix}-`)),
	);
	if (withMarker) fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
	dirs.push(dir);
	return dir;
}

beforeEach(() => {
	resetSessionRootsForTests();
	resetDegradationLedger();
	createLSPClient.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	delete process.env.PI_LENS_LSP_CLIENT_CEILING;
	delete process.env.PI_LENS_LSP_IDLE_EVICT_MS;
	delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
	delete process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS;
	resetSessionRootsForTests();
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("ClientRegistry breaker cooldown (#4449)", () => {
	// Recurrence: `Date.now() + cooldownMs` flipped to `-`. The notify-stall
	// demotion would then open an already-expired window and the stalled client
	// respawned on the very next touch, which is the loop the demotion exists to
	// stop (#2356). No test read the stamp the cooldown wrote.
	it("coolDown stamps a window that ends cooldownMs from now", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const registry = new ClientRegistry(makeHooks().hooks);
		registry.coolDown("ts:/p", 30_000);
		expect(registry.broken.get("ts:/p")).toBe(1_030_000);
	});
});

describe("ClientRegistry.analysisRootModeForFile (#4449)", () => {
	// Recurrence: the first-match-wins loop and its classification strings had no
	// direct test, so `mode === "session"` flipped to a literal "", to `!==`, or the
	// `||` turned `&&` and the verdict silently became "none" (every in-session file
	// refused) or the first root's verdict (a foreign root's "adopted" shadowing the
	// real session root).
	it("returns session for a file in the session cwd even when an earlier registered root calls it adopted", () => {
		// Sibling projects under one parent; "aaa" sorts first, so the loop meets the
		// root that calls the file "adopted" before it meets the session root.
		const parent = tempProject("mode-parent", false);
		const foreignRoot = path.join(parent, "aaa-foreign");
		const session = path.join(parent, "zzz-session");
		for (const dir of [foreignRoot, session]) {
			fs.mkdirSync(path.join(dir, "src"), { recursive: true });
			fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
		}
		registerSessionRoot(foreignRoot);
		registerSessionRoot(session);
		const registry = new ClientRegistry(makeHooks().hooks, undefined, session);
		const file = path.join(session, "src", "a.ts");
		expect(registry.analysisRootModeForFile(file)).toBe("session");
	});

	it("returns adopted for a file in a foreign project, and none for a vendored path", () => {
		const session = tempProject("mode-session");
		const foreign = tempProject("mode-foreign");
		registerSessionRoot(session);
		const registry = new ClientRegistry(makeHooks().hooks, undefined, session);
		expect(registry.analysisRootModeForFile(path.join(foreign, "a.ts"))).toBe(
			"adopted",
		);
		// `none` must not be upgraded to `adopted` by the accumulator.
		expect(
			registry.analysisRootModeForFile(
				path.join(session, "node_modules", "dep", "index.js"),
			),
		).toBe("none");
	});
});

/** One key `ts:<normalized root>` for a project dir. */
const keyFor = (id: string, root: string) => `${id}:${normalizeMapKey(root)}`;

/** A registry holding one live, registered client for `id` at `root`. */
function registryWithClient(id: string, root: string) {
	const { hooks, calls } = makeHooks();
	const registry = new ClientRegistry(hooks);
	const info = server(id, {
		root: async () => root,
		idleEviction: "transparent",
	} as Partial<LSPServerInfo>);
	const client = fakeClient(id, root);
	const key = keyFor(id, root);
	registry.clients.set(key, client);
	const entry: SpawnedServer = { client, info };
	return { registry, hooks, calls, info, client, key, entry };
}

describe("ClientRegistry leases (#4449)", () => {
	// Recurrence: lease bookkeeping had no direct test. A mutant that counted
	// `- 1` instead of `+ 1`, or dropped the per-key increment, left leases at
	// zero or negative, so capacity and idle eviction (which skip leased keys)
	// would evict a client a caller had just selected and not yet used.
	it("counts one lease per acquisition and keeps the key until the last release", async () => {
		const root = tempProject("lease");
		const { registry, entry, key, info } = registryWithClient("ts", root);
		const file = path.join(root, "a.ts");

		expect(await registry.acquireClientLease(entry, file)).toBe(key);
		expect(await registry.acquireClientLease(entry, file)).toBe(key);
		expect(internals(registry).clientLeases.get(key)).toBe(2);

		registry.releaseClientLease(key, info);
		expect(internals(registry).clientLeases.get(key)).toBe(1);
		registry.releaseClientLease(key, info);
		expect(internals(registry).clientLeases.has(key)).toBe(false);
	});

	// Recurrence: the lease must bind to the CLIENT GENERATION that was selected.
	// A replaced or shut-down registry must not hand out a lease: a `false`ed or
	// `&&`-weakened guard let a caller pin a retired client (#3585 shape).
	it("refuses a lease for a replaced client, a missing key, and a destroyed registry", async () => {
		const root = tempProject("lease-refuse");
		const { registry, entry, key } = registryWithClient("ts", root);
		const file = path.join(root, "a.ts");

		registry.clients.set(key, fakeClient("ts", root)); // a replacement generation
		expect(await registry.acquireClientLease(entry, file)).toBeUndefined();
		expect(internals(registry).clientLeases.size).toBe(0);

		registry.clients.set(key, entry.client);
		registry.markDestroyed();
		expect(await registry.acquireClientLease(entry, file)).toBeUndefined();
		expect(internals(registry).clientLeases.size).toBe(0);
	});

	// Recurrence: the multi-client variant is all-or-nothing. `some` flipped to
	// `every`, or a dropped guard, leased the live clients and left the caller
	// holding a partial set whose members would never be released.
	it("leases a set all-or-nothing and counts every member", async () => {
		const rootA = tempProject("leases-a");
		const rootB = tempProject("leases-b");
		const a = registryWithClient("ts", rootA);
		const { registry } = a;
		const infoB = server("json", { root: async () => rootB });
		const clientB = fakeClient("json", rootB);
		const keyB = keyFor("json", rootB);
		registry.clients.set(keyB, clientB);
		const entries: SpawnedServer[] = [
			a.entry,
			{ client: clientB, info: infoB },
		];
		const file = path.join(rootA, "x.ts");

		const leased = await registry.acquireClientLeases(entries, file);
		expect(leased).toEqual([
			{ key: a.key, server: a.info },
			{ key: keyB, server: infoB },
		]);
		expect(internals(registry).clientLeases.get(a.key)).toBe(1);
		expect(internals(registry).clientLeases.get(keyB)).toBe(1);
		await registry.acquireClientLeases(entries, file);
		expect(internals(registry).clientLeases.get(keyB)).toBe(2);

		// One member replaced: nobody is leased, counts unchanged.
		registry.clients.set(keyB, fakeClient("json", rootB));
		expect(await registry.acquireClientLeases(entries, file)).toBeUndefined();
		expect(internals(registry).clientLeases.get(a.key)).toBe(2);

		// One member with no resolvable root: nobody is leased.
		const rootless = server("rootless", { root: async () => undefined });
		const none = await registry.acquireClientLeases(
			[a.entry, { client: fakeClient("rootless", rootA), info: rootless }],
			file,
		);
		expect(none).toBeUndefined();
		expect(internals(registry).clientLeases.get(a.key)).toBe(2);

		registry.clients.set(keyB, clientB);
		registry.markDestroyed();
		expect(await registry.acquireClientLeases(entries, file)).toBeUndefined();
		expect(internals(registry).clientLeases.get(a.key)).toBe(2);
	});

	// Recurrence: the LAST release hands the client back to the idle clock. If it
	// stopped stamping last-use or re-arming the timer, a client used only through
	// leases stayed resident forever (memory bound lost) or was evicted at once.
	it("stamps last use and re-arms idle eviction on the last release, only for a live registered client", () => {
		vi.useFakeTimers();
		vi.setSystemTime(5_000_000);
		const root = tempProject("lease-release");
		const { registry, key, info } = registryWithClient("ts", root);
		internals(registry).clientLeases.set(key, 1);

		registry.releaseClientLease(key, info);
		expect(internals(registry).clientLastUsedAt.get(key)).toBe(5_000_000);
		expect(internals(registry).idleEvictionTimers.has(key)).toBe(true);

		// A key whose client is gone is not stamped and gets no timer.
		const ghost = "ts:/ghost";
		internals(registry).clientLeases.set(ghost, 1);
		registry.releaseClientLease(ghost, info);
		expect(internals(registry).clientLastUsedAt.has(ghost)).toBe(false);
		expect(internals(registry).idleEvictionTimers.has(ghost)).toBe(false);
	});
});

describe("ClientRegistry.retireClient adopted-root bookkeeping (#4449)", () => {
	// Recurrence (#3585): retirement is the ONE place a generation's keyed state
	// is dropped. The adopted-root LRU entry is shared by every adopted client on
	// that root, so it may go only with the LAST of them; dropping it early hides a
	// live root from the cap, keeping it forever leaks a cap slot.
	it("drops the root's LRU entry only with the last adopted client on it", () => {
		const rootX = "/foreign/x";
		const { hooks, calls } = makeHooks();
		const registry = new ClientRegistry(hooks);
		const a = internals(registry);
		const tsKey = `ts:${rootX}`;
		const lintKey = `lint:${rootX}`;
		const otherKey = "ts:/foreign/y";
		for (const key of [tsKey, lintKey, otherKey]) {
			a.adoptedClientKeys.add(key);
			registry.clients.set(key, fakeClient("ts", "/x"));
			registry.clientSpawnedAt.set(key, 1);
			a.clientLastUsedAt.set(key, 1);
		}
		a.adoptedRootLastUsedAt.set(rootX, 1);
		a.adoptedRootLastUsedAt.set("/foreign/y", 1);

		registry.retireClient(tsKey);
		expect(a.adoptedClientKeys.has(tsKey)).toBe(false);
		expect(a.adoptedRootLastUsedAt.has(rootX)).toBe(true); // lintKey still there
		expect(registry.clients.has(tsKey)).toBe(false);
		expect(registry.clientSpawnedAt.has(tsKey)).toBe(false);
		expect(a.clientLastUsedAt.has(tsKey)).toBe(false);

		registry.retireClient(lintKey);
		expect(a.adoptedRootLastUsedAt.has(rootX)).toBe(false);
		expect(a.adoptedRootLastUsedAt.has("/foreign/y")).toBe(true);

		// The service-side hooks fire once per retirement, in the documented order.
		expect(calls.filter((c) => c.endsWith(tsKey))).toEqual([
			`releaseNotifyWrite:${tsKey}`,
			`forgetReadiness:${tsKey}`,
			`forgetNotifyBacklog:${tsKey}`,
		]);
	});

	// Recurrence: a non-adopted retirement must not touch the adopted LRU.
	it("leaves the adopted-root LRU alone when the retired client was not adopted", () => {
		const registry = new ClientRegistry(makeHooks().hooks);
		const a = internals(registry);
		a.adoptedRootLastUsedAt.set("/foreign/z", 1);
		registry.clients.set("ts:/foreign/z", fakeClient("ts", "/foreign/z"));
		registry.retireClient("ts:/foreign/z");
		expect(a.adoptedRootLastUsedAt.has("/foreign/z")).toBe(true);
	});

	// Recurrence: a retired key's pending idle timer fired later against the
	// replacement generation (#1332 follow-up). Retirement clears it.
	it("cancels the retired key's idle timer", () => {
		vi.useFakeTimers();
		const root = tempProject("retire-timer");
		const { registry, key, info } = registryWithClient("ts", root);
		registry.scheduleIdleEviction(key, info);
		expect(vi.getTimerCount()).toBe(1);
		registry.retireClient(key);
		expect(vi.getTimerCount()).toBe(0);
		expect(internals(registry).idleEvictionTimers.size).toBe(0);
	});
});

describe("ClientRegistry.admitAdoptedRoot (#4449)", () => {
	// Foreign projects (adopted roots) are admitted under a cap of 2 with LRU
	// eviction. The cap itself has a service-level test; the victim choice, the
	// lease guard and the eviction record had none.
	function adoptedFixture() {
		const parent = tempProject("adopt-parent", false);
		const session = path.join(parent, "zzz-session");
		fs.mkdirSync(session, { recursive: true });
		fs.writeFileSync(path.join(session, "package.json"), "{}\n");
		const roots = ["f1", "f2", "f3"].map((name) => {
			const dir = path.join(parent, `aaa-${name}`);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
			return dir;
		});
		registerSessionRoot(session);
		const { hooks, calls } = makeHooks();
		const registry = new ClientRegistry(hooks, undefined, session);
		const normalized = roots.map((r) => normalizeMapKey(r));
		const clients = new Map<string, FakeClient>();
		/** The ensureClientForServer order: mark adopted, admit, register on spawn. */
		const adopt = (index: number, register = true): boolean => {
			const key = `ts:${normalized[index]}`;
			internals(registry).adoptedClientKeys.add(key);
			const admitted = internals(registry).admitAdoptedRoot(
				roots[index],
				path.join(roots[index], "a.ts"),
			);
			if (register && admitted) {
				const client = fakeClient("ts", roots[index]);
				clients.set(key, client);
				registry.clients.set(key, client);
			}
			return admitted;
		};
		return { registry, calls, roots, normalized, clients, adopt, session };
	}

	const evictions = () =>
		getDegradationSummary().find((g) => g.kind === "lsp-adopted-root-evicted");

	// Recurrence: victim selection was an unpinned `sort` on last-use. Dropping the
	// sort, flipping its operator or weakening `?? 0` all evicted the OLDEST
	// INSERTED root instead of the least recently USED one, so a root re-touched a
	// second ago was torn down under its caller.
	it("evicts the least recently used root, retires its clients and records the eviction", () => {
		vi.useFakeTimers();
		const f = adoptedFixture();
		const root = (i: number) => f.normalized[i];
		vi.setSystemTime(1_000);
		f.adopt(0);
		vi.setSystemTime(2_000);
		f.adopt(1);
		vi.setSystemTime(3_000);
		expect(f.adopt(0)).toBe(true); // F1 touched again: now newer than F2
		expect(evictions()).toBeUndefined();

		vi.setSystemTime(4_000);
		expect(f.adopt(2)).toBe(true);

		const a = internals(f.registry);
		expect([...a.adoptedRootLastUsedAt.keys()].sort()).toEqual(
			[root(0), root(2)].sort(),
		);
		expect(a.adoptedRootLastUsedAt.get(root(2))).toBe(4_000);
		// F2 was the victim: its client is retired and shut down with the reason.
		expect(f.registry.clients.has(`ts:${root(1)}`)).toBe(false);
		expect(f.clients.get(`ts:${root(1)}`)?.shutdown).toHaveBeenCalledWith({
			reason: "adopted-root-lru",
		});
		expect(f.registry.clients.has(`ts:${root(0)}`)).toBe(true);
		expect(f.clients.get(`ts:${root(0)}`)?.shutdown).not.toHaveBeenCalled();
		expect(f.calls).toContain(`releaseNotifyWrite:ts:${root(1)}`);
		const record = evictions();
		expect(record?.count).toBe(1);
		expect(record?.latestReasons[0]).toEqual({
			subject: root(1),
			reason: `adopted root cap 2 evicted ${root(1)} (count: 1)`,
		});
	});

	// Recurrence: eviction must not tear down a client a caller holds a lease on
	// (#4257 F4 family), and must only touch ADOPTED clients on the victim root.
	it("skips leased clients and clients that are not adopted when it evicts a root", () => {
		vi.useFakeTimers();
		const f = adoptedFixture();
		vi.setSystemTime(1_000);
		f.adopt(0);
		vi.setSystemTime(2_000);
		f.adopt(1);
		const leasedKey = `ts:${f.normalized[0]}`;
		internals(f.registry).clientLeases.set(leasedKey, 1);
		// A second server on the victim root that is NOT adopted (a session client).
		const sessionKey = `eslint:${f.normalized[0]}`;
		const sessionClient = fakeClient("eslint", f.roots[0]);
		f.registry.clients.set(sessionKey, sessionClient);

		vi.setSystemTime(3_000);
		f.adopt(2);

		expect(f.registry.clients.has(leasedKey)).toBe(true);
		expect(f.clients.get(leasedKey)?.shutdown).not.toHaveBeenCalled();
		expect(f.registry.clients.has(sessionKey)).toBe(true);
		expect(sessionClient.shutdown).not.toHaveBeenCalled();
		// The root entry itself still left the LRU: the cap is about roots.
		expect(
			internals(f.registry).adoptedRootLastUsedAt.has(f.normalized[0]),
		).toBe(false);
	});

	// Recurrence: a clock step backwards (NTP) makes the root being admitted the
	// "oldest". The victim filter must still exclude it; without it the registry
	// evicted the root it was admitting and left the caller with no slot.
	it("never picks the root being admitted as the victim, even when the clock stepped back", () => {
		vi.useFakeTimers();
		const f = adoptedFixture();
		vi.setSystemTime(9_000);
		f.adopt(0);
		vi.setSystemTime(9_500);
		f.adopt(1);
		vi.setSystemTime(100); // clock stepped back before the entries above
		expect(f.adopt(2)).toBe(true);
		const keys = [...internals(f.registry).adoptedRootLastUsedAt.keys()];
		expect(keys).toContain(f.normalized[2]);
		expect(keys).toHaveLength(2);
		expect(f.registry.clients.has(`ts:${f.normalized[0]}`)).toBe(false);
	});

	// Recurrence: a root whose client never registered (spawn failed or pending)
	// held a cap slot forever, so two failed adoptions starved every later one.
	it("purges roots with no live adopted client before it counts the cap", () => {
		const f = adoptedFixture();
		expect(f.adopt(0, false)).toBe(true);
		expect(f.adopt(1, false)).toBe(true);
		expect(f.adopt(2, false)).toBe(true);
		expect([...internals(f.registry).adoptedRootLastUsedAt.keys()]).toEqual([
			f.normalized[2],
		]);
		expect(evictions()).toBeUndefined();

		// A live NON-adopted client on a stale root does not keep that entry alive.
		const a = internals(f.registry);
		a.adoptedRootLastUsedAt.set(f.normalized[0], 1);
		a.adoptedClientKeys.delete(`ts:${f.normalized[0]}`);
		f.registry.clients.set(
			`ts:${f.normalized[0]}`,
			fakeClient("ts", f.roots[0]),
		);
		expect(f.adopt(1, false)).toBe(true);
		expect(a.adoptedRootLastUsedAt.has(f.normalized[0])).toBe(false);
	});

	// Recurrence: re-admitting a LIVE root is a touch, not a new slot. A full map
	// plus a re-touch used to evict a different root.
	it("refreshes a live root's timestamp without evicting when it is admitted again", () => {
		vi.useFakeTimers();
		const f = adoptedFixture();
		vi.setSystemTime(1_000);
		f.adopt(0);
		vi.setSystemTime(2_000);
		f.adopt(1);
		vi.setSystemTime(7_000);
		expect(f.adopt(1)).toBe(true);
		const a = internals(f.registry);
		expect(a.adoptedRootLastUsedAt.get(f.normalized[1])).toBe(7_000);
		expect(a.adoptedRootLastUsedAt.size).toBe(2);
		expect(evictions()).toBeUndefined();
	});

	// Recurrence: the classifier is re-checked inside the admission, so a file the
	// session root owns can never be admitted as an adopted root.
	it("declines a file the session root owns", () => {
		const f = adoptedFixture();
		expect(
			internals(f.registry).admitAdoptedRoot(
				f.session,
				path.join(f.session, "a.ts"),
			),
		).toBe(false);
		expect(internals(f.registry).adoptedRootLastUsedAt.size).toBe(0);
	});
});

describe("ClientRegistry.makeCapacityForClient (#4449)", () => {
	function capacityRegistry(ceiling: number) {
		process.env.PI_LENS_LSP_CLIENT_CEILING = String(ceiling);
		const { hooks, calls } = makeHooks();
		return { registry: new ClientRegistry(hooks), calls };
	}
	const add = (
		registry: ClientRegistry,
		key: string,
		opts: { busy?: boolean; used?: number; spawned?: number } = {},
	) => {
		const client = fakeClient(key.split(":")[0], "/r", { busy: opts.busy });
		registry.clients.set(key, client);
		if (opts.used !== undefined)
			internals(registry).clientLastUsedAt.set(key, opts.used);
		if (opts.spawned !== undefined)
			registry.clientSpawnedAt.set(key, opts.spawned);
		return client;
	};

	// Recurrence: occupancy counted every entry in `clients`, dead ones too. A
	// crashed client awaiting respawn then consumed a slot, so a healthy new
	// spawn evicted a LIVE idle client to make room for nothing.
	it("does not count a dead client toward the ceiling", async () => {
		const { registry } = capacityRegistry(2);
		const alive = add(registry, "a:/1");
		const dead = add(registry, "b:/2");
		dead.die();
		await expect(
			internals(registry).makeCapacityForClient("c:/3"),
		).resolves.toBe(true);
		expect(alive.shutdown).not.toHaveBeenCalled();
		expect(registry.clients.has("a:/1")).toBe(true);
	});

	// Recurrence: the LRU key was `lastUsedAt ?? spawnedAt ?? 0`; a `&&`, a `+` or a
	// dropped fallback sorted by the wrong clock and evicted a recently used
	// client. Last use outranks spawn time; spawn time stands in for a client
	// never used; a client with neither is the oldest.
	it("evicts by last use, then spawn time, then nothing-known first", async () => {
		const { registry } = capacityRegistry(3);
		const spawnedOnly = add(registry, "a:/1", { spawned: 500 });
		const usedLater = add(registry, "b:/2", { used: 900, spawned: 50 });
		const unknown = add(registry, "c:/3");
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(true);
		expect(unknown.shutdown).toHaveBeenCalledTimes(1);
		expect(spawnedOnly.shutdown).not.toHaveBeenCalled();
		expect(usedLater.shutdown).not.toHaveBeenCalled();
		expect(registry.clients.has("c:/3")).toBe(false);

		// Now the spawn-time stand-in (500) against a real last use (900): spawn
		// time is the older clock, so `a` goes. A sort on spawn time alone would
		// pick `b` (50).
		process.env.PI_LENS_LSP_CLIENT_CEILING = "2";
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(true);
		expect(spawnedOnly.shutdown).toHaveBeenCalledTimes(1);
		expect(usedLater.shutdown).not.toHaveBeenCalled();
	});

	// Recurrence: the victim must be idle (not busy, not leased) and never the key
	// being spawned for (a dead client's own respawn). Each dropped condition
	// shut down a client mid-request or the very key the caller was reviving.
	it("declines instead of evicting a busy, leased or own-key client", async () => {
		const { registry } = capacityRegistry(1);
		const busy = add(registry, "a:/1", { busy: true });
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(false);
		expect(busy.shutdown).not.toHaveBeenCalled();

		busy.setBusy(false);
		internals(registry).clientLeases.set("a:/1", 1);
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(false);
		expect(busy.shutdown).not.toHaveBeenCalled();

		internals(registry).clientLeases.delete("a:/1");
		await expect(
			internals(registry).makeCapacityForClient("a:/1"),
		).resolves.toBe(false);
		expect(busy.shutdown).not.toHaveBeenCalled();
		expect(registry.clients.has("a:/1")).toBe(true);
	});

	// Recurrence (#1325/#3585): the victim's notify write is released BEFORE the
	// awaited shutdown (a waiter must not park on a client going down) and the
	// retirement runs after it, with the documented shutdown reason.
	it("releases the notify write before it awaits the victim's shutdown", async () => {
		const { registry, calls } = capacityRegistry(1);
		const victim = add(registry, "a:/1", { used: 1 });
		let seenDuringShutdown: string[] = [];
		victim.shutdown.mockImplementation(async () => {
			seenDuringShutdown = [...calls];
		});
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(true);
		expect(victim.shutdown).toHaveBeenCalledWith({
			reason: "client_ceiling_lru",
		});
		expect(seenDuringShutdown).toEqual(["releaseNotifyWrite:a:/1"]);
		expect(registry.clients.has("a:/1")).toBe(false);
	});

	// Recurrence: in-flight spawns occupy a slot too. Counting only live clients
	// let N concurrent first spawns each see room and exceed the ceiling.
	it("counts an in-flight spawn as occupying a slot", async () => {
		const { registry } = capacityRegistry(1);
		registry.inFlight.set("a:/1", new Promise(() => undefined));
		await expect(
			internals(registry).makeCapacityForClient("n:/n"),
		).resolves.toBe(false);
	});
});

describe("ClientRegistry.scheduleIdleEviction (#4449)", () => {
	const IDLE_MS = 1_000;
	function idleFixture(info?: Partial<LSPServerInfo>) {
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = String(IDLE_MS);
		vi.useFakeTimers();
		const { hooks, calls } = makeHooks();
		const registry = new ClientRegistry(hooks);
		const serverInfo = server("ts", {
			idleEviction: "transparent",
			...info,
		} as Partial<LSPServerInfo>);
		const client = fakeClient("ts", "/r");
		const key = "ts:/r";
		registry.clients.set(key, client);
		// Every production caller stamps last use before it arms the timer.
		internals(registry).clientLastUsedAt.set(key, Date.now());
		return { registry, client, key, serverInfo, calls };
	}
	const idleRecord = () =>
		getDegradationSummary().find((g) => g.kind === "lsp-idle-eviction");

	// Recurrence: the timer callback is the ONLY thing standing between an idle
	// language server and unbounded residency. It must retire synchronously, shut
	// down with the idle reason, forget its own timer entry and leave one record.
	it("retires, shuts down and records an idle client, and forgets its own timer", async () => {
		const f = idleFixture();
		f.registry.scheduleIdleEviction(f.key, f.serverInfo);
		expect(internals(f.registry).idleEvictionTimers.has(f.key)).toBe(true);

		await vi.advanceTimersByTimeAsync(IDLE_MS);

		expect(f.client.shutdown).toHaveBeenCalledWith({ reason: "idle_eviction" });
		expect(f.registry.clients.has(f.key)).toBe(false);
		expect(internals(f.registry).idleEvictionTimers.has(f.key)).toBe(false);
		expect(idleRecord()?.count).toBe(1);
		expect(idleRecord()?.latestReasons[0]).toEqual({
			subject: f.key,
			reason: "idle LSP client released to bound memory",
		});
	});

	// Recurrence: re-arming (every warm reuse does) left the previous timer
	// running, so each reuse added a timer and the first one evicted a client
	// that had just been used. One key, one timer.
	it("replaces the previous timer when it is re-armed", async () => {
		const f = idleFixture();
		f.registry.scheduleIdleEviction(f.key, f.serverInfo);
		await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
		f.registry.scheduleIdleEviction(f.key, f.serverInfo);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
		expect(f.client.shutdown).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
		expect(f.client.shutdown).toHaveBeenCalledTimes(1);
	});

	// Recurrence: the callback re-checks the world after the window. A destroyed
	// registry must not shut anything down again, and a client that died during
	// the window is not "released" (respawn owns it).
	it("does nothing when the registry was destroyed or the client already died", async () => {
		const destroyed = idleFixture();
		destroyed.registry.scheduleIdleEviction(
			destroyed.key,
			destroyed.serverInfo,
		);
		destroyed.registry.markDestroyed();
		await vi.advanceTimersByTimeAsync(IDLE_MS);
		expect(destroyed.client.shutdown).not.toHaveBeenCalled();
		expect(destroyed.registry.clients.has(destroyed.key)).toBe(true);

		const dead = idleFixture();
		dead.registry.scheduleIdleEviction(dead.key, dead.serverInfo);
		dead.client.die();
		await vi.advanceTimersByTimeAsync(IDLE_MS);
		expect(dead.client.shutdown).not.toHaveBeenCalled();
		expect(idleRecord()).toBeUndefined();
		// The fired timer's map entry is gone even though nothing was evicted.
		expect(internals(dead.registry).idleEvictionTimers.has(dead.key)).toBe(
			false,
		);
	});

	// Recurrence: only `transparent` servers are evicted on idle; every other
	// policy stays resident (#3645). Adopted roots are evicted regardless, on the
	// fixed adopted window rather than the configured one.
	it("arms no timer for a resident server and an adopted-window timer for an adopted key", async () => {
		const resident = idleFixture({ idleEviction: "resident" } as never);
		resident.registry.scheduleIdleEviction(resident.key, resident.serverInfo);
		expect(vi.getTimerCount()).toBe(0);

		const adopted = idleFixture({ idleEviction: "resident" } as never);
		internals(adopted.registry).adoptedClientKeys.add(adopted.key);
		adopted.registry.scheduleIdleEviction(adopted.key, adopted.serverInfo);
		await vi.advanceTimersByTimeAsync(IDLE_MS); // the configured window
		expect(adopted.client.shutdown).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000 - IDLE_MS);
		expect(adopted.client.shutdown).toHaveBeenCalledTimes(1);
	});
});

describe("ClientRegistry.resolveServerRoot (#4449)", () => {
	function rootServer(id: string, root: string | undefined): LSPServerInfo {
		return server(id, { root: async () => root });
	}
	const live = (root: string) =>
		({ root, isAlive: () => true }) as unknown as LSPClientInfo;

	// Recurrence: an adopted (foreign) project may only host a client at the root
	// the shared classifier picked (#4257). Dropping the equality, inverting it or
	// dropping the branch let a server-chosen nested directory become its own
	// client inside a foreign workspace.
	it("accepts an adopted root only when the server's root is the classifier's root", async () => {
		const parent = tempProject("res-adopt", false);
		const session = path.join(parent, "zzz-session");
		const foreign = path.join(parent, "aaa-foreign");
		const nested = path.join(foreign, "pkg");
		for (const dir of [session, foreign, nested]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(path.join(session, "package.json"), "{}\n");
		fs.writeFileSync(path.join(foreign, "package.json"), "{}\n");
		registerSessionRoot(session);
		const registry = new ClientRegistry(makeHooks().hooks, undefined, session);
		const file = path.join(nested, "a.ts");

		await expect(
			registry.resolveServerRoot(rootServer("ts", foreign), file),
		).resolves.toBe(foreign);
		await expect(
			registry.resolveServerRoot(rootServer("ts", nested), file),
		).resolves.toBeUndefined();
	});

	// Recurrence (#2052): a file outside every registered session root gets no
	// client, EXCEPT an adopted one (decided by the classifier, not the registry).
	// `mode !== "adopted"` flipped to `true` refused every adopted file once any
	// session root existed; flipped to a literal it admitted foreign junk.
	it("declines a file outside the session roots unless the classifier adopts it", async () => {
		const parent = tempProject("res-outside", false);
		const session = path.join(parent, "zzz-session");
		const foreign = path.join(parent, "aaa-foreign");
		const bare = path.join(parent, "bbb-bare");
		for (const dir of [session, foreign, bare]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(path.join(session, "package.json"), "{}\n");
		fs.writeFileSync(path.join(foreign, "package.json"), "{}\n");
		registerSessionRoot(session);
		const registry = new ClientRegistry(makeHooks().hooks, undefined, session);

		await expect(
			registry.resolveServerRoot(
				rootServer("ts", bare),
				path.join(bare, "a.ts"),
			),
		).resolves.toBeUndefined();
		await expect(
			registry.resolveServerRoot(
				rootServer("ts", foreign),
				path.join(foreign, "a.ts"),
			),
		).resolves.toBe(foreign);
	});

	// Recurrence (#1373): config-only nested roots join the NEAREST same-server
	// ancestor. The nearest is the longest ancestor key; `>` flipped to `<=` took
	// the farthest, dropping the `startsWith(prefix)` filter let ANOTHER server's
	// key win, and `true` took whichever key was iterated last.
	it("coalesces into the nearest ancestor of the same server only, whatever the key order", async () => {
		const project = tempProject("res-near", false);
		const mid = path.join(project, "mid");
		const leaf = path.join(mid, "deep", "leaf");
		fs.mkdirSync(leaf, { recursive: true });
		vi.spyOn(process, "cwd").mockReturnValue(project);
		const otherServer = `go:${normalizeMapKey(path.join(mid, "deep"))}`;
		const resolveWith = async (order: string[]) => {
			const registry = new ClientRegistry(makeHooks().hooks);
			for (const root of order) {
				registry.clients.set(keyFor("ts", root), live(root));
			}
			// A longer key of ANOTHER server (same prefix length: "go:" vs "ts:").
			registry.clients.set(otherServer, live(path.join(mid, "deep")));
			return registry.resolveServerRoot(
				rootServer("ts", leaf),
				path.join(leaf, "a.ts"),
			);
		};

		await expect(resolveWith([mid, project])).resolves.toBe(mid);
		await expect(resolveWith([project, mid])).resolves.toBe(mid);
	});

	// Recurrence (#1373): a root equal to the session cwd is returned as is, never
	// folded into a client hosted ABOVE the cwd.
	it("keeps a root equal to the cwd even when an ancestor hosts a client", async () => {
		const parent = tempProject("res-cwd", false);
		const cwd = path.join(parent, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		const registry = new ClientRegistry(makeHooks().hooks);
		registry.clients.set(keyFor("ts", parent), live(parent));

		await expect(
			registry.resolveServerRoot(rootServer("ts", cwd), path.join(cwd, "a.ts")),
		).resolves.toBe(cwd);
	});

	// Recurrence: an in-flight spawn is an ancestor too (no client yet), so the
	// answer falls back to the ancestor KEY. Reading `.root` off the missing
	// client threw a TypeError out of root resolution.
	it("falls back to the ancestor key when only a spawn is in flight there", async () => {
		const project = tempProject("res-flight", false);
		const nested = path.join(project, "nested");
		fs.mkdirSync(nested, { recursive: true });
		vi.spyOn(process, "cwd").mockReturnValue(project);
		const registry = new ClientRegistry(makeHooks().hooks);
		registry.inFlight.set(
			keyFor("ts", project),
			Promise.resolve<SpawnedServer | undefined>(undefined),
		);

		await expect(
			registry.resolveServerRoot(
				rootServer("ts", nested),
				path.join(nested, "a.ts"),
			),
		).resolves.toBe(normalizeMapKey(project));
	});

	// Recurrence: boundary verdicts are immutable per root and cached for the
	// service's life, negatives included, so a hot touch path does not re-stat the
	// markers on every call. Observed through the real probe: a manifest that
	// appears AFTER the first answer does not change the cached verdict, which a
	// dropped `set` or an always-recompute `if (!boundary)` would.
	it("keeps the first boundary verdict for a root for the registry's life", async () => {
		const project = tempProject("res-cache", false);
		const nested = path.join(project, "nested");
		fs.mkdirSync(nested, { recursive: true });
		vi.spyOn(process, "cwd").mockReturnValue(project);
		const registry = new ClientRegistry(makeHooks().hooks);
		registry.clients.set(keyFor("ts", project), live(project));
		const resolve = () =>
			registry.resolveServerRoot(
				rootServer("ts", nested),
				path.join(nested, "a.ts"),
			);

		await expect(resolve()).resolves.toBe(project); // no marker: coalesced
		fs.writeFileSync(path.join(nested, "package.json"), "{}\n");
		await expect(resolve()).resolves.toBe(project); // verdict is cached
		await expect(
			new ClientRegistry(makeHooks().hooks).resolveServerRoot(
				rootServer("ts", nested),
				path.join(nested, "a.ts"),
			),
		).resolves.toBe(nested); // control: a fresh registry sees the manifest
	});
});
