/**
 * #4532 gap 13: a module the diagnosed file imports directly, open in no
 * server, changed outside pi. A server keeps the bytes of a closed module it
 * read for an importer and re-reads them only when a watched-files event names
 * the file, so the importer's answer stayed stale on the first call and on
 * every call after it (pyright 1.1.414, measured: 10 of 10 stale on call 1 and
 * on call 2, nothing about the module ever sent).
 *
 * These cases drive the REAL `lsp_diagnostics` handler, LSPService and client
 * over a stdio JSON-RPC wire. The server is the shared fake in its closed-file
 * cache profile (`FAKE_LSP_CLOSED_FILE_CACHE`): it keeps a closed module's
 * bytes until a watched-files event names it, and reports an imported name the
 * module's bytes do not export (`has no exported member`). It is configured as
 * the project's server for `.ts` files, whose `import { X } from "./m"` lines
 * the review graph's resolvers read too. The real-pyright transcript is in the
 * PR body: no test lane installs pyright.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const PREFIX = "pi-lens-4532-unheld-import-";
const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment(PREFIX);
const workspace = env.tmpDir;
const trace = path.join(workspace, "server.trace");

async function diagnose(
	args: { paths: string[] } | { path: string },
): Promise<{ text: string; findings: unknown }> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4532-g13b",
		{ ...args, serverScope: "primary", waitMs: 3000, concurrency: 1 },
		undefined,
		null,
		{ cwd: workspace },
	)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return {
		text: String(result.content[0]?.text),
		findings: result.details?.primaryDiagnosticsCount,
	};
}

/** The server's trace lines so far; a case counts the ones after its mark. */
function traceLines(): string[] {
	return fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").split("\n") : [];
}

/**
 * The watched-files `Changed` events the server received for `file` after
 * trace line `from`. An open sends its own watched event, so a case marks the
 * trace right before the outside write.
 */
function changedEventsFor(file: string, from: number): number {
	const line = `watched ${pathToFileURL(file).href} 2`;
	return traceLines()
		.slice(from)
		.filter((entry) => entry === line).length;
}

/** The latency log's `lsp_unheld_dependency_changed` rows, in order. */
function phaseRows(): Array<{
	result?: string;
	metadata?: { changed?: number; paths?: string[] };
}> {
	if (!fs.existsSync(getLatencyLogPath())) return [];
	const { rows, skipped } = readNdjsonRows<{
		phase?: string;
		result?: string;
		metadata?: { changed?: number; paths?: string[] };
	}>(getLatencyLogPath());
	expect(skipped).toBe(0);
	return rows.filter((row) => row.phase === "lsp_unheld_dependency_changed");
}

/** A fixture pair: `<name>_user.ts` imports `NEW` from `<name>_dep.ts`. */
function pair(name: string): { user: string; dep: string } {
	const dep = path.join(workspace, `${name}_dep.ts`);
	const user = path.join(workspace, `${name}_user.ts`);
	fs.writeFileSync(dep, "export const OLD = 1;\n");
	fs.writeFileSync(user, `import { NEW } from "./${name}_dep";\nexport {};\n`);
	return { user, dep };
}

/** Bytes written well before any server of this file started. */
function age(file: string): void {
	const past = Math.floor(Date.now() / 1000) - 600;
	fs.utimesSync(file, past, past);
}

const MISSING = "has no exported member 'NEW'";

let service:
	| {
			shutdown: () => Promise<void>;
			touchFile: (
				filePath: string,
				content: string,
				options: { diagnostics: "document" | "none"; source: string },
			) => Promise<unknown>;
	  }
	| undefined;

beforeAll(async () => {
	// Host-boundary stub: a project-configured server needs pi's trust (#4248).
	setProjectTrustState("trusted");
	const shim = path.join(workspace, "closed-cache-server.mjs");
	fs.writeFileSync(
		shim,
		[
			'process.env.FAKE_LSP_CLOSED_FILE_CACHE = "1";',
			`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(trace)};`,
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"unheld","version":"0.0.0"}\n',
	);
	fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			servers: {
				"closed-ts": {
					name: "closed-file cache server",
					extensions: [".ts", ".js"],
					command: process.execPath,
					args: [shim],
					rootMarkers: ["package.json"],
				},
			},
			disabledServers: ["typescript", "deno", "opengrep", "ast-grep", "typos"],
		}),
	);
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(workspace);
	const lsp = await import("../../clients/lsp/index.js");
	service = lsp.getLSPService() as unknown as typeof service;
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained(PREFIX, {
		beforeDrain: async () => {
			await service?.shutdown();
		},
	});
	resetProjectTrust();
});

