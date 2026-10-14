/**
 * #1649: how many times one tool call reads a file to account for it.
 *
 * Recurrences prevented: one native `read` re-read and re-split the whole file
 * three times at `tool_call` (effective limit, `read_pattern` total, provisional
 * capture) and three more at `tool_result`; N search hits in one file read it
 * N times; and `tail -n 20` of a vendor or ignored file counted its lines
 * twice and then discarded the span. A new read on any of these paths, or a
 * filter moved back behind the count, turns a row here red.
 *
 * The counter sits at the host boundary, `node:fs`: every `openSync` of the
 * file (the one-pass scan) and every `readFileSync(file, encoding)` (the
 * released whole-file read and split). The observed-mutation settle's
 * one-argument raw-byte hash is not read accounting and is not counted; the
 * same split is in runtime-tool-result.test.ts ("One raw-byte hash"). The
 * handlers, the read guard and pi's own read tool are real.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { constants as bufferConstants } from "node:buffer";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
	target: "",
	passes: 0,
	bytesRead: 0,
	fds: new Set<number>(),
	reportSize: undefined as number | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
		if (String(args[0]) === io.target && args.length > 1) io.passes += 1;
		return actual.readFileSync(...args);
	}) as typeof actual.readFileSync;
	const openSync = ((...args: Parameters<typeof actual.openSync>) => {
		const fd = actual.openSync(...args);
		if (String(args[0]) === io.target) {
			io.passes += 1;
			io.fds.add(fd);
		}
		return fd;
	}) as typeof actual.openSync;
	const closeSync = ((fd: number) => {
		io.fds.delete(fd);
		return actual.closeSync(fd);
	}) as typeof actual.closeSync;
	// The byte gate's input: the size of the open file, which the case can
	// report as larger than it is without writing half a gigabyte.
	const fstatSync = ((...args: Parameters<typeof actual.fstatSync>) => {
		const stat = actual.fstatSync(...args);
		if (io.reportSize === undefined || !io.fds.has(args[0] as number))
			return stat;
		return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
			size: io.reportSize,
		});
	}) as typeof actual.fstatSync;
	const readSync = ((...args: Parameters<typeof actual.readSync>) => {
		const n = actual.readSync(...args);
		if (io.fds.has(args[0] as number)) io.bytesRead += n;
		return n;
	}) as typeof actual.readSync;
	return { ...actual, readFileSync, openSync, closeSync, fstatSync, readSync };
});

import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import { setupTestEnvironment } from "./test-utils.js";

const env = setupTestEnvironment("pi-lens-1649-passes-");
afterAll(() => env.cleanup());

// LSP and complexity read the file for their own work, not to account for
// the read; they are off so every counted pass is read accounting.
const flags = (name: string) => name === "no-lsp" || name === "no-complexity";

let caseNo = 0;
let root: string;

beforeEach(() => {
	io.target = "";
	io.passes = 0;
	io.bytesRead = 0;
	io.reportSize = undefined;
	root = path.join(env.tmpDir, `case-${caseNo++}`);
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.mkdirSync(path.join(root, "dist"), { recursive: true });
	fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
	fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n");
});

function source(lines: number): string {
	return `${Array.from({ length: lines }, (_, i) => `const v${i} = ${i};`).join("\n")}\n`;
}

function runtimeFor(): RuntimeCoordinator {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = root;
	return runtime;
}

async function toolCall(
	runtime: RuntimeCoordinator,
	event: { toolName: string; toolCallId: string; input: unknown },
): Promise<void> {
	await runHandlerExpectingNoThrow(() =>
		handleToolCall({
			event,
			ctx: { cwd: root },
			lensEnabled: true,
			getFlag: flags,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			ensureLSPConfigInitialized: async () => {},
			updateLspStatus: () => {},
			resetLSPService: () => {},
		} as Parameters<typeof handleToolCall>[0]),
	);
}

async function toolResult(
	runtime: RuntimeCoordinator,
	event: {
		toolName: string;
		toolCallId: string;
		input: unknown;
		content: unknown;
		details?: unknown;
	},
): Promise<void> {
	await handleToolResult({
		event,
		getFlag: flags,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		resetLSPService: () => {},
		readGuard: runtime.readGuard,
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as unknown as Parameters<typeof handleToolResult>[0]);
}

/** One native read through pi's read tool; the passes at each hook. */
async function nativeRead(
	runtime: RuntimeCoordinator,
	file: string,
	input: { path: string; offset?: number; limit?: number },
): Promise<{ call: number; result: number }> {
	const id = `read-${caseNo}-${input.offset ?? 0}`;
	io.target = file;
	io.passes = 0;
	await toolCall(runtime, { toolName: "read", toolCallId: id, input });
	const call = io.passes;
	const delivered = await createReadToolDefinition(root).execute(
		id,
		input,
		undefined,
		undefined,
		{ cwd: root } as never,
	);
	io.passes = 0;
	await toolResult(runtime, {
		toolName: "read",
		toolCallId: id,
		input,
		content: delivered.content,
		details: delivered.details,
	});
	return { call, result: io.passes };
}

