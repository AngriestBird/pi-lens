/**
 * #2281 — LSP-facing latency logger mocks must preserve the real export surface.
 *
 * A bare factory replacement hides exports added after the test was written.
 * These files all load the LSP seam, so their mocks must be strict partials.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../support/module-instance-scan.js";

const lspLatencyLoggerMocks = [
	"tests/clients/lsp/cascade-tier.test.ts",
	"tests/clients/lsp/classic-repair-rearm.test.ts",
	"tests/clients/lsp/client-selection-outcome.test.ts",
	"tests/clients/lsp/client-unavailable-dedupe.test.ts",
	"tests/clients/pipeline-lsp-sync.test.ts",
	"tests/clients/lsp/server-init-overrides.test.ts",
	"tests/clients/lsp/service-aux-grace.test.ts",
	"tests/clients/lsp/service-inconclusive-per-server.test.ts",
	"tests/clients/lsp/service-notify-inflight-throttle-real-stream.test.ts",
	"tests/clients/lsp/service-notify-inflight-throttle.test.ts",
	"tests/clients/lsp/service-race.test.ts",
	"tests/clients/lsp/service-scanner-coverage-gap.test.ts",
	"tests/clients/lsp/service-tsserver-sync-confirm.test.ts",
	"tests/clients/lsp/shutdown-wedged-connection.test.ts",
	"tests/clients/lsp/sweep-warmup.test.ts",
	"tests/clients/lsp/teardown-logging.test.ts",
	"tests/clients/runtime-session-quick-mode-observability.test.ts",
	"tests/clients/runtime-tool-result.test.ts",
	"tests/clients/lsp/workspace-sweep-hold.test.ts",
	"tests/clients/startup-overhead.test.ts",
	"tests/clients/write-autofix-attachment-message.test.ts",
	"tests/clients/write-autofix-nudge-suppression.test.ts",
] as const;

describe("LSP latency-logger mocks preserve exports (#2281)", () => {
	it("uses importActual partial mocks in every enumerated file", () => {
		const stale = lspLatencyLoggerMocks.filter((relativePath) => {
			const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
			return (
				!source.includes("latency-logger.js") ||
				!source.includes("importActual")
			);
		});

		expect(stale).toEqual([]);
	});

	it("rejects the old bare factory shape", () => {
		const oldShape =
			'vi.mock("../../clients/latency-logger.js", () => ({ logLatency }))';
		expect(oldShape.includes("importActual")).toBe(false);
	});
});
