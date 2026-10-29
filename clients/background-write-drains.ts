/**
 * Process-wide registry of "settle my deferred writes" functions, one per
 * evaluation of a module that owns a module-scope deferred writer (#4937).
 *
 * WHY. pi loads the built extension through its own jiti loader with
 * `moduleCache: false`, so a tier-2 test process holds a second, private copy of
 * every `clients/` module: the extension's. A deferred writer in that copy (a
 * worker snapshot persist, a debounced cache flush) is invisible to the test
 * side's own `import`, and its write lands after the fixture root was removed,
 * re-creating it. Master run 40967488612 leaked
 * `pi-lens-pi-session-yB7mpc` that way. Each such module registers its drain
 * here when it loads; the harness joins every copy's drain before it removes
 * the root (`tests/support/pi-session.ts`).
 *
 * STATIC IMPORTS: none, deliberately: a dependency leaf, so any module with a
 * deferred writer can register without a cycle.
 *
 * STATE. Keyed on `globalThis` with `Symbol.for`, not on module scope (the
 * module is itself evaluated once per copy) and not in `process-singletons`
 * (its test reset would drop the registration of a copy that is already
 * loaded). Entries are weak: the registering module keeps its drain alive as an
 * exported function, so a collected copy drops out on its own.
 */

const REGISTRY_KEY = Symbol.for("pi-lens.background-write-drains.v1");

type Drain = () => Promise<unknown>;

const host = globalThis as typeof globalThis & { [key: symbol]: unknown };

function registry(): Set<WeakRef<Drain>> {
	const existing = host[REGISTRY_KEY];
	if (existing instanceof Set) return existing as Set<WeakRef<Drain>>;
	const fresh = new Set<WeakRef<Drain>>();
	host[REGISTRY_KEY] = fresh;
	return fresh;
}

/**
 * Register `drain` for this module evaluation. `drain` MUST be an exported
 * function of the registering module (or otherwise strongly held by it): the
 * registry holds it weakly, and a function nothing else references is
 * collected and silently never runs.
 */
export function registerBackgroundWriteDrain(drain: Drain): void {
	registry().add(new WeakRef(drain));
}

/**
 * Test-only: run every live registered drain, in registration order, and
 * return once all have settled. A drain that rejects rejects the pass: a
 * teardown that cannot settle a writer should fail its file loudly, not
 * remove the root under it.
 */
export async function drainRegisteredBackgroundWritesForTests(): Promise<void> {
	const refs = registry();
	for (const ref of refs) {
		const drain = ref.deref();
		if (drain === undefined) refs.delete(ref);
		else await drain();
	}
}
