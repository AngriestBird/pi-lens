/**
 * #4615 — the `[lsp-pub]` sink row names the DOCUMENT it is about.
 *
 * ## The recurrence this guards
 *
 * `probe-clean-signal.mjs` brackets each fixture phase with a byte offset in
 * `extension.log`, and that sink is a buffered async writer: a line enqueued by
 * an earlier fixture can flush after the next fixture's `reset()`. The drain
 * used to keep rows by `server` alone, and five typescript fixtures share that
 * server id with their clients alive in the same process — so another client's
 * late `diags=1` publish became `typescript-clean`'s first publish, and
 * `classifyFirstPublish` (order-only) read it as `direct`. That value fed the
 * nightly's `typescript` row.
 *
 * This file drives the production notification handler, captures what it hands
 * the extension-log sink, and drains that window through the real
 * `createPublishTraceDrainer` for one (server, document). The plant is the real
 * ordering: fixture B's own empty answer, then fixture A's row arriving late.
 */
import { describe, expect, it, vi } from "vitest";

const { logged } = vi.hoisted(() => ({
	logged: [] as Array<{
		subsystem: string;
		level?: string;
		message: string;
		metadata?: { path?: string };
	}>,
}));

// `logExtension` is a no-op under Vitest (`isTestMode`), and the client reads
// `PILENS_PUB_DEBUG` once at module load, so the sink is captured here and the
// env flag is set before the dynamic import below.
vi.mock("../../../clients/extension-log.js", () => ({
	logExtension: (entry: (typeof logged)[number]) => {
		logged.push(entry);
	},
	createSubsystemLogger: () =>
		Object.assign(() => undefined, {
			error: () => undefined,
			warn: () => undefined,
			debug: () => undefined,
		}),
	EXTENSION_LOG_FILE: "/dev/null/extension.log",
}));

process.env.PILENS_PUB_DEBUG = "1";
const { setupIncomingHandlers } =
	await import("../../../clients/lsp/client.js");
const { createPublishTraceDrainer, classifyFirstPublish } =
	await import("../../../scripts/lib/clean-signal.mjs");
const { normalizeMapKey } = await import("../../../clients/path-utils.js");
const { createMockState } = await import("./mock-client-state.js");

const DIRTY_FILE = "/proj/fixtures/typescript/bad.ts";
const CLEAN_FILE = "/proj/fixtures/typescript-clean/clean.ts";
const FINDING = {
	severity: 1,
	message: "Type 'string' is not assignable to type 'number'.",
	range: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 5 },
	},
};

/** One parsed `[lsp-pub]` row as the drainer pushes it into a phase sink. */
interface DrainedPublish {
	server: string;
	path?: string;
	pubVersion: string;
	diags: number;
	versioned: boolean;
}

type Publish = (params: {
	uri: string;
	diagnostics?: unknown[];
	version?: number;
}) => void;

/** Arm the production handler for one server id; return its publish entry. */
function armHandler(serverId: string): Publish {
	const state = createMockState({ serverId });
	setupIncomingHandlers(state, {});
	const calls = vi.mocked(state.connection.onNotification).mock
		.calls as unknown as Array<[string, Publish]>;
	const handler = calls.find(
		(call) => call[0] === "textDocument/publishDiagnostics",
	)?.[1];
	expect(handler).toBeDefined();
	return handler as Publish;
}

/** The captured sink as the NDJSON text the real writer would append. */
function sinkText(): string {
	return logged.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

/** A drainer over the captured sink, keyed exactly as the probe keys it. */
function drainer() {
	return createPublishTraceDrainer({
		readLog() {
			const bytes = Buffer.from(sinkText());
			return {
				size: bytes.length,
				read(start: number) {
					return {
						chunk: bytes.subarray(start).toString("utf8"),
						bytesRead: bytes.length - start,
					};
				},
			};
		},
		documentPathKey: normalizeMapKey,
	});
}

describe("#4615 the publish trace names its document", () => {
	it("stamps the client's own document key into every [lsp-pub] row", () => {
		logged.length = 0;
		const publish = armHandler("typescript");
		publish({ uri: `file://${DIRTY_FILE}`, diagnostics: [FINDING] });

		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({
			subsystem: "lsp-pub",
			message: expect.stringContaining("diags=1"),
			metadata: { path: normalizeMapKey(DIRTY_FILE) },
		});
	});

	it("never attributes another live client's late publish to this fixture (#4615)", () => {
		logged.length = 0;
		const drain = drainer();
		const publishDirty = armHandler("typescript");
		const publishClean = armHandler("typescript");

		// Fixture A (dirty): its own one-finding answer, the measured `direct`.
		drain.reset(0);
		publishDirty({ uri: `file://${DIRTY_FILE}`, diagnostics: [FINDING] });
		const dirtySink: DrainedPublish[] = [];
		drain(dirtySink, "typescript", DIRTY_FILE);
		expect(classifyFirstPublish(dirtySink).firstPublish).toBe("direct");

		// Fixture B (clean): its phase starts at the current sink size; its own
		// only publish is the empty settled answer...
		drain.reset(Buffer.byteLength(sinkText()));
		publishClean({ uri: `file://${CLEAN_FILE}`, diagnostics: [] });
		// ...and fixture A's client republishes AFTER that reset — the buffered
		// writer's late flush that landed three lines 1 ms apart in run
		// 39410536713.
		publishDirty({ uri: `file://${DIRTY_FILE}`, diagnostics: [FINDING] });

		const cleanSink: DrainedPublish[] = [];
		drain(cleanSink, "typescript", CLEAN_FILE);
		expect(cleanSink.map((row) => row.diags)).toEqual([0]);
		expect(classifyFirstPublish(cleanSink).firstPublish).toBe("empty-only");
	});
});
