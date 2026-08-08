/**
 * Detach a best-effort, fire-and-forget child process from the event loop
 * (shape 4 of the recurring-defect catalog in AGENTS.md: "a timer / promise /
 * worker / child that outlives its one-shot settle"). Extracted from the
 * orphan reaper's `unrefReaperChild` (#1153/#1160) into a shared, dependency-
 * free module so every one-shot `spawn(..., { stdio: ["ignore","pipe",...] })`
 * call site in the codebase — the reaper's enumeration/kill spawns AND the
 * resource sampler's Windows CIM/powershell spawns (#1155) — uses the exact
 * same unref shape instead of re-deriving it.
 *
 * A piped, `data`-listener-attached stdout/stderr/stdin stream keeps the libuv
 * loop REFERENCED even after `child.unref()` — the child handle and every
 * live stdio stream must all be unref'd, or a settled one-shot process (e.g.
 * `pi --print`) cannot exit until the child `close`s. Unref only means "do
 * not keep the process alive FOR this best-effort work": in an interactive/
 * long-lived session the loop stays referenced for other reasons, so the
 * child's `data`/`close` events still fire normally and callers still collect
 * output/usage; only a genuinely-settled one-shot is allowed to exit without
 * waiting for it. Never throws.
 *
 * Deliberately has NO imports beyond the `ChildProcess` type, so both
 * `clients/instance-reaper.ts` and `clients/resource-sampler.ts` (which
 * `clients/safe-spawn.ts` itself depends on) can import this without risking
 * a circular-import chain.
 */

import type { ChildProcess } from "node:child_process";

export function unrefChildAndPipes(child: ChildProcess): void {
	try {
		child.unref();
		// Child stdio pipes are `net.Socket`s at runtime (which expose `unref`),
		// but are typed as `Readable`/`Writable` (which do not) — cast to the
		// optional-`unref` shape and guard, so an un-piped ("ignore") stream is a
		// no-op rather than a crash.
		for (const stream of [child.stdout, child.stderr, child.stdin]) {
			(stream as { unref?: () => void } | null)?.unref?.();
		}
	} catch {
		// best-effort — unref must never throw out of a fire-and-forget spawn
	}
}