describe("a closed module changed outside pi (#4532 gap 13)", () => {
	// Recurrence: #4532 gap 13, the investigator's fixture shape. The module's
	// first sighting is the stale answer's own call, so its record is the old
	// bytes; the outside write moves them.
	it("reads clean on the first call after the change, single-file route", async () => {
		const { user, dep } = pair("single");
		age(dep);
		expect((await diagnose({ path: user })).text).toContain(MISSING);

		const mark = traceLines().length;
		fs.writeFileSync(dep, "export const NEW = 1;\n");
		const first = await diagnose({ path: user });

		expect(first.text).not.toContain(MISSING);
		expect(changedEventsFor(dep, mark)).toBe(1);
	}, 30_000);

	it("reads clean on the first call after the change, batch route", async () => {
		const { user, dep } = pair("batch");
		age(dep);
		expect((await diagnose({ paths: [user] })).findings).toBe(1);

		const mark = traceLines().length;
		fs.writeFileSync(dep, "export const NEW = 1;\n");
		const first = await diagnose({ paths: [user] });

		expect(first.findings).toBe(0);
		expect(changedEventsFor(dep, mark)).toBe(1);
	}, 30_000);

	// Recurrence: a first sighting read as a baseline. The server read the
	// module through the importer's open (a write hook's touch) before any
	// diagnostics call resolved the importer, so the call's first record was
	// already the new bytes, and nothing was sent (real pyright: 3 of 3 stale
	// with the first-sighting rule removed).
	it("reads clean when the module changed before its first sighting", async () => {
		const { user, dep } = pair("unsighted");
		await service?.touchFile(user, fs.readFileSync(user, "utf8"), {
			diagnostics: "document",
			source: "write-hook-4532",
		});

		const mark = traceLines().length;
		fs.writeFileSync(dep, "export const NEW = 1;\n");
		const first = await diagnose({ path: user });

		expect(first.text).not.toContain(MISSING);
		expect(changedEventsFor(dep, mark)).toBe(1);
	}, 30_000);

	it("sends nothing for a module unchanged since before its server started", async () => {
		const { user, dep } = pair("unchanged");
		age(dep);
		const mark = traceLines().length;

		expect((await diagnose({ path: user })).text).toContain(MISSING);
		expect((await diagnose({ path: user })).text).toContain(MISSING);

		expect(changedEventsFor(dep, mark)).toBe(0);
	}, 30_000);

	// A rewrite of the same bytes (a `touch`, a checkout of an unchanged file)
	// moves the stat only; the bytes decide.
	it("sends nothing for a module whose stat moved and bytes did not", async () => {
		const { user, dep } = pair("touched");
		age(dep);
		expect((await diagnose({ path: user })).text).toContain(MISSING);

		const mark = traceLines().length;
		const now = Date.now() / 1000;
		fs.utimesSync(dep, now, now);
		expect((await diagnose({ path: user })).text).toContain(MISSING);

		expect(changedEventsFor(dep, mark)).toBe(0);
	}, 30_000);

	// Recurrence: the record a sent event refreshes dropped the hash the check
	// had just taken, so the next same-bytes stat move (a save of unchanged
	// bytes) compared no bytes and sent the module again.
	it("sends nothing when bytes it sent are rewritten unchanged", async () => {
		const { user, dep } = pair("resaved");
		age(dep);
		expect((await diagnose({ path: user })).text).toContain(MISSING);
		fs.writeFileSync(dep, "export const NEW = 1;\n");
		expect((await diagnose({ path: user })).text).not.toContain(MISSING);

		const mark = traceLines().length;
		const later = Date.now() / 1000 + 5;
		fs.utimesSync(dep, later, later);
		expect((await diagnose({ path: user })).text).not.toContain(MISSING);

		expect(changedEventsFor(dep, mark)).toBe(0);
	}, 30_000);

	// A held module is the open-document sync's to keep current (#4532 gap
	// 13a); a watched-files event for an open document is noise.
	it("sends nothing for a module a server holds open", async () => {
		const { user, dep } = pair("held");
		await service?.touchFile(dep, fs.readFileSync(dep, "utf8"), {
			diagnostics: "none",
			source: "hold-4532",
		});
		expect((await diagnose({ path: user })).text).toContain(MISSING);

		const mark = traceLines().length;
		fs.writeFileSync(dep, "export const NEW = 1;\n");
		await diagnose({ path: user });

		expect(changedEventsFor(dep, mark)).toBe(0);
	}, 30_000);
	// Recurrence: #4742's head-move phase notifies its unheld paths and then
	// announces them; each path went out twice until a sent event refreshed
	// the record (tests/clients/head-move-resync-4493.test.ts pins that phase).
	it("sends nothing for a change another sender already delivered", async () => {
		const { user, dep } = pair("delivered");
		age(dep);
		expect((await diagnose({ path: user })).text).toContain(MISSING);

		fs.writeFileSync(dep, "export const NEW = 1;\n");
		const lsp = service as unknown as {
			notifyOutOfBandFileChanges: (
				changes: Array<{ filePath: string; type: number }>,
			) => void;
		};
		const mark = traceLines().length;
		lsp.notifyOutOfBandFileChanges([{ filePath: dep, type: 2 }]);
		const after = await diagnose({ path: user });

		expect(after.text).not.toContain(MISSING);
		// The other sender's event, and none from the call.
		expect(changedEventsFor(dep, mark)).toBe(1);
	}, 30_000);

	// Recurrence: a sent Deleted event left the module's record behind, so the
	// module restored with the same bytes (a HEAD move away and back, #4742)
	// compared equal and was never sent: the server kept its deleted view.
	it("sends a module restored with its old bytes after a sent deletion", async () => {
		const { user, dep } = pair("restored");
		age(dep);
		expect((await diagnose({ path: user })).text).toContain(MISSING);

		const bytes = fs.readFileSync(dep);
		fs.unlinkSync(dep);
		const lsp = service as unknown as {
			notifyOutOfBandFileChanges: (
				changes: Array<{ filePath: string; type: number }>,
			) => void;
		};
		lsp.notifyOutOfBandFileChanges([{ filePath: dep, type: 3 }]);
		fs.writeFileSync(dep, bytes);
		const mark = traceLines().length;
		const after = await diagnose({ path: user });

		expect(after.text).toContain(MISSING);
		expect(changedEventsFor(dep, mark)).toBe(1);
	}, 30_000);
});

