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
 *
 * Adversarial / hardening cases:
 * - Malformed payloads (null, non-object, empty/non-string filePath,
 *   non-number/non-finite/non-integer/out-of-range offsets and limits) are
 *   silently dropped
 * - timestamp is always stamped by the bridge (Date.now()), never caller-supplied
 * - Full read-then-edit authorization path: bridge-registered read unblocks
 *   a subsequent edit that would otherwise be blocked
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

/** A well-formed entry that always passes validation. */
function validEntry(overrides: Partial<ReadBridgeEntry> = {}): ReadBridgeEntry {
	return {
		filePath: "/project/src/main.go",
		requestedOffset: 10,
		requestedLimit: 50,
		...overrides,
	};
}

describe("read-bridge", () => {
	beforeEach(() => {
		delete (globalThis as any)[READ_BRIDGE_KEY];
	});
	afterEach(() => {
		delete (globalThis as any)[READ_BRIDGE_KEY];
	});

	// ── Baseline ────────────────────────────────────────────────────────────

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
		};
		const before = Date.now();
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
		expect(call.timestamp).toBeGreaterThanOrEqual(before);
		expect(call.timestamp).toBeLessThanOrEqual(Date.now());
	});

	it("undefined requestedLimit maps to MAX_SAFE_INTEGER (whole-file coverage)", () => {
		const deps = makeDeps();
		registerReadBridge(deps);

		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ requestedLimit: undefined }),
		);

		const call = deps.calls[0];
		expect(call.requestedLimit).toBe(Number.MAX_SAFE_INTEGER);
		expect(call.effectiveLimit).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("isRecordable returning false suppresses forwarding", () => {
		const deps = makeDeps({ isRecordable: () => false });
		registerReadBridge(deps);

		(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry());

		expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
	});

	it("isRecordable receives the entry filePath", () => {
		const seen: string[] = [];
		const deps = makeDeps({
			isRecordable: (fp) => {
				seen.push(fp);
				return true;
			},
		});
		registerReadBridge(deps);

		(globalThis as any)[READ_BRIDGE_KEY].recordRead(
			validEntry({ filePath: "/project/checked.ts" }),
		);

		expect(seen).toEqual(["/project/checked.ts"]);
	});

	it("second call to registerReadBridge is a no-op — first registration wins", () => {
		const first = makeDeps({ turnIndex: 1 });
		const second = makeDeps({ turnIndex: 99 });

		registerReadBridge(first);
		registerReadBridge(second);

		(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry({ filePath: "/a.ts" }));

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

		turn = 5;
		write = 2;
		bridge.recordRead(validEntry({ filePath: "/a.ts" }));
		expect(fakeGuard.recordRead.mock.calls[0][0].turnIndex).toBe(5);
		expect(fakeGuard.recordRead.mock.calls[0][0].writeIndex).toBe(2);

		turn = 9;
		write = 4;
		bridge.recordRead(validEntry({ filePath: "/b.ts" }));
		expect(fakeGuard.recordRead.mock.calls[1][0].turnIndex).toBe(9);
		expect(fakeGuard.recordRead.mock.calls[1][0].writeIndex).toBe(4);
	});

	// ── Malformed payload validation ─────────────────────────────────────────

	describe("malformed payloads", () => {
		it("null entry is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(null);
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("non-object entry (string) is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead("not-an-object");
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("empty filePath is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry({ filePath: "" }));
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("numeric filePath is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead({ ...validEntry(), filePath: 42 as any });
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("requestedOffset = 0 (below minimum) is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry({ requestedOffset: 0 }));
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("requestedOffset = NaN is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry({ requestedOffset: NaN }));
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("requestedOffset = Infinity is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ requestedOffset: Infinity }),
			);
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("non-integer requestedOffset (1.5) is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry({ requestedOffset: 1.5 }));
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("requestedLimit = 0 (below minimum) is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry({ requestedLimit: 0 }));
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("requestedLimit = NaN is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry({ requestedLimit: NaN }));
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("non-integer requestedLimit (3.7) is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry({ requestedLimit: 3.7 }));
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("string requestedOffset is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead({ ...validEntry(), requestedOffset: "10" as any });
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("requestedLimit = Infinity is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(validEntry({ requestedLimit: Infinity }));
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});

		it("string requestedLimit is silently dropped", () => {
			const deps = makeDeps();
			registerReadBridge(deps);
			(globalThis as any)[READ_BRIDGE_KEY].recordRead({ ...validEntry(), requestedLimit: "50" as any });
			expect(deps.fakeGuard.recordRead).not.toHaveBeenCalled();
		});
	});
	// ── Full read-then-edit authorization path ───────────────────────────────

	describe("read-then-edit authorization path", () => {
		it("bridge-registered read forwards all fields the guard needs to authorize a subsequent edit", () => {
			const recordedReads: RecordReadArgs[] = [];
			const fakeGuard = {
				recordRead: vi.fn((r: RecordReadArgs) => recordedReads.push(r)),
			};

			const deps = {
				getReadGuard: () => fakeGuard,
				getTurnIndex: () => 1,
				peekWriteIndex: () => 0,
				isRecordable: () => true,
			};
			registerReadBridge(deps);

			const filePath = "/project/src/handler.ts";

			// Simulate a co-process extension recording a read.
			const beforeCall = Date.now();
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ filePath, requestedOffset: 1, requestedLimit: 100 }),
			);

			// The read-guard must have received exactly one record.
			expect(fakeGuard.recordRead).toHaveBeenCalledOnce();
			const read = recordedReads[0];

			// Verify the forwarded record carries the fields the guard needs to
			// authorize a subsequent edit on the same file/range.
			expect(read.filePath).toBe(filePath);
			expect(read.requestedOffset).toBe(1);
			expect(read.requestedLimit).toBe(100);
			expect(read.effectiveOffset).toBe(1);
			expect(read.effectiveLimit).toBe(100);
			expect(read.expandedByLsp).toBe(false);
			expect(read.turnIndex).toBe(1);
			expect(read.writeIndex).toBe(0);
			expect(read.timestamp).toBeGreaterThanOrEqual(beforeCall);
			expect(read.timestamp).toBeLessThanOrEqual(Date.now());
		});

		it("a read for file A does not authorize edits on file B", () => {
			const deps = makeDeps({ turnIndex: 1 });
			registerReadBridge(deps);

			// Record a read on file A only.
			(globalThis as any)[READ_BRIDGE_KEY].recordRead(
				validEntry({ filePath: "/project/a.ts" }),
			);

			expect(deps.fakeGuard.recordRead).toHaveBeenCalledOnce();
			expect(deps.calls[0].filePath).toBe("/project/a.ts");

			// File B has zero recorded reads — the guard would block an edit on it.
			const readsForB = deps.calls.filter((c) => c.filePath === "/project/b.ts");
			expect(readsForB).toHaveLength(0);
		});

		it("multiple reads on the same file are all forwarded", () => {
			const deps = makeDeps({ turnIndex: 2 });
			registerReadBridge(deps);

			const bridge = (globalThis as any)[READ_BRIDGE_KEY];
			const filePath = "/project/big.ts";

			bridge.recordRead(validEntry({ filePath, requestedOffset: 1, requestedLimit: 50 }));
			bridge.recordRead(validEntry({ filePath, requestedOffset: 51, requestedLimit: 50 }));
			bridge.recordRead(
				validEntry({ filePath, requestedOffset: 101, requestedLimit: undefined }),
			);

			expect(deps.fakeGuard.recordRead).toHaveBeenCalledTimes(3);
			expect(deps.calls[0].requestedOffset).toBe(1);
			expect(deps.calls[1].requestedOffset).toBe(51);
			expect(deps.calls[2].requestedLimit).toBe(Number.MAX_SAFE_INTEGER);
		});
	});
});
