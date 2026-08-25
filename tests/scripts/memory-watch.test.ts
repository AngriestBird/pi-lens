import { describe, expect, it } from "vitest";
import {
	formatVerdict,
	parseMeminfo,
	shouldPrint,
} from "../../scripts/lib/memory-watch.mjs";

const MEMINFO = [
	"MemTotal:       16376464 kB",
	"MemFree:          204908 kB",
	"MemAvailable:    9481512 kB",
	"Buffers:          151876 kB",
	"Cached:          8724180 kB",
].join("\n");

describe("memory watch sampling (#2042)", () => {
	it("reads MemAvailable, not MemFree", () => {
		// MemFree excludes reclaimable page cache and reads alarmingly low on a
		// healthy runner. MemAvailable is the number that tracks real pressure, so
		// reading the wrong field would make every sample look like an emergency.
		const sample = parseMeminfo(MEMINFO);
		expect(sample.totalMb).toBe(Math.round(16_376_464 / 1024));
		expect(sample.availableMb).toBe(Math.round(9_481_512 / 1024));
		expect(sample.availableMb).not.toBe(Math.round(204_908 / 1024));
	});

	it("refuses to invent numbers from an unparseable meminfo", () => {
		expect(() => parseMeminfo("MemTotal: not-a-number\n")).toThrow();
	});
});

describe("memory watch print policy (#2042)", () => {
	const state = (lastPrintedMb: number | null) => ({
		lastPrintedMb,
		thresholdMb: 1024,
		stepMb: 1024,
	});

	it("always prints the first sample", () => {
		expect(shouldPrint({ availableMb: 12_000 }, state(null))).toBe(true);
	});

	it("stays quiet while memory is plentiful and steady", () => {
		// A line every two seconds for a five-minute suite would bury the test
		// output it is meant to annotate.
		expect(shouldPrint({ availableMb: 11_800 }, state(12_000))).toBe(false);
	});

	it("prints once memory falls a full step", () => {
		expect(shouldPrint({ availableMb: 10_900 }, state(12_000))).toBe(true);
	});

	it("prints every sample below the low-water threshold", () => {
		// Past the threshold each sample is evidence: the last one before a kill
		// is the whole point of the watch.
		expect(shouldPrint({ availableMb: 900 }, state(1000))).toBe(true);
	});
});

describe("memory watch verdict (#2042)", () => {
	const watch = { totalMb: 15_992, lowWaterMb: 143, lowWaterAt: "20:09:27" };

	it("calls a SIGKILL what it is, with the low-water mark", () => {
		const line = formatVerdict({ code: null, signal: "SIGKILL" }, watch);
		expect(line).toContain("KILLED");
		expect(line).toContain("no failing assertion");
		expect(line).toContain("lowWaterAvailableMb=143");
		expect(line).toContain("lowWaterAt=20:09:27");
	});

	it("treats a bare exit 137 as the same shape", () => {
		// A shell between the wrapper and the killed process reports 137 rather
		// than forwarding the signal; both must reach the same verdict.
		expect(formatVerdict({ code: 137, signal: null }, watch)).toContain(
			"KILLED",
		);
	});

	it("does not cry OOM over an ordinary test failure", () => {
		const line = formatVerdict({ code: 1, signal: null }, watch);
		expect(line).not.toContain("KILLED");
		expect(line).toContain("exitCode=1");
	});

	it("reports the low-water mark on success too", () => {
		// The headroom on a passing run is what says whether the next one is safe.
		const line = formatVerdict({ code: 0, signal: null }, watch);
		expect(line).toContain("lowWaterAvailableMb=143");
	});
});