describe("the record of a sent change (#4532 gap 13)", () => {
	it("writes one row per call that sent, naming the module", async () => {
		const saved = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			const { user, dep } = pair("row");
			age(dep);
			await flushLatencyLog();
			const before = phaseRows().length;
			await diagnose({ path: user });
			fs.writeFileSync(dep, "export const NEW = 1;\n");
			await diagnose({ path: user });
			await diagnose({ path: user });

			await flushLatencyLog();
			// Three calls, one of which sent: one row, and none from the two
			// calls that sent nothing.
			const sent = phaseRows().slice(before);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.metadata?.paths).toEqual([dep]);
			expect(sent[0]?.result).toBe("changed:1");
		} finally {
			if (saved === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = saved;
		}
	}, 30_000);

	// lane: dev-box-only and every POSIX lane; root reads any mode, and win32
	// has no mode bits for chmod 000 to remove.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"records an unreadable module once and still sends its moved stat",
		async () => {
			resetDegradationLedger();
			const { user, dep } = pair("unreadable");
			age(dep);
			await diagnose({ path: user });
			const mark = traceLines().length;
			fs.writeFileSync(dep, "export const NEW = 1;\n");
			fs.chmodSync(dep, 0o000);
			try {
				await diagnose({ path: user });
			} finally {
				fs.chmodSync(dep, 0o644);
			}

			expect(changedEventsFor(dep, mark)).toBe(1);
			expect(
				getDegradationSummary()
					.filter((entry) => entry.kind === "lsp-unheld-dependency-unreadable")
					.map((entry) => entry.count),
			).toEqual([1]);
		},
		30_000,
	);
});
