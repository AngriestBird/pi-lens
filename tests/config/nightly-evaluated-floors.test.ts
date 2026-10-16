import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	EVALUATED_DIR_ENV,
	EVALUATED_PRODUCERS,
} from "../../scripts/lib/assert-evaluated.mjs";
import { stripSource } from "../support/sweep-kit.js";

// Recurrence #4514 (retro P2): the four best-effort LSP producers exit 0 under
// continue-on-error, so the nightly read green while 41 captured servers fell
// to 16. A floor is a MEASURED constant: its measuring command and raw output
// are tracked (tests/fixtures/nightly-floors/measurements.json) and this file
// pins each floor between the degraded and the healthy measurement, so a floor
// raised past what a healthy runner reaches (a nightly red forever) and a
// floor lowered under the degraded night (a gate that would not have fired)
// both red here. It also pins the wiring: a producer that stops reporting, a
// floor step made continue-on-error, and a refresh PR that no longer asks
// whether the night evaluated anything.
const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
const measurements = JSON.parse(
	read("tests/fixtures/nightly-floors/measurements.json"),
) as {
	producers: Record<
		string,
		Record<"healthy" | "degraded", { evaluated: number; lines: string[] }>
	>;
	lspHandshake: Record<
		"healthy" | "degraded",
		{ passed: number; line: string }
	>;
};

