/**
 * #4596 — every `catch` handler in the shipped trees either publishes a
 * record for the failure it swallows or states, in a comment, why it needs
 * none.
 *
 * ## The recurrence this guards
 *
 * AGENTS.md shape 31 ("pull-only observability"). The 2026-10-18 audit of 53
 * merged `fix` PRs found four live instances of the same shape shipped in one
 * week: `clients/out-of-band-changes.ts`'s `catch { continue; }` published
 * `deleted: 1` for a file that still existed, `clients/lsp/implicit-scope.ts`'s
 * `catch { return "unknown" }` graded an unreadable module with no row at all,
 * `index.ts`'s `.catch(() => {})` dropped a failed root deregistration, and
 * `clients/lsp/index.ts`'s `.catch(() => {})` left `lsp_touch_file` reporting
 * `failureKind: "success"` for a rejected `didSave`. Each PR's `Observability`
 * section was present and each said the arm was covered. Nothing could have
 * told a reviewer that adding the next silent `catch` was a defect, and no
 * detector saw the population: the tree has row-shaped sweeps for stream
 * handlers, socket listeners and worker messages, and none for `catch`.
 *
 * ## The rule (tests/support/silent-catch-scan.ts)
 *
 * A `catch` clause of a `try`, and a `.catch(…)` handler, is `recorded` when
 * it calls a record seam (`record…`, `log…`, `increment…` — the repo's
 * logger convention), `rethrows` when it throws on every path, `declared-none`
 * when a comment inside it carries `none: <reason>`, `silent` otherwise, and
 * `unclassified` (a hard failure, never a skip) when a `.catch` handler is not
 * a form the scan can follow. The detector's own state table, one named case
 * per row, is `tests/support/silent-catch-scan.test.ts`.
 *
 * ## The baseline
 *
 * The population this rule finds today predates it: 1,146 handlers across 245
 * files swallow by design or by history, and rewriting them is not this
 * change. Each file's silent count is pinned with the reason it is admitted,
 * so a NEW silent handler in an already-listed file reds the count, a silent
 * handler in a new file reds as unlisted, and converting one to a record (or a
 * `none:` line) reds as stale until the row is re-pinned.
 *
 * `PRE_RULE` is the one honest admission for a file this change did not read
 * handler by handler: it says the count may not grow and claims nothing about
 * each handler. The four rows with their own text are files where a reader
 * knows better than the class. The registry only shrinks — this change deleted
 * `clients/lsp/implicit-scope.ts`'s row entirely (five records added), took one
 * from `index.ts` and one from `clients/out-of-band-changes.ts`, which also
 * turned one into a `none:` line — and `PINNED_TOTAL` moves only downward.
 *
 * Re-pin from this file's own census: `PI_LENS_PRINT_PINS=1` on this suite
 * prints the rows to paste, with each file's silent line numbers as a comment.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
} from "../support/sweep-kit.js";
import {
	type CatchSite,
	scanSilentCatches,
} from "../support/silent-catch-scan.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The trees the shipped runtime lives in, as #4596 scopes it. */
const SHIPPED_TREES = ["clients", "mcp", "tools"];

interface Admission {
	/** How many silent handlers this file is admitted to hold. */
	silent: number;
	/** Why those handlers need no record. */
	reason: string;
}

/**
 * The admission for a file this change did not read handler by handler: the
 * count is pinned and may not grow, and the row claims nothing more.
 */
const PRE_RULE =
	"pre-#4596 population admitted at its pinned count; it may not grow, a shrink re-pins it, and this row makes no claim that each handler is harmless";

const SHARP_INSTALL_STAMP =
	"the install-stamp reads: an unreadable lockfile or a root that cannot be listed answers `-`, which the stamp reader takes as no install change; the walk's own unreadable subtree IS recorded (`lsp-declaration-walk-unreadable`), and the listing-to-stat race carries a `none:` line";

const SHARP_DID_SAVE =
	"the swallowed `didSave` in `saveDebouncedPush` (#4527) belongs to the open save-failure change (#4532), which deletes that site; that round re-pins this row";

const SHARP_PRESCAN =
	"owned by the open prescan change (#4504); that round re-pins this row";

