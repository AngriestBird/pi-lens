/**
 * The ONE list of test files allowed to load the hand-built pi double
 * `tests/support/pi-mock.ts` (#4632, recurrence #4631: host semantics passed CI
 * on the double). Two readers, never two copies:
 *
 * - `pi-mock.ts` calls {@link piMockAdmission} at module load and throws for a
 *   test file that is not on the list. That is the gate: it sees the module
 *   that actually loads, so no import spelling (escape, fragment, alias,
 *   re-export through a support file) can route around it.
 * - `tests/config/pi-mock-importer-sweep.test.ts` scans source text only for
 *   the other direction: a row whose file stopped using the double is stale
 *   and must be deleted, so the list only shrinks.
 *
 * Keys are `tests/`-relative posix paths. A row's class is acceptance 7 of
 * #4632: `process-boundary`, `internal-seam` (the case interposes on a pi-lens
 * `clients/` module through `vi.mock`, which cannot reach the copy pi's loader
 * builds), `unproducible-payload`, or `double-subject`; `pending slice N`
 * marks a file a roadmap slice still owns, and slice 10 (the last) records the
 * final counts. Classes are the author's reading at 2026-10-20 and are checked
 * for vocabulary only; the SET of files is what the gate pins.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_MOCK_IMPORTERS: Readonly<Record<string, string>> = {
	// double-subject
	"support/pi-mock.test.ts": "double-subject",
	// internal-seam
	"clients/bootstrap-lazy-liveness.test.ts": "internal-seam",
	"clients/dispatch/lazy-liveness.test.ts": "internal-seam",
	"clients/formatters-lazy-liveness.test.ts": "internal-seam",
	"clients/lsp-lazy-liveness.test.ts": "internal-seam",
	"index-1892-govulncheck-lane-witness.test.ts": "internal-seam",
	"index-1892-scanner-freshness-witness.test.ts": "internal-seam",
	"index-1892-secrets-lane-witness.test.ts": "internal-seam",
	"index-2939-read-path-witness.test.ts": "internal-seam",
	"index-2939-tool-result-budget-witness.test.ts": "internal-seam",
	"index-3190-inline-blocker-deleted-path-witness.test.ts": "internal-seam",
	"index-3246-turn-end-delivery.test.ts": "internal-seam",
	"index-3290-actionable-warnings-witness.test.ts": "internal-seam",
	"index-3506-file-mutation-queue-wiring.test.ts": "internal-seam",
	"index-3620-sweep-scope-fence.test.ts": "internal-seam",
	"index-3748-advisory-scope-witness.test.ts": "internal-seam",
	"index-3814-deferred-blocker-gate.test.ts": "internal-seam",
	"index-3917-orphan-sweep-scope.test.ts": "internal-seam",
	"index-4483-first-write-seed-witness.test.ts": "internal-seam",
	"index-4484-unfixed-blocker-witness.test.ts": "internal-seam",
	"index-4504-opaque-prescan-root-witness.test.ts": "internal-seam",
	"index-drain-refresh-straddle.test.ts": "internal-seam",
	"index-integration.test.ts": "internal-seam",
	"index-loop-block-wiring.test.ts": "internal-seam",
	"index-lsp-idle-reset.test.ts": "internal-seam",
	"index-mode-awareness.test.ts": "internal-seam",
	"index-mutation-bridge-recordability.test.ts": "internal-seam",
	"index-mutation-latency-marker.test.ts": "internal-seam",
	"index-observed-sweep-no-read-guard.test.ts": "internal-seam",
	"index-project-trust-wiring.test.ts": "internal-seam",
	"index-read-bridge-zero-line.test.ts": "internal-seam",
	"index-smells-rollup-wiring.test.ts": "internal-seam",
	"index-vanished-instance-wiring.test.ts": "internal-seam",
	"index-wiring.test.ts": "internal-seam",
	"index-word-index-memo-settle.test.ts": "internal-seam",
	"index-write-order-token.test.ts": "internal-seam",
	// pending slice 10
	"clients/cascade-unanswered-primary-4403.test.ts": "pending slice 10",
	"config/result-contract-governance.test.ts": "pending slice 10",
	"index-process-bridge-rebind-real-factory.test.ts": "pending slice 10",
	"tools/diagnostics-route-switch-matrix.test.ts": "pending slice 10",
	// unproducible-payload
	"clients/context-append-to-last-user.test.ts": "unproducible-payload",
	"index-4631-pre-087-context-shape.test.ts": "unproducible-payload",
	// pending slice 5
	"index-4554-last-member-teardown.test.ts": "pending slice 5",
	"index-config-resolved-session-wiring.test.ts": "pending slice 5",
	"index-multi-root-session-start.test.ts": "pending slice 5",
	// pending slice 8
	"clients/session-event-guard.test.ts": "unproducible-payload",
	"index-cascade-resolved-clean-wiring.test.ts": "internal-seam",
	// pending slice 9
	"index-2992-integration.test.ts": "pending slice 9",
	"index-lsp-config-root-eviction.test.ts": "pending slice 9",
	"index-session-start-classification-wiring.test.ts": "pending slice 9",
	"lens-toggle-command.test.ts": "pending slice 9",
	// process-boundary
	"clients/handler-verdict-helper.test.ts": "process-boundary",
	"clients/ndjson-logger.test.ts": "process-boundary",
	"clients/pi-host-callable-schema-contract.test.ts": "process-boundary",
	"clients/pi-lens-home-hermeticity.test.ts": "process-boundary",
};

const TESTS_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

/**
 * `undefined` when the test file at `testPath` may load the double, else the
 * refusal text. Fails closed: an unreadable path (vitest reports none), a path
 * outside `tests/` (no key spells `..`, so the list lookup refuses it), a symlink that cannot be resolved, and a file not on the
 * list are all refused.
 */
export function piMockAdmission(testPath: unknown): string | undefined {
	const refuse = (why: string): string =>
		`tests/support/pi-mock.ts refuses to load: ${why}. A case whose verdict ` +
		"depends on what pi does with a handler's return value, what the model " +
		"receives, or how pi orders a session goes through tier 1 " +
		"(tests/support/pi-runner.ts, a real ExtensionRunner) or tier 2 " +
		"(tests/support/pi-session.ts, a real AgentSession); AGENTS.md " +
		"'Testing' says which. A genuine process-boundary subject, internal " +
		"seam or unproducible payload (#4632 acceptance 7) is added to " +
		"PI_MOCK_IMPORTERS in tests/support/pi-mock-importers.ts, with its class.";
	if (typeof testPath !== "string" || testPath === "") {
		return refuse(
			"vitest reported no test file path, so the importer cannot be checked",
		);
	}
	let relative: string;
	try {
		relative = path
			.relative(
				fs.realpathSync.native(TESTS_ROOT),
				fs.realpathSync.native(testPath),
			)
			.split(path.sep)
			.join("/");
	} catch {
		return refuse(`the test file path ${testPath} cannot be resolved`);
	}
	if (!Object.hasOwn(PI_MOCK_IMPORTERS, relative)) {
		return refuse(`${relative} is not on the importer list`);
	}
	return undefined;
}
