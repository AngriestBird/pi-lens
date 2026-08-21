/**
 * #1969: an LSP child that closes unprompted leaves a CAUSE record.
 *
 * Live evidence (2026-08-21): an ast-grep child closed with `code=1` and empty
 * stderr, 14 times in one day. Downstream the session showed 19
 * `lsp_client_skipped_broken` cooldowns and 32 `lsp-scanner-coverage-gap`
 * records — all fallout, no cause. The degradation ledger is what a session
 * health read consults, and it held nothing about the death itself.
 *
 * The fix records `lsp-server-unexpected-close` on the child's `close` event,
 * keyed by `serverId`, carrying the exit code, the signal, and whether stderr
 * carried anything. `close` rather than `exit`, so "stderr was empty" is a
 * statement about the server and not a race with the pipe.
 *
 * Two halves, and the second is the mutation guard: an intentional
 * `shutdown()` must record NOTHING. Deleting the `state.shutdownRequested`
 * gate turns every eviction into a fake crash, and reds the second test.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER_PATH = path.join(
	__dirname,
	"../../fixtures/fake-lsp-server.mjs",
);

function closeGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "lsp-server-unexpected-close",
	);
}

describe("LSP client — unexpected close records its cause (#1969)", () => {
	let client:
		| Awaited<
				ReturnType<typeof import("../../../clients/lsp/client.js").createLSPClient>
		  >
		| undefined;

	beforeEach(() => {
		resetDegradationLedger();
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				/* the server may already be gone */
			}
			client = undefined;
		}
		resetDegradationLedger();
	});

	it("records a ledger entry naming the server, the exit code, and the empty stderr", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		const { launchLSP } = await import("../../../clients/lsp/launch.js");

		const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
			env: {
				FAKE_LSP_SELF_EXIT_CODE: "1",
				FAKE_LSP_SELF_EXIT_DELAY_MS: "50",
			},
		});
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});

		await vi.waitFor(
			() => {
				expect(closeGroup()).toBeDefined();
			},
			{ timeout: 8_000, interval: 25 },
		);

		const group = closeGroup();
		expect(group?.count).toBe(1);
		const entry = group?.latestReasons.at(-1);
		expect(entry?.subject).toBe("fake");
		// The three discriminating facts the issue asks for.
		expect(entry?.reason).toContain("code=1");
		expect(entry?.reason).toContain("signal=none");
		expect(entry?.reason).toContain("stderr=empty");

		client = undefined;
	}, 15_000);

	it("records NOTHING for an intentional shutdown()", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		const { launchLSP } = await import("../../../clients/lsp/launch.js");

		const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
		});
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});

		await client.shutdown();
		client = undefined;

		// Let the child actually exit and its `close` handler run. Without the
		// wait this would pass vacuously.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(proc.process.exitCode !== null || proc.process.killed).toBe(true);

		expect(closeGroup()).toBeUndefined();
	}, 15_000);
});
