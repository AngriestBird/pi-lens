/**
 * #1913: `read_cap_trimmed` must survive `read-guard-logger`'s verbosity
 * gate at DEFAULT verbosity (PI_LENS_READ_GUARD_VERBOSE unset), while the
 * per-read `read_recorded` event stays gated as before.
 */
import { describe, expect, it } from "vitest";
import { shouldLogEvent } from "../../clients/read-guard-logger.js";

describe("shouldLogEvent", () => {
	it("always logs read_cap_trimmed, even at default verbosity", () => {
		expect(shouldLogEvent("read_cap_trimmed")).toBe(true);
	});

	// #1918: read_cap_trimmed's population siblings. read-guard.test.ts mocks
	// read-guard-logger.js wholesale, so it can't see this gate at all — this
	// file is the only place a dropped always-on arm reds.
	it("always logs read_file_evicted, even at default verbosity", () => {
		expect(shouldLogEvent("read_file_evicted")).toBe(true);
	});

	it("always logs edits_cap_trimmed, even at default verbosity", () => {
		expect(shouldLogEvent("edits_cap_trimmed")).toBe(true);
	});

	it("keeps read_recorded gated behind verbose mode", () => {
		expect(shouldLogEvent("read_recorded")).toBe(false);
	});

	it("still logs the pre-existing always-on events", () => {
		expect(shouldLogEvent("edit_blocked")).toBe(true);
	});
});
