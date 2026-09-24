import { describe, expect, it, vi } from "vitest";
import { writeTmpHygieneLeakNotice } from "./vitest-setup.js";

describe("worker console channel (#3128)", () => {
	it("writes tmp-hygiene leak notices to stderr with a newline", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			writeTmpHygieneLeakNotice("/tmp/pi-lens-hygiene", 3);
			expect(write).toHaveBeenCalledTimes(1);
			const message = String(write.mock.calls[0]?.[0]);
			expect(message).toContain("3 unadmitted entry(s)");
			expect(message.endsWith("\n")).toBe(true);
		} finally {
			write.mockRestore();
		}
	});
});