async function bashResult(
	runtime: RuntimeCoordinator,
	file: string,
	command: string,
	output: string,
	details?: unknown,
): Promise<number> {
	io.target = file;
	io.passes = 0;
	await toolResult(runtime, {
		toolName: "bash",
		toolCallId: `bash-${caseNo}`,
		input: { command },
		content: [{ type: "text", text: output }],
		...(details !== undefined && { details }),
	});
	return io.passes;
}

describe("read accounting reads a file once per hook (#1649)", () => {
	it("reads a whole-file native read once at tool_call and once at tool_result", async () => {
		const file = path.join(root, "src", "a.ts");
		fs.writeFileSync(file, source(200));
		const runtime = runtimeFor();
		expect(await nativeRead(runtime, file, { path: file })).toEqual({
			call: 1,
			result: 1,
		});
		// The one pass still yields the released evidence: 201 lines (a
		// trailing newline counts), every one hashed.
		const record = runtime.readGuard.getReadHistory(file).at(-1);
		expect(record).toMatchObject({ effectiveOffset: 1, effectiveLimit: 201 });
		expect(Object.keys(record?.lineHashes ?? {})).toHaveLength(201);
	});

	it("reads a ranged native read once at each hook", async () => {
		const file = path.join(root, "src", "a.ts");
		fs.writeFileSync(file, source(200));
		const runtime = runtimeFor();
		expect(
			await nativeRead(runtime, file, { path: file, offset: 50, limit: 20 }),
		).toEqual({ call: 1, result: 1 });
		const record = runtime.readGuard.getReadHistory(file).at(-1);
		expect(Object.keys(record?.lineHashes ?? {}).map(Number)).toEqual(
			Array.from({ length: 20 }, (_, i) => 50 + i),
		);
	});

	it("reads a native read past the end of the file once at tool_call", async () => {
		// Its range holds no line, so the pass hashes nothing; recordRead must
		// not read the file again looking for one.
		const file = path.join(root, "src", "a.ts");
		fs.writeFileSync(file, source(200));
		const runtime = runtimeFor();
		io.target = file;
		await toolCall(runtime, {
			toolName: "read",
			toolCallId: "read-past-end",
			input: { path: file, offset: 500 },
		});
		expect(io.passes).toBe(1);
		const record = runtime.readGuard.getReadHistory(file).at(-1);
		expect(record).toMatchObject({ effectiveOffset: 500, effectiveLimit: 1 });
		expect(record?.lineHashes).toBeUndefined();
	});

	it("reads a file once for grep hits past its end", async () => {
		// Output from before the file shrank: the hits past the end hash
		// nothing, and must not each read the file again looking for a line.
		const file = path.join(root, "src", "a.ts");
		fs.writeFileSync(file, source(200));
		const runtime = runtimeFor();
		const output = ["3:const v2 = 2;", "250:x", "260:y"].join("\n");
		expect(
			await bashResult(runtime, file, "grep -n const src/a.ts", output),
		).toBe(1);
		const records = runtime.readGuard.getReadHistory(file);
		expect(
			records.map((r) => [r.effectiveOffset, r.lineHashes !== undefined]),
		).toEqual([
			[3, true],
			[250, false],
			[260, false],
		]);
	});

	it("reads a file once for five grep hits in it", async () => {
		const file = path.join(root, "src", "a.ts");
		fs.writeFileSync(file, source(200));
		const runtime = runtimeFor();
		const hits = [3, 40, 80, 120, 160];
		const output = hits
			.map((n) => `${n}:const v${n - 1} = ${n - 1};`)
			.join("\n");
		expect(
			await bashResult(runtime, file, "grep -n const src/a.ts", output),
		).toBe(1);
		// Five records, each hashed from the one pass.
		const records = runtime.readGuard.getReadHistory(file);
		expect(records.map((r) => r.effectiveOffset)).toEqual(hits);
		expect(records.every((r) => r.lineHashes?.[r.effectiveOffset])).toBe(true);
	});

	it.each([
		["an ignored file", "dist/bundle.js"],
		["a vendor file", "node_modules/pkg/index.js"],
	])("does not read %s a bash tail viewed", async (_label, rel) => {
		const file = path.join(root, rel);
		fs.writeFileSync(file, source(200));
		const runtime = runtimeFor();
		expect(
			await bashResult(runtime, file, `tail -n 20 ${rel}`, source(20)),
		).toBe(0);
		expect(runtime.readGuard.getReadHistory(file)).toEqual([]);
	});

	it("counts a tracked file a bash tail viewed once, then hashes its span", async () => {
		const file = path.join(root, "src", "a.ts");
		fs.writeFileSync(file, source(200));
		const runtime = runtimeFor();
		// One count to place the tail, one bounded capture of the span: the
		// tail's lines are unknown until the count ends.
		expect(
			await bashResult(runtime, file, "tail -n 20 src/a.ts", source(20)),
		).toBe(2);
		expect(runtime.readGuard.getReadHistory(file).at(-1)).toMatchObject({
			effectiveOffset: 182,
			effectiveLimit: 20,
		});
	});

	it("keeps a vendor file in a clipped view's span count, so the tracked file gets no credit", async () => {
		// A clipped view of two files cannot say which lines of which file pi
		// showed, so it credits neither (#2802). Dropping the vendor file before
		// that check would leave one span and credit a.ts's tail, which pi may
		// never have shown (the vendor file's lines came last).
		const file = path.join(root, "src", "a.ts");
		fs.writeFileSync(file, source(200));
		fs.writeFileSync(
			path.join(root, "node_modules", "pkg", "index.js"),
			source(200),
		);
		const runtime = runtimeFor();
		await bashResult(
			runtime,
			file,
			"cat src/a.ts node_modules/pkg/index.js",
			source(20),
			{ truncation: { truncated: true, outputLines: 20 } },
		);
		expect(runtime.readGuard.getReadHistory(file)).toEqual([]);
	});

	it("takes no capture of a bash view past the hash bound", async () => {
		// The released capture returned before reading for a span over
		// READ_HASH_MAX_LINES (3000); a scan window capped at that bound must
		// not turn it into a read of 3000 lines that hashes nothing.
		const file = path.join(root, "src", "long.ts");
		fs.writeFileSync(file, source(3500));
		const runtime = runtimeFor();
		expect(
			await bashResult(runtime, file, "cat src/long.ts", source(3500)),
		).toBe(1);
		const record = runtime.readGuard.getReadHistory(file).at(-1);
		expect(record).toMatchObject({ effectiveOffset: 1, effectiveLimit: 3501 });
		expect(record?.lineHashes).toBeUndefined();
	});

	it("reads no byte of a file over the byte gate and keeps the released answer", async () => {
		const file = path.join(root, "src", "huge.log");
		fs.writeFileSync(file, source(200));
		const runtime = runtimeFor();
		io.reportSize = bufferConstants.MAX_STRING_LENGTH + 1;
		await nativeRead(runtime, file, { path: file, offset: 1, limit: 20 });
		expect(io.bytesRead).toBe(0);
		// The released whole-file read threw past this size, so the record had
		// no hashes; pi's own read still delivered and is still credited.
		const record = runtime.readGuard.getReadHistory(file).at(-1);
		expect(record?.lineHashes).toBeUndefined();
	});
});