const lastInt = (line: string) => Number(/(\d+)\s*$/.exec(line)?.[1]);
/** How each producer's own log lines add up to the count it records. */
const EXTRACT: Record<string, (lines: string[]) => number> = {
	"characterize-lsp": (lines) => lines.map(lastInt).reduce((a, b) => a + b, 0),
	"probe-clean-signal": (lines) =>
		lines.map(lastInt).reduce((a, b) => a + b, 0),
	"server-capabilities": ([line]) =>
		Number(/\((\d+) servers captured/.exec(line)?.[1]),
	"measure-lsp-idle-eviction": ([line]) => {
		const m = /(\d+) registry servers: .*?(\d+) unavailable/.exec(line);
		return Number(m?.[1]) - Number(m?.[2]);
	},
};

describe("nightly evaluated floors are measured, not guessed (#4514)", () => {
	it("registers exactly the producers that have a measurement", () => {
		expect(Object.keys(EVALUATED_PRODUCERS).sort()).toEqual(
			Object.keys(measurements.producers).sort(),
		);
		expect(Object.keys(EXTRACT).sort()).toEqual(
			Object.keys(EVALUATED_PRODUCERS).sort(),
		);
	});

	describe.each(Object.keys(EVALUATED_PRODUCERS))("%s", (producer) => {
		const spec = EVALUATED_PRODUCERS[producer];
		const { healthy, degraded } = measurements.producers[producer];

		it("derives each measurement's count from its raw log lines", () => {
			expect(EXTRACT[producer](healthy.lines)).toBe(healthy.evaluated);
			expect(EXTRACT[producer](degraded.lines)).toBe(degraded.evaluated);
		});

		it("sits above the degraded night and at or below the healthy one", () => {
			expect(spec.floor).toBeGreaterThan(degraded.evaluated);
			expect(spec.floor).toBeLessThanOrEqual(healthy.evaluated);
		});

		// A doc floor of 1 is the matrix's "not emptied" guard, a different unit.
		const docFloor = spec.doc && spec.doc.floor > 1 ? spec.doc.floor : 0;
		it.skipIf(docFloor === 0)(
			"holds a doc floor in the same band where the doc count is the same unit",
			() => {
				expect(docFloor).toBeGreaterThan(degraded.evaluated);
				expect(docFloor).toBeLessThanOrEqual(healthy.evaluated);
			},
		);

		it("is reported by its own script", () => {
			const code = stripSource(read(`scripts/${producer}.mjs`), {
				strings: "keep",
			});
			expect(code).toMatch(
				new RegExp(`writeEvaluatedRecord\\(\\{\\s*producer:\\s*"${producer}"`),
			);
		});
	});
});

type Step = {
	name?: string;
	id?: string;
	if?: string;
	run?: string;
	uses?: string;
	"continue-on-error"?: unknown;
	"timeout-minutes"?: unknown;
};
type Job = {
	env?: Record<string, string>;
	steps?: Step[];
	outputs?: Record<string, string>;
};
const workflow = yaml.load(read(".github/workflows/tool-smoke.yml")) as {
	jobs: Record<string, Job>;
};
const smoke = workflow.jobs["tool-smoke"];
const prs = workflow.jobs["tool-smoke-prs"];
const step = (job: Job, needle: string) => {
	const found = (job.steps ?? []).find((s) => s.name?.includes(needle));
	if (!found) throw new Error(`no step named like "${needle}"`);
	return found;
};

describe("the floor step and the refresh guard are wired and gating (#4514)", () => {
	it("runs the floor as a step that cannot be continue-on-error, after every producer and layer", () => {
		const steps = smoke.steps ?? [];
		const floor = step(smoke, "LSP evaluated floor");
		expect(floor["continue-on-error"]).toBeUndefined();
		expect(floor.id).toBe("evaluated_floor");
		expect(floor.run).toContain("scripts/assert-evaluated.mjs --records");
		expect(floor.run).toMatch(/^\s*set -o pipefail\s*$/m);
		const at = (name: string) => steps.indexOf(step(smoke, name));
		for (const earlier of [
			"LSP capability matrix",
			"LSP clean-signal probe",
			"LSP server capability inventory",
			"LSP idle-eviction measurement",
			"Resolution layer",
		])
			expect(at("LSP evaluated floor"), earlier).toBeGreaterThan(at(earlier));
	});

	it("names the records directory once, in the job env the producers and the floor step share", () => {
		const dir = smoke.env?.[EVALUATED_DIR_ENV];
		expect(dir).toBeTruthy();
		expect(step(smoke, "LSP evaluated floor").run).toContain(
			`"$${EVALUATED_DIR_ENV}"`,
		);
	});

	it("keeps the four producers best-effort (the floor, not them, carries the verdict)", () => {
		for (const name of [
			"LSP capability matrix",
			"LSP clean-signal probe",
			"LSP server capability inventory",
			"LSP idle-eviction measurement",
		])
			expect(step(smoke, name)["continue-on-error"], name).toBe(true);
	});

	it("gives the LSP handshake a --min-pass at or below what a healthy and a degraded night both passed", () => {
		const floor = Number(
			/--min-pass=(\d+)/.exec(
				step(smoke, "LSP handshake layer").run ?? "",
			)?.[1],
		);
		expect(floor).toBeGreaterThan(0);
		for (const night of ["healthy", "degraded"] as const)
			expect(floor).toBeLessThanOrEqual(
				measurements.lspHandshake[night].passed,
			);
		for (const night of ["healthy", "degraded"] as const)
			expect(measurements.lspHandshake[night].line).toContain(
				`${measurements.lspHandshake[night].passed} passed`,
			);
	});

	it("passes --min-pass from main() into the handshake layer (call-site pin)", () => {
		const code = stripSource(read("scripts/smoke-tools.mjs"), {
			strings: "blank",
		});
		expect(code).toMatch(
			/runLspHandshake\(\{\s*langs,\s*install,\s*verbose,\s*minPass\s*\}\)/,
		);
	});

	it("opens no refresh PR before the regenerated docs are checked against HEAD", () => {
		const steps = prs.steps ?? [];
		const guard = step(prs, "Refuse a degraded refresh");
		expect(guard["continue-on-error"]).toBeUndefined();
		expect(guard.run).toContain("scripts/assert-evaluated.mjs --docs");
		const guardAt = steps.indexOf(guard);
		expect(guardAt).toBeGreaterThan(steps.indexOf(step(prs, "Overlay")));
		for (const open of [
			"Open/update LSP-docs refresh PR",
			"Open/update idle-eviction promotion PR",
		])
			expect(steps.indexOf(step(prs, open)), open).toBeGreaterThan(guardAt);
	});
});
