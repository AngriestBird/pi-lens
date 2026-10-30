// #1712: the nightly live cascade lane is a step of tool-smoke.yml, not a new
// workflow. These pins read the REAL workflow (yaml.load, never a restated copy)
// and the fixture table, because the lane's value is that it actually runs
// every night and that a server that never concludes reds it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	CASCADE_CONCLUSIVE_DEADLINE_MS,
	CASCADE_FIXTURES,
	CASCADE_WARM_DEADLINE_MS,
} from "../../scripts/lib/lsp-cascade-smoke.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
type Step = {
	name?: string;
	id?: string;
	uses?: string;
	if?: unknown;
	run?: string;
	"continue-on-error"?: unknown;
	"timeout-minutes"?: number;
	with?: Record<string, unknown>;
};
type Workflow = {
	jobs: Record<string, { "timeout-minutes"?: number; steps: Step[] }>;
};
const workflow = yaml.load(
	readFileSync(resolve(REPO_ROOT, ".github/workflows/tool-smoke.yml"), "utf8"),
) as Workflow;
const steps = workflow.jobs["tool-smoke"].steps;
const at = (id: string) => steps.findIndex((s) => s.id === id);
const cascade = steps[at("lsp_cascade")];

describe("tool-smoke.yml carries the live cascade lane (#1712)", () => {
	it("runs the cascade layer, installing servers, as a gating step", () => {
		// Recurrence: #4495 shipped the live cascade test behind
		// PI_LENS_INTEGRATION=1, which CI never sets, so nothing ran it.
		expect(cascade.run).toMatch(/smoke-tools\.mjs --lsp-cascade --install\b/);
		// A continue-on-error would let a server that never concludes pass the job.
		expect(cascade["continue-on-error"]).not.toBe(true);
	});

	it("reads the handshake census it follows (same PI_LENS_HOME, later step)", () => {
		// The lane tells a server that never handshook (warning) from one that
		// handshook and then never concluded (red) through the census file the
		// handshake step leaves in the job's shared PI_LENS_HOME.
		expect(at("lsp_cascade")).toBeGreaterThan(at("lsp_handshake"));
	});

	it("keeps the exit status of node through the tee", () => {
		expect(cascade.run).toMatch(/^\s*set -o pipefail\s*$/m);
	});

	it("floors the pass count so an all-unavailable night cannot read green", () => {
		// Recurrence: #4514, a layer that evaluated nothing read green for days.
		expect(cascade.run).toMatch(/--min-pass=[1-9]\d*\b/);
	});

	it("uploads the file the lane writes as its time-to-conclusive telemetry", () => {
		const written = /--times-out="\$RUNNER_TEMP\/([^"]+)"/.exec(
			cascade.run ?? "",
		)?.[1];
		expect(written).toBeTruthy();
		const upload = steps[at("lsp_cascade") + 1];
		expect(upload.uses).toContain("actions/upload-artifact@");
		expect(upload.if).toBe("always()");
		expect(upload.with?.path).toBe(`\${{ runner.temp }}/${written}`);
	});

	it("bounds the lane below the job cap with the worst case of every fixture inside it", () => {
		// Recurrence: #3123, a hang costing the GitHub default. The worst case is
		// each fixture's warm-up plus its conclusive deadline; a 5-minute margin
		// covers installs the tool-tree cache did not restore.
		const stepCap = (cascade["timeout-minutes"] ?? Infinity) * 60_000;
		const jobCap =
			(workflow.jobs["tool-smoke"]["timeout-minutes"] ?? 0) * 60_000;
		const worst = CASCADE_FIXTURES.reduce(
			(sum, f) =>
				sum +
				(f.warmDeadlineMs ?? CASCADE_WARM_DEADLINE_MS) +
				(f.conclusiveDeadlineMs ?? CASCADE_CONCLUSIVE_DEADLINE_MS),
			0,
		);
		expect(stepCap).toBeLessThan(jobCap);
		expect(worst + 5 * 60_000).toBeLessThanOrEqual(stepCap);
	});
});