const SHARP_HOST =
	"the host adapter's best-effort shutdown and teardown arms; the one this change fixed (`deregisterInstanceRoot`'s `.catch`) now records through `recordRootDeregistrationFailure`";

/**
 * The population on master at #4596's base commit (`c44d201`), one row per
 * file, as the pinned census: 1,146 silent handlers in 245 files. Shrink only.
 */
const BASELINE: Readonly<Record<string, Admission>> = {
	"clients/actionable-warnings.ts": { silent: 6, reason: PRE_RULE },
	"clients/advisory-provenance.ts": { silent: 4, reason: PRE_RULE },
	"clients/agent-nudge.ts": { silent: 3, reason: PRE_RULE },
	"clients/analysis-root.ts": { silent: 2, reason: PRE_RULE },
	"clients/ast-grep-client.ts": { silent: 5, reason: PRE_RULE },
	"clients/ast-grep-rule-manager.ts": { silent: 3, reason: PRE_RULE },
	"clients/atomic-write-staging.ts": { silent: 4, reason: PRE_RULE },
	"clients/atomic-write.ts": { silent: 2, reason: PRE_RULE },
	"clients/bash-file-access.ts": { silent: 3, reason: PRE_RULE },
	"clients/biome-client.ts": { silent: 1, reason: PRE_RULE },
	"clients/blocker-freshness.ts": { silent: 13, reason: PRE_RULE },
	"clients/blocker-past-eof.ts": { silent: 2, reason: PRE_RULE },
	"clients/bootstrap.ts": { silent: 4, reason: PRE_RULE },
	"clients/bounded-pid-file-lock.ts": { silent: 14, reason: PRE_RULE },
	"clients/bounded-telemetry.ts": { silent: 2, reason: PRE_RULE },
	"clients/build-identity.ts": { silent: 2, reason: PRE_RULE },
	"clients/bundled-resource-health.ts": { silent: 1, reason: PRE_RULE },
	"clients/bus-publish.ts": { silent: 1, reason: PRE_RULE },
	"clients/cache-manager.ts": { silent: 6, reason: PRE_RULE },
	"clients/cache-observability.ts": { silent: 10, reason: PRE_RULE },
	"clients/cache/rule-cache.ts": { silent: 5, reason: PRE_RULE },
	"clients/call-graph.ts": { silent: 2, reason: PRE_RULE },
	"clients/cargo-manifest.ts": { silent: 1, reason: PRE_RULE },
	"clients/child-unref.ts": { silent: 4, reason: PRE_RULE },
	"clients/code-quality-warnings.ts": { silent: 1, reason: PRE_RULE },
	"clients/codebase-model.ts": { silent: 2, reason: PRE_RULE },
	"clients/collateral-test-role.ts": { silent: 1, reason: PRE_RULE },
	"clients/complexity-client.ts": { silent: 2, reason: PRE_RULE },
	"clients/config-core/normalize.ts": { silent: 1, reason: PRE_RULE },
	"clients/config-core/resolve.ts": { silent: 2, reason: PRE_RULE },
	"clients/config-core/schema.ts": { silent: 1, reason: PRE_RULE },
	"clients/config-locations.ts": { silent: 2, reason: PRE_RULE },
	"clients/config-resolve.ts": { silent: 2, reason: PRE_RULE },
	"clients/dead-code-client.ts": { silent: 2, reason: PRE_RULE },
	"clients/deadline-utils.ts": { silent: 4, reason: PRE_RULE },
	"clients/debug-handles.ts": { silent: 1, reason: PRE_RULE },
	"clients/debug-heap.ts": { silent: 5, reason: PRE_RULE },
	"clients/deferred-runner-blockers.ts": { silent: 1, reason: PRE_RULE },
	"clients/degradation-ledger.ts": { silent: 4, reason: PRE_RULE },
	"clients/dependency-checker.ts": { silent: 3, reason: PRE_RULE },
	"clients/deps/ast-grep-napi.ts": { silent: 2, reason: PRE_RULE },
	"clients/deps/web-tree-sitter.ts": { silent: 1, reason: PRE_RULE },
	"clients/diagnostic-dispositions.ts": { silent: 5, reason: PRE_RULE },
	"clients/diagnostic-line-freshness.ts": { silent: 5, reason: PRE_RULE },
	"clients/dispatch/dispatcher.ts": { silent: 7, reason: PRE_RULE },
	"clients/dispatch/facts/file-content.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/integration.ts": { silent: 7, reason: PRE_RULE },
	"clients/dispatch/pending-runner-findings.ts": {
		silent: 1,
		reason: PRE_RULE,
	},
	"clients/dispatch/rule-id-normalize.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/actionlint.ts": { silent: 2, reason: PRE_RULE },
	"clients/dispatch/runners/ast-grep-napi.ts": { silent: 8, reason: PRE_RULE },
	"clients/dispatch/runners/biome-check.ts": { silent: 2, reason: PRE_RULE },
	"clients/dispatch/runners/cpp-check.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/credo.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/cue-vet.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/eslint.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/golangci-lint.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/hadolint.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/helm-render.ts": { silent: 6, reason: PRE_RULE },
	"clients/dispatch/runners/ktlint.ts": { silent: 2, reason: PRE_RULE },
	"clients/dispatch/runners/lsp.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/oxlint.ts": { silent: 2, reason: PRE_RULE },
	"clients/dispatch/runners/phpstan.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/psscriptanalyzer.ts": {
		silent: 2,
		reason: PRE_RULE,
	},
	"clients/dispatch/runners/rubocop.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/ruff.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/rust-clippy.ts": { silent: 2, reason: PRE_RULE },
	"clients/dispatch/runners/shellcheck.ts": { silent: 2, reason: PRE_RULE },
	"clients/dispatch/runners/spellcheck.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/spotbugs.ts": { silent: 4, reason: PRE_RULE },
	"clients/dispatch/runners/sqlfluff.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/stylelint.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/swiftlint.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/terragrunt.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/tflint.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/tree-sitter.ts": { silent: 2, reason: PRE_RULE },
	"clients/dispatch/runners/trivy-config.ts": { silent: 2, reason: PRE_RULE },
	"clients/dispatch/runners/utils.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/utils/candidate-probe.ts": {
		silent: 1,
		reason: PRE_RULE,
	},
	"clients/dispatch/runners/utils/lazy-installer.ts": {
		silent: 1,
		reason: PRE_RULE,
	},
	"clients/dispatch/runners/utils/runner-helpers.ts": {
		silent: 7,
		reason: PRE_RULE,
	},
	"clients/dispatch/runners/vale.ts": { silent: 1, reason: PRE_RULE },
	"clients/dispatch/runners/yaml-rule-parser.ts": {
		silent: 5,
		reason: PRE_RULE,
	},
	"clients/durable-store.ts": { silent: 2, reason: PRE_RULE },
	"clients/ephemeral-root.ts": { silent: 1, reason: PRE_RULE },
	"clients/event-loop-hold.ts": { silent: 2, reason: PRE_RULE },
	"clients/extension-log.ts": { silent: 3, reason: PRE_RULE },
	"clients/extension-mode.ts": { silent: 1, reason: PRE_RULE },
	"clients/file-mutation-queue.ts": { silent: 3, reason: PRE_RULE },
	"clients/file-time.ts": { silent: 1, reason: PRE_RULE },
	"clients/file-utils.ts": { silent: 11, reason: PRE_RULE },
	"clients/fix-run-restore.ts": { silent: 10, reason: PRE_RULE },
	"clients/fix-worklog.ts": { silent: 3, reason: PRE_RULE },
	"clients/format-service.ts": { silent: 1, reason: PRE_RULE },
	"clients/formatters.ts": { silent: 6, reason: PRE_RULE },
	"clients/generated-artifacts.ts": { silent: 3, reason: PRE_RULE },
	"clients/generation-lock.ts": { silent: 10, reason: PRE_RULE },
	"clients/git-guard.ts": { silent: 3, reason: PRE_RULE },
	"clients/git-tracked-ignore.ts": { silent: 2, reason: PRE_RULE },
	"clients/gitleaks-client.ts": { silent: 9, reason: PRE_RULE },
	"clients/govulncheck-client.ts": { silent: 5, reason: PRE_RULE },
	"clients/grammar-source.ts": { silent: 5, reason: PRE_RULE },
	"clients/gzip-stage-write.ts": { silent: 4, reason: PRE_RULE },
	"clients/hashline-anchor.ts": { silent: 2, reason: PRE_RULE },
	"clients/inline-blocker-dispositions.ts": { silent: 1, reason: PRE_RULE },
	"clients/install-diagnostics.ts": { silent: 2, reason: PRE_RULE },
	"clients/installer/index.ts": { silent: 55, reason: PRE_RULE },
	"clients/installer/managed-tool-refresh.ts": { silent: 4, reason: PRE_RULE },
	"clients/instance-reaper.ts": { silent: 18, reason: PRE_RULE },
	"clients/instance-registry-lock.ts": { silent: 3, reason: PRE_RULE },
	"clients/instance-registry-tail.ts": { silent: 1, reason: PRE_RULE },
	"clients/instance-registry.ts": { silent: 3, reason: PRE_RULE },
	"clients/io-bridge.ts": { silent: 5, reason: PRE_RULE },
	"clients/jscpd-client.ts": { silent: 5, reason: PRE_RULE },
	"clients/json-cache-read.ts": { silent: 4, reason: PRE_RULE },
	"clients/knip-client.ts": { silent: 8, reason: PRE_RULE },
	"clients/language-profile.ts": { silent: 2, reason: PRE_RULE },
	"clients/ledger-bounds.ts": { silent: 1, reason: PRE_RULE },
	"clients/lens-config.ts": { silent: 1, reason: PRE_RULE },
	"clients/log-cleanup.ts": { silent: 6, reason: PRE_RULE },
	"clients/lsp-budget.ts": { silent: 1, reason: PRE_RULE },
	"clients/lsp-document-symbols.ts": { silent: 1, reason: PRE_RULE },
	"clients/lsp-mutation.ts": { silent: 3, reason: PRE_RULE },
	"clients/lsp/aggregation.ts": { silent: 1, reason: PRE_RULE },
	"clients/lsp/cascade-tier.ts": { silent: 1, reason: PRE_RULE },
	"clients/lsp/client-registry.ts": { silent: 8, reason: PRE_RULE },
	"clients/lsp/client.ts": { silent: 30, reason: PRE_RULE },
	"clients/lsp/config.ts": { silent: 1, reason: PRE_RULE },
	"clients/lsp/created-import-targets.ts": { silent: 2, reason: PRE_RULE },
	"clients/lsp/diagnostic-binding.ts": { silent: 2, reason: PRE_RULE },
	"clients/lsp/document-drift.ts": { silent: 5, reason: PRE_RULE },
	"clients/lsp/edits.ts": { silent: 2, reason: PRE_RULE },
	"clients/lsp/index.ts": { silent: 40, reason: SHARP_DID_SAVE },
	"clients/lsp/jvm-runtime.ts": { silent: 1, reason: PRE_RULE },
	"clients/lsp/launch.ts": { silent: 10, reason: PRE_RULE },
	"clients/lsp/lombok.ts": { silent: 6, reason: PRE_RULE },
	"clients/lsp/ruby-drive-dirs.ts": { silent: 2, reason: PRE_RULE },
	"clients/lsp/server.ts": { silent: 25, reason: PRE_RULE },
	"clients/lsp/service-singleton.ts": { silent: 1, reason: PRE_RULE },
	"clients/lsp/tsserver-sync.ts": { silent: 2, reason: PRE_RULE },
	"clients/lsp/wait-policy/strategies.ts": { silent: 1, reason: PRE_RULE },
	"clients/lsp/workspace-diagnostics-cache.ts": { silent: 5, reason: PRE_RULE },
	"clients/lsp/workspace-sweep-hold.ts": { silent: 1, reason: PRE_RULE },
	"clients/mcp/analyze.ts": { silent: 5, reason: PRE_RULE },
	"clients/mcp/ipc.ts": { silent: 6, reason: PRE_RULE },
	"clients/mcp/review.ts": { silent: 3, reason: PRE_RULE },
	"clients/mcp/session.ts": { silent: 1, reason: PRE_RULE },
	"clients/memory-sampler.ts": { silent: 2, reason: PRE_RULE },
	"clients/metrics-history.ts": { silent: 2, reason: PRE_RULE },
	"clients/module-report-lsp.ts": { silent: 3, reason: PRE_RULE },
	"clients/module-report.ts": { silent: 5, reason: PRE_RULE },
	"clients/mutation-attribution.ts": { silent: 2, reason: PRE_RULE },
	"clients/mutation-bridge.ts": { silent: 2, reason: PRE_RULE },
	"clients/ndjson-logger.ts": { silent: 12, reason: PRE_RULE },
	"clients/observed-mutation-sources.ts": { silent: 4, reason: PRE_RULE },
	"clients/observed-mutation.ts": { silent: 8, reason: PRE_RULE },
	"clients/opaque-mutation-scan.ts": { silent: 3, reason: PRE_RULE },
	"clients/opengrep-client.ts": { silent: 3, reason: PRE_RULE },
	"clients/out-of-band-changes.ts": { silent: 3, reason: SHARP_INSTALL_STAMP },
	"clients/package-manager.ts": { silent: 2, reason: PRE_RULE },
	"clients/partial-edit-apply.ts": { silent: 2, reason: PRE_RULE },
	"clients/path-birth.ts": { silent: 1, reason: PRE_RULE },
	"clients/path-utils.ts": { silent: 9, reason: PRE_RULE },
	"clients/performance-report.ts": { silent: 3, reason: PRE_RULE },
	"clients/persistent-reverify.ts": { silent: 3, reason: PRE_RULE },
	"clients/pipeline.ts": { silent: 10, reason: PRE_RULE },
	"clients/probe-home-state.ts": { silent: 1, reason: PRE_RULE },
	"clients/process-snapshot.ts": { silent: 1, reason: PRE_RULE },
	"clients/project-changes.ts": { silent: 4, reason: PRE_RULE },
	"clients/project-conventions.ts": { silent: 5, reason: PRE_RULE },
	"clients/project-diagnostics/cache.ts": { silent: 2, reason: PRE_RULE },
	"clients/project-diagnostics/fresh-fetch.ts": { silent: 1, reason: PRE_RULE },
	"clients/project-diagnostics/scanner.ts": { silent: 6, reason: PRE_RULE },
	"clients/project-lens-config.ts": { silent: 2, reason: PRE_RULE },
	"clients/project-report.ts": { silent: 3, reason: PRE_RULE },
	"clients/project-snapshot-persist-worker.ts": { silent: 1, reason: PRE_RULE },
	"clients/project-snapshot.ts": { silent: 15, reason: PRE_RULE },
	"clients/python-environment.ts": { silent: 2, reason: PRE_RULE },
	"clients/quiet-window.ts": { silent: 2, reason: PRE_RULE },
	"clients/read-expansion.ts": { silent: 1, reason: PRE_RULE },
	"clients/read-guard-branch.ts": { silent: 3, reason: PRE_RULE },
	"clients/read-guard-tool-lines.ts": { silent: 1, reason: PRE_RULE },
	"clients/read-guard.ts": { silent: 11, reason: PRE_RULE },
	"clients/recent-touches.ts": { silent: 6, reason: PRE_RULE },
	"clients/resource-sampler.ts": { silent: 3, reason: PRE_RULE },
	"clients/reverse-deps.ts": { silent: 2, reason: PRE_RULE },
	"clients/review-graph/builder.ts": { silent: 18, reason: PRE_RULE },
	"clients/review-graph/git-identity.ts": { silent: 10, reason: PRE_RULE },
	"clients/review-graph/import-resolvers.ts": { silent: 5, reason: PRE_RULE },
	"clients/review-graph/tsconfig-paths.ts": { silent: 6, reason: PRE_RULE },
	"clients/review-graph/workspace-modules.ts": { silent: 11, reason: PRE_RULE },
	"clients/ruff-client.ts": { silent: 2, reason: PRE_RULE },
	"clients/runtime-agent-end.ts": { silent: 4, reason: PRE_RULE },
	"clients/runtime-coordinator.ts": { silent: 4, reason: PRE_RULE },
	"clients/runtime-session.ts": { silent: 24, reason: PRE_RULE },
	"clients/runtime-tool-call.ts": { silent: 11, reason: PRE_RULE },
	"clients/runtime-tool-result.ts": { silent: 11, reason: SHARP_PRESCAN },
	"clients/runtime-turn.ts": { silent: 17, reason: PRE_RULE },
	"clients/safe-spawn.ts": { silent: 18, reason: PRE_RULE },
	"clients/search-read-registration.ts": { silent: 1, reason: PRE_RULE },
	"clients/session-event-guard.ts": { silent: 5, reason: PRE_RULE },
	"clients/session-lifecycle.ts": { silent: 2, reason: PRE_RULE },
	"clients/session-state-store.ts": { silent: 2, reason: PRE_RULE },
	"clients/sg-runner.ts": { silent: 5, reason: PRE_RULE },
	"clients/sgconfig.ts": { silent: 9, reason: PRE_RULE },
	"clients/slow-fs.ts": { silent: 2, reason: PRE_RULE },
	"clients/smells-rollup.ts": { silent: 4, reason: PRE_RULE },
	"clients/source-walker.ts": { silent: 2, reason: PRE_RULE },
	"clients/test-runner-client.ts": { silent: 15, reason: PRE_RULE },
	"clients/test-runner-delivery.ts": { silent: 2, reason: PRE_RULE },
	"clients/todo-scanner.ts": { silent: 2, reason: PRE_RULE },
	"clients/tool-agreement.ts": { silent: 5, reason: PRE_RULE },
	"clients/tool-cwd.ts": { silent: 1, reason: PRE_RULE },
	"clients/tool-policy.ts": { silent: 29, reason: PRE_RULE },
	"clients/tool-render.ts": { silent: 2, reason: PRE_RULE },
	"clients/tree-sitter-cache.ts": { silent: 2, reason: PRE_RULE },
	"clients/tree-sitter-client.ts": { silent: 29, reason: PRE_RULE },
	"clients/tree-sitter-query-loader.ts": { silent: 3, reason: PRE_RULE },
	"clients/trivy-client.ts": { silent: 8, reason: PRE_RULE },
	"clients/tui-fit.ts": { silent: 1, reason: PRE_RULE },
	"clients/turn-end/delivery-holds.ts": { silent: 1, reason: PRE_RULE },
	"clients/user-notify.ts": { silent: 1, reason: PRE_RULE },
	"clients/vanished-instance-marker.ts": { silent: 1, reason: PRE_RULE },
	"clients/warm-attach.ts": { silent: 2, reason: PRE_RULE },
	"clients/widget-state.ts": { silent: 3, reason: PRE_RULE },
	"clients/word-index.ts": { silent: 4, reason: PRE_RULE },
	"clients/workspace-topology.ts": { silent: 4, reason: PRE_RULE },
	"index.ts": { silent: 42, reason: SHARP_HOST },
	"mcp/analyze-cli.ts": { silent: 1, reason: PRE_RULE },
	"mcp/build-staleness.ts": { silent: 1, reason: PRE_RULE },
	"mcp/cli.ts": { silent: 2, reason: PRE_RULE },
	"mcp/server.ts": { silent: 9, reason: PRE_RULE },
	"mcp/worker.ts": { silent: 2, reason: PRE_RULE },
	"tools/ast-grep-outline.ts": { silent: 1, reason: PRE_RULE },
	"tools/ast-grep-replace.ts": { silent: 1, reason: PRE_RULE },
	"tools/ast-grep-search.ts": { silent: 2, reason: PRE_RULE },
	"tools/lens-diagnostic-mark.ts": { silent: 6, reason: PRE_RULE },
	"tools/lens-diagnostics.ts": { silent: 7, reason: PRE_RULE },
	"tools/lsp-diagnostics.ts": { silent: 10, reason: PRE_RULE },
	"tools/lsp-navigation.ts": { silent: 10, reason: PRE_RULE },
	"tools/lsp-structured-output.ts": { silent: 3, reason: PRE_RULE },
	"tools/module-report.ts": { silent: 3, reason: PRE_RULE },
	"tools/project-report.ts": { silent: 1, reason: PRE_RULE },
	"tools/render-compact.ts": { silent: 1, reason: PRE_RULE },
	"tools/symbol-search.ts": { silent: 1, reason: PRE_RULE },
};

