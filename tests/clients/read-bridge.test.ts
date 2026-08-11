/**
 * Tests for the generic read-recording bridge (clients/read-bridge.ts).
 *
 * Verifies:
 * - registerReadBridge mounts the bridge at globalThis[READ_BRIDGE_KEY]
 * - recordRead forwards entries into the read-guard with correct fields
 * - isRecordable gates forwarding (no-read-guard flag, scope checks)
 * - Second call to registerReadBridge is a no-op (singleton)
 * - turnIndex / writeIndex are sampled at call-time, not registration-time
 * - undefined requestedLimit maps to MAX_SAFE_INTEGER (whole-file coverage)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	READ_BRIDGE_KEY,
	registerReadBridge,
	type ReadBridgeEntry,
} from "../../clients/read-bridge.js";

vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));

type RecordReadArgs = {
	filePath: string;
	requestedOffset: number;
	requestedLimit: number;
	effectiveOffset: number;
	effectiveLimit: number;
	expandedByLsp: boolean;
	turnIndex: number;
	writeIndex: number;
	timestamp: number;
};

function makeDeps(
	opts: {
		turnIndex?: number;
		writeIndex?: number;
		isRecordable?: (fp: string) => boolean;
	} = {},
) {
	const { turnIndex = 0, writeIndex = 0, isRecordable = () => true } = opts;
	const calls: RecordReadArgs[] = [];
	const fakeGuard = {
		recordRead: vi.fn((r: RecordReadArgs) => calls.push(r)),
	};
	return {
		getReadGuard: () => fakeGuard,
		getTurnIndex: () => turnIndex,
		peekWriteIndex: () => writeIndex,
		isRecordable,
		calls,
		fakeGuard,
	};
}

describe("read-bridge", () => {
	beforeEach(() => {
		delete (globalThis as any)[READ_BRIDGE_KEY];
	});
	afterEach(() => {
		delete (globalThis as any)[READ_BRIDGE_KEY];
	});

	it("bridge is absent before registerReadBridge is called", () => {
		expect((globalThis as any)[READ_BRIDGE_KEY]).toBeUndefined();
	});

	it("registerReadBridge mounts the bridge at the well-known Symbol key", () => {
		registerReadBridge(makeDeps());
		expect((globalThis as any)[READ_BRIDGE_KEY]).toBeDefined();
	});

	it("recordRead forwards the entry into the read-guard with correct fields", () => {
		const deps = makeDeps({ turnIndex: 3, writeIndex: 7 });
		registerReadBridge(deps);

		const entry: ReadBridgeEntry = {
			filePath: "/project/src/main.go",
			requestedOffset: 10,
			requestedLimit: 50,
			timestamp: 12345,
		};
		(globalThis as any)[READ_BRIDGE_KEY].recordRead(entry);

		expect(deps.fakeGuard.recordRead).toHaveBeenCalledOnce();
		const call = deps.calls[0];
		expect(call.filePath).toBe("/project/src/main.go");
		expect(call.requestedOffset).toBe(10);
		expect(call.requestedLimit).toBe(50);
		expect(call.effectiveOffset).toBe(10);
		expect(call.effectiveLimit).toBe(50);
		expect(call.expandedByLsp).toBe(false);
		expect(call.turnIndex).toBe(3);
		expect(call.writeIndex).toBe(7);
		expect(call.timestamp).toBe(12345);
	});

	it("undefined requestedLimit maps to MAX_SAFE_INTEGER (whole-file coverage)", () => {
		const deps = makeDeps();
		registerReadBridge(deps);

		(globalThis as any)[READ_BRIDGE_KEY].recordRead({
			filePath: "/project/file.ts",
			requestedOffset: 1,
			requestedLimit: undefined,
			timestamp: 0,
		});

		const call = deps.calls[0];
		expect(call.requestedLimit).toBe(Number.MAX_SAFE_INTEGER);
		expect(call.effectiveLimit).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("isRecordable returning false suppresses forwarding", () => {
		const deps = makeDeps({ isRecordable: () => false });
		registerReadBridge(deps);

		(globalThis as any)[READ_BRIDGE_KEY].recordRead({
			filePath: "/project/ignored.ts",
			requestedOffset: 1,
			requestedLimit: 10,
			timestamp: 0,
		});

		expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
	});

	it("isRecordable receives the entry filePath", () => {
		const seen: string[] = [];
		const deps = makeDeps({ isRecordable: (fp) => { seen.push(fp); return true; } });
		registerReadBridge(deps);

		(globalThis as any)[READ_BRIDGE_KEY].recordRead({
			filePath: "/project/checked.ts",
			requestedOffset: 1,
			requestedLimit: 5,
			timestamp: 0,
		});

		expect(seen).toEqual(["/project/checked.ts"]);
	});

	it("second call to registerReadBridge is a no-op — first registration wins", () => {
		const first = makeDeps({ turnIndex: 1 });
		const second = makeDeps({ turnIndex: 99 });

		registerReadBridge(first);
		registerReadBridge(second);

		(globalThis as any)[READ_BRIDGE_KEY].recordRead({
			filePath: "/a.ts",
			requestedOffset: 1,
			requestedLimit: 10,
			timestamp: 0,
		});

		expect(first.fakeGuard.recordRead).toHaveBeenCalledOnce();
		expect(second.fakeGuard.recordRead).not.toHaveBeenCalled();
	});

	it("turnIndex and writeIndex are sampled at call-time, not registration-time", () => {
		let turn = 0;
		let write = 0;
		const fakeGuard = { recordRead: vi.fn() };

		registerReadBridge({
			getReadGuard: () => fakeGuard,
			getTurnIndex: () => turn,
			peekWriteIndex: () => write,
			isRecordable: () => true,
		});

		const bridge = (globalThis as any)[READ_BRIDGE_KEY];

		turn = 5; write = 2;
		bridge.recordRead({ filePath: "/a.ts", requestedOffset: 1, requestedLimit: 1, timestamp: 0 });
		expect(fakeGuard.recordRead.mock.calls[0][0].turnIndex).toBe(5);
		expect(fakeGuard.recordRead.mock.calls[0][0].writeIndex).toBe(2);

		turn = 9; write = 4;
		bridge.recordRead({ filePath: "/b.ts", requestedOffset: 1, requestedLimit: 1, timestamp: 0 });
		expect(fakeGuard.recordRead.mock.calls[1][0].turnIndex).toBe(9);
		expect(fakeGuard.recordRead.mock.calls[1][0].writeIndex).toBe(4);
	});
});
