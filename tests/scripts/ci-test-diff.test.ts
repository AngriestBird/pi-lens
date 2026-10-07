import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	compareFailureSets,
	extractFailingTestIds,
	stripLogDecorations,
} from "../../scripts/ci-test-diff.mjs";

const fixture = (name: string) =>
	fs.readFileSync(path.join("tests/fixtures/ci-test-diff", name), "utf8");

describe("ci-test-diff failure extraction", () => {
	// Recurrence: #4072's Windows logs contain ANSI, CRLF, and Actions timestamps;
	// the tool must compare test identities rather than the aggregate failure count.
	it("reproduces the 7 fixed / 7 new / 51 unchanged witness", () => {
		const master = extractFailingTestIds(
			stripLogDecorations(fixture("job-112724408671.log")),
		);
		const round2 = extractFailingTestIds(
			stripLogDecorations(fixture("job-112734370876.log")),
		);
		const diff = compareFailureSets(master, round2);

		expect(master).toHaveLength(58);
		expect(round2).toHaveLength(58);
		expect(diff.fixed).toHaveLength(7);
		expect(diff.newFailures).toHaveLength(7);
		expect(diff.unchanged).toHaveLength(51);
	});

	it("normalizes Actions timestamps and terminal decoration", () => {
		const raw =
			"2026-10-07T00:00:00.000Z \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default  tests/a.test.ts\r\n";
		expect(stripLogDecorations(raw)).toBe("FAIL  default  tests/a.test.ts\n");
	});
});