/**
 * The total, pinned separately from the rows so a row cannot be swapped for
 * another row's growth. 1,155 at the base commit; this change's four records
 * and one `none:` line took it to 1,146.
 */
const PINNED_TOTAL = 1146;

interface Census {
	byFile: Map<string, CatchSite[]>;
	recorded: number;
	rethrows: number;
	declaredNone: number;
	silent: number;
	unclassified: Array<{ file: string; site: CatchSite }>;
	scannedFiles: number;
}

function scanShippedTrees(): Census {
	const files = [
		...SHIPPED_TREES.flatMap((dir) =>
			listSourceFiles(path.join(REPO_ROOT, dir), { skipTests: true }),
		),
		path.join(REPO_ROOT, "index.ts"),
	];
	const census: Census = {
		byFile: new Map(),
		recorded: 0,
		rethrows: 0,
		declaredNone: 0,
		silent: 0,
		unclassified: [],
		scannedFiles: 0,
	};
	for (const file of files) {
		const source = readWalkedFile(file);
		if (source === undefined) continue;
		census.scannedFiles++;
		const rel = relativePosix(REPO_ROOT, file);
		for (const site of scanSilentCatches(source)) {
			if (site.verdict === "recorded") census.recorded++;
			else if (site.verdict === "rethrows") census.rethrows++;
			else if (site.verdict === "declared-none") census.declaredNone++;
			else if (site.verdict === "unclassified")
				census.unclassified.push({ file: rel, site });
			else {
				census.silent++;
				const sites = census.byFile.get(rel) ?? [];
				sites.push(site);
				census.byFile.set(rel, sites);
			}
		}
	}
	return census;
}

