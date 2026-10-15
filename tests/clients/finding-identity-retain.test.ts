/**
 * #4484 round 3 (R3): a recorded finding is kept by an observation only of
 * the same identity at its own position.
 *
 * Recurrence it prevents: identity alone let an untouched occurrence of the
 * same rule keep a fixed blocker alive and hold the commit gate shut on a line
 * the agent never touched (review F1, TLC MutTwinIdentity).
 */
import { describe, expect, it } from "vitest";
import { retainRecordedFindings } from "../../clients/finding-identity.js";

type F = { tool: string; rule: string; message: string; line: number };
const f = (line: number, message = "returns unknown"): F => ({
	tool: "ast-grep-napi",
	rule: "no-unknown-returns",
	message,
	line,
});
const never = () => false;

describe("retainRecordedFindings", () => {
	it("retires a fixed finding although the same rule still matches elsewhere", () => {
		const fixed = f(6);
		const untouched = f(3);
		const { kept, retired } = retainRecordedFindings([fixed], [untouched], {
			positionOf: (d) => d.line,
			keepUnobserved: never,
		});
		expect(kept).toEqual([]);
		expect(retired).toEqual([fixed]);
	});

	it("keeps a moved finding as its observed copy at the mapped line", () => {
		const recorded = f(6);
		const observed = f(7);
		const { kept } = retainRecordedFindings([recorded], [f(4), observed], {
			positionOf: (d) => d.line + 1,
			keepUnobserved: never,
		});
		expect(kept).toEqual([observed]);
		expect(kept[0]).toBe(observed);
	});

	it("matches nothing for a finding whose line was edited", () => {
		const recorded = f(6);
		const { kept, retired } = retainRecordedFindings([recorded], [f(6)], {
			positionOf: () => undefined,
			keepUnobserved: never,
		});
		expect(kept).toEqual([]);
		expect(retired).toEqual([recorded]);
	});

	it("keeps an unmatched finding whose source reached no verdict", () => {
		const recorded = f(6);
		const { kept } = retainRecordedFindings([recorded], [], {
			positionOf: (d) => d.line,
			keepUnobserved: () => true,
		});
		expect(kept).toEqual([recorded]);
	});

	// helm-lint cites its own line in the message: after an edit above it the
	// message changes with the line, and the moved finding must still match.
	it("folds the digits of a message that cites its own line", () => {
		const recorded = f(4, "deploy.yaml:4: nil pointer");
		const observed = f(5, "deploy.yaml:5: nil pointer");
		const { kept } = retainRecordedFindings([recorded], [observed], {
			positionOf: (d) => d.line + 1,
			keepUnobserved: never,
		});
		expect(kept).toEqual([observed]);
	});

	it("does not let a different message at the same line stand in", () => {
		const recorded = f(2, "Cannot find name 'BAD_CALL'.");
		const { kept } = retainRecordedFindings(
			[recorded],
			[f(2, "Cannot find name 'BAD_OTHER'.")],
			{ positionOf: (d) => d.line, keepUnobserved: never },
		);
		expect(kept).toEqual([]);
	});
});