const census = scanShippedTrees();

function sortedByFile<T>(entries: Iterable<[string, T]>): Array<[string, T]> {
	return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** One pasteable `"file": { silent: n, reason: … },` line per file. */
function pins(c: Census): string[] {
	return sortedByFile(c.byFile).map(([file, sites]) => {
		const lines = sites.map((site) => site.line).join(", ");
		return `\t"${file}": { silent: ${sites.length}, reason: PRE_RULE }, // ${lines}`;
	});
}

interface Audit {
	unlisted: string[];
	mismatched: string[];
	dead: string[];
	unreasoned: string[];
	overTotal: boolean;
}

/**
 * The census against the pins, as one pure verdict so each branch has its own
 * case below. `baseline` and `total` are arguments, not the constants, so a
 * fixture can plant the exact violation a branch exists to catch.
 */
function auditSilentCatches(
	c: Census,
	baseline: Readonly<Record<string, Admission>> = BASELINE,
	total = PINNED_TOTAL,
): Audit {
	const unlisted: string[] = [];
	const mismatched: string[] = [];
	for (const [file, sites] of sortedByFile(c.byFile)) {
		const allowed = baseline[file];
		const detail = sites
			.map((site) => `:${site.line} ${site.snippet}`)
			.join(" | ");
		if (!allowed) unlisted.push(`${file}: ${sites.length} silent (${detail})`);
		else if (allowed.silent !== sites.length)
			mismatched.push(
				`${file}: pinned ${allowed.silent}, found ${sites.length} (${detail})`,
			);
	}
	return {
		unlisted,
		mismatched,
		dead: Object.keys(baseline)
			.filter((file) => !c.byFile.has(file))
			.sort(),
		unreasoned: Object.entries(baseline)
			.filter(([, admission]) => admission.reason.trim().length < 40)
			.map(([file]) => file)
			.sort(),
		overTotal: c.silent > total,
	};
}

/** A census holding one silent handler per named file, for the branch cases. */
function censusOf(
	files: Record<string, number>,
	/* the audit reads only `byFile` and the silent total */
): Census {
	const byFile = new Map<string, CatchSite[]>();
	let silent = 0;
	for (const [file, count] of Object.entries(files)) {
		byFile.set(
			file,
			Array.from({ length: count }, (_, index) => ({
				line: index + 1,
				form: "catch-clause" as const,
				verdict: "silent" as const,
				records: [],
				snippet: "{}",
			})),
		);
		silent += count;
	}
	return {
		byFile,
		recorded: 0,
		rethrows: 0,
		declaredNone: 0,
		silent,
		unclassified: [],
		scannedFiles: 1,
	};
}

const ADMITTED: Admission = { silent: 1, reason: PRE_RULE };

describe("silent-catch sweep", () => {
	it("scans the shipped trees", () => {
		assertNonEmptyScan("silent-catch sweep", census.scannedFiles, 300);
	});

	it("classifies every handler, so no catch is invisible to the scan", () => {
		expect(
			census.unclassified.map(
				({ file, site }) => `${file}:${site.line}: ${site.problem}`,
			),
		).toEqual([]);
	});

	it("derives the verdicts this sweep claims to distinguish", () => {
		// Floors, not constants: the point is that every detector still finds a
		// population, so a broken seam regex, rethrow reader or `none:` reader
		// reds here instead of quietly reclassifying the tree.
		assertNonEmptyScan("recorded handlers", census.recorded, 100);
		assertNonEmptyScan("rethrow-only handlers", census.rethrows, 1);
		assertNonEmptyScan("declared-none handlers", census.declaredNone, 1);
	});

	it("admits no silent handler outside the pinned population", () => {
		const audit = auditSilentCatches(census);
		expect({ unlisted: audit.unlisted, mismatched: audit.mismatched }).toEqual({
			unlisted: [],
			mismatched: [],
		});
	});

	it("keeps every pinned row alive and every admission reasoned", () => {
		const audit = auditSilentCatches(census);
		expect({ dead: audit.dead, unreasoned: audit.unreasoned }).toEqual({
			dead: [],
			unreasoned: [],
		});
	});

	it("holds the pinned total, which only shrinks", () => {
		// A row deleted while another grew keeps the per-file check honest only if
		// the total is also pinned: this is the one number a reviewer reads.
		expect(auditSilentCatches(census).overTotal).toBe(false);
		expect(census.byFile.size).toBe(Object.keys(BASELINE).length);
	});

	it("prints the census a future round re-derives", () => {
		const report = {
			scannedFiles: census.scannedFiles,
			recorded: census.recorded,
			rethrows: census.rethrows,
			declaredNone: census.declaredNone,
			silent: census.silent,
			files: census.byFile.size,
		};
		if (process.env.PI_LENS_PRINT_PINS === "1")
			console.log(`${JSON.stringify(report)}\n${pins(census).join("\n")}`);
		expect(report.silent).toBeLessThanOrEqual(PINNED_TOTAL);
	});
});

/** One case per branch of {@link auditSilentCatches}, each planting its own
 *  violation: a branch nothing can red is a branch that does not guard. */
describe("the audit's own branches", () => {
	it("names a silent handler in a file no row admits", () => {
		const audit = auditSilentCatches(
			censusOf({ "clients/new.ts": 2 }),
			{},
			100,
		);
		expect(audit.unlisted).toEqual([
			"clients/new.ts: 2 silent (:1 {} | :2 {})",
		]);
	});

	it("names a file whose silent count grew above its pin", () => {
		const audit = auditSilentCatches(
			censusOf({ "clients/old.ts": 3 }),
			{ "clients/old.ts": ADMITTED },
			100,
		);
		expect(audit.mismatched).toEqual([
			"clients/old.ts: pinned 1, found 3 (:1 {} | :2 {} | :3 {})",
		]);
	});

	it("names a file whose silent count fell below its pin", () => {
		const audit = auditSilentCatches(
			censusOf({ "clients/old.ts": 1 }),
			{ "clients/old.ts": { silent: 2, reason: PRE_RULE } },
			100,
		);
		expect(audit.mismatched).toEqual([
			"clients/old.ts: pinned 2, found 1 (:1 {})",
		]);
	});

	it("names a pinned row with no silent handler left", () => {
		const audit = auditSilentCatches(
			censusOf({}),
			{ "clients/gone.ts": ADMITTED },
			100,
		);
		expect(audit.dead).toEqual(["clients/gone.ts"]);
	});

	it("names an admission with no stated reason", () => {
		const audit = auditSilentCatches(censusOf({ "clients/x.ts": 1 }), {
			"clients/x.ts": { silent: 1, reason: "because" },
		});
		expect(audit.unreasoned).toEqual(["clients/x.ts"]);
	});

	it("flags a total above the pinned one", () => {
		expect(
			auditSilentCatches(
				censusOf({ "clients/x.ts": 2 }),
				{
					"clients/x.ts": { silent: 2, reason: PRE_RULE },
				},
				1,
			).overTotal,
		).toBe(true);
	});
});
