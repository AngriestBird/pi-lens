// Prevents the install-smoke regression from run 34880209347: pnpm 11.15.1
// reads the checkout's `packageManager: npm@...` when global-bin setup is
// project-scoped, so the pnpm global install coverage fails before pi starts.
//
// #3043: and prevents run 35013232780's regression, which THIS file (as
// written by #3033) could not see, because it asserted the broken command's
// literal text. pnpm 11 resolves the global bin directory as
// `globalBinDir ?? path.join(pnpmHomeDir, "bin")` with `pnpmHomeDir` =
// $PNPM_HOME (pnpm/config/reader's checkGlobalBinDir, verified against
// pnpm 11.15.1 and 11.21.0 -- the two versions this workflow installs), and
// refuses EVERY `--global` command whose resolved bin dir is not already on
// PATH:
//
//   + export PATH=/home/runner/.pnpm-global:...
//   + pnpm config set --global global-bin-dir /home/runner/.pnpm-global
//   [ERROR] The configured global bin directory
//           "/home/runner/.pnpm-global/bin" is not in PATH
//
// So the contract below is not "this literal command appears" but "every
// place the step names the pnpm global bin directory names the SAME directory
// pnpm resolves" -- $PNPM_HOME/bin, in the PATH export, in the configured
// value, and in the GITHUB_PATH entry later steps inherit.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = ".github/workflows/install-smoke.yml";

type Step = { name?: unknown; run?: unknown; uses?: unknown; if?: unknown };
type NamedStep = Step & { name: string };
type Job = {
	steps?: unknown;
	strategy?: { matrix?: Record<string, unknown> };
};
type Workflow = { jobs?: Record<string, Job> };

function loadWorkflow(source?: string): Workflow {
	const text =
		source ?? readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
	return yaml.load(text) as Workflow;
}

function stepsFor(workflow: Workflow, jobName: string): Step[] {
	const steps = workflow.jobs?.[jobName]?.steps;
	return Array.isArray(steps) ? (steps as Step[]) : [];
}

function namedSteps(workflow: Workflow, jobName: string): NamedStep[] {
	return stepsFor(workflow, jobName).filter(
		(step): step is NamedStep => typeof step.name === "string",
	);
}

function stepIndex(workflow: Workflow, jobName: string, name: string): number {
	const index = namedSteps(workflow, jobName).findIndex((step) =>
		step.name.includes(name),
	);
	if (index < 0) throw new Error(`${jobName} has no step named like ${name}`);
	return index;
}

function stepRun(workflow: Workflow, jobName: string, name: string): string {
	const step = namedSteps(workflow, jobName).find((candidate) =>
		candidate.name.includes(name),
	);
	if (typeof step?.run !== "string") {
		throw new Error(`${jobName} step ${name} has no run script`);
	}
	return step.run;
}

function executableLines(script: string): string[] {
	return script
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function caseArm(script: string, label: string): string {
	const lines = script.split("\n");
	const start = lines.findIndex((line) => line.trim() === `${label})`);
	if (start < 0) throw new Error(`script has no ${label} case arm`);
	const end = lines.findIndex(
		(line, index) => index > start && /^\s*[a-z][a-z-]*\)\s*$/.test(line),
	);
	return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

// Every directory this snippet treats as "pnpm's global bin dir", read off
// the REAL step text: the PATH entry it prepends, the value it writes with
// `pnpm config set --global global-bin-dir`, and the entry it hands to later
// steps through GITHUB_PATH. Missing pieces stay `undefined` so the caller
// reds with the whole picture rather than a thrown regex error.
type PnpmGlobalBinFacts = {
	pnpmHome?: string;
	pathEntry?: string;
	configuredBinDir?: string;
	githubPathEntry?: string;
};

function pnpmGlobalBinFacts(script: string): PnpmGlobalBinFacts {
	const text = executableLines(script).join("\n");
	return {
		pnpmHome: text.match(/export PNPM_HOME="([^"]+)"/)?.[1],
		pathEntry: text.match(/export PATH="([^":]+):\$PATH"/)?.[1],
		configuredBinDir: text.match(
			/pnpm config set --global global-bin-dir "([^"]+)"/,
		)?.[1],
		githubPathEntry: text.match(/echo "([^"]+)" >> "\$GITHUB_PATH"/)?.[1],
	};
}

// The invariant #3043 broke: pnpm 11 will resolve `$PNPM_HOME/bin`, so the
// PATH entry, the configured value and the GITHUB_PATH entry must all BE
// `$PNPM_HOME/bin`. Any one of them reverting to bare `$PNPM_HOME` is the
// exact shape that failed all six pnpm cells of run 35013232780.
function assertGlobalBinDirAgreesWithPnpm(
	script: string,
	label: string,
): void {
	const facts = pnpmGlobalBinFacts(script);
	const pnpmHome = facts.pnpmHome;
	expect(pnpmHome, `${label}: no PNPM_HOME export`).toBeDefined();
	// Compare DIRECTORIES, not spellings: `$PNPM_HOME/bin` and the literal
	// `$HOME/.pnpm-global/bin` are the same directory to the shell.
	const expand = (value?: string): string | undefined =>
		value?.replace("$PNPM_HOME", String(pnpmHome));
	const resolvedByPnpm = `${pnpmHome}/bin`;
	expect({
		label,
		pathEntry: expand(facts.pathEntry),
		configuredBinDir: expand(facts.configuredBinDir),
		githubPathEntry: expand(facts.githubPathEntry),
	}).toEqual({
		label,
		pathEntry: resolvedByPnpm,
		configuredBinDir: resolvedByPnpm,
		githubPathEntry: resolvedByPnpm,
	});
}

function assertPnpmInstallPath(workflow: Workflow, jobName: string): void {
	const job = workflow.jobs?.[jobName];
	const matrix = job?.strategy?.matrix;
	if (jobName === "pi-load") {
		// #3043: `pi_install` is now an event-dependent expression (one
		// pnpm-global cell on pull_request, the full list otherwise). Its
		// per-event populations are asserted ONCE, by evaluating the real
		// expression, in tests/config/install-smoke-gates.test.ts -- restating
		// them here would be a second copy of the same table.
		const setup = stepIndex(workflow, jobName, "Setup pnpm");
		const install = stepIndex(workflow, jobName, "Install pi");
		expect(stepIndex(workflow, jobName, "Setup Node")).toBeLessThan(setup);
		expect(setup).toBeLessThan(install);
		const installScript = stepRun(workflow, jobName, "Install pi");
		const pnpmInstallLines = executableLines(
			caseArm(installScript, "pnpm-global"),
		).join("\n");
		expect(pnpmInstallLines).toContain("pnpm-global)");
		assertGlobalBinDirAgreesWithPnpm(pnpmInstallLines, "pi-load pnpm-global");
		// #3032's half of the contract: the write stays GLOBAL (a project-scoped
		// one dies on the checkout's `packageManager: npm@...`).
		expect(pnpmInstallLines).toContain("pnpm config set --global");
		expect(pnpmInstallLines).toContain('pnpm add -g --ignore-scripts "$PKG"');
		expect(pnpmInstallLines).toContain('echo "NPMCMD=pnpm" >> "$GITHUB_ENV"');
	} else {
		expect(matrix?.os).toEqual(["ubuntu-latest", "macos-latest"]);
		expect(matrix?.pi_via).toEqual(["mise-node", "mise-npm-backend"]);
		const installPnpm = stepIndex(workflow, jobName, "Install pnpm");
		const configure = stepIndex(workflow, jobName, "Configure pnpm global");
		expect(installPnpm).toBeLessThan(configure);
		const installPnpmLines = executableLines(
			stepRun(workflow, jobName, "Install pnpm"),
		).join("\n");
		expect(installPnpmLines).toContain(
			"npm install -g --ignore-scripts pnpm@11.15.1",
		);
		expect(installPnpmLines).toContain('cd "$RUNNER_TEMP"');
		expect(installPnpmLines).toContain("pnpm --version");
		expect(installPnpmLines.indexOf('cd "$RUNNER_TEMP"')).toBeLessThan(
			installPnpmLines.indexOf("pnpm --version"),
		);
		const configureLines = executableLines(
			stepRun(workflow, jobName, "Configure pnpm global"),
		).join("\n");
		assertGlobalBinDirAgreesWithPnpm(
			configureLines,
			"mise-repro Configure pnpm global bin dir",
		);
		// The `--global` scope is what #3032 fixed (a project-scoped write dies
		// on the checkout's `packageManager: npm@...`); pnpm 11.21.0 still
		// answers a --global write with "[WARN] Using --global skips the
		// package manager check for this project", so the scope stays pinned.
		expect(configureLines).toContain("pnpm config set --global");
	}

	const piConfigure = stepIndex(workflow, jobName, "Configure pi");
	const rpc = stepIndex(workflow, jobName, "Verify pi-lens loads via RPC");
	expect(piConfigure).toBeGreaterThan(
		stepIndex(workflow, jobName, "Install pi"),
	);
	expect(rpc).toBeGreaterThan(piConfigure);
	const piLines = executableLines(
		stepRun(workflow, jobName, "Configure pi"),
	).join("\n");
	expect(piLines).toContain(
		jobName === "pi-load"
			? "npmCommand:[process.env.NPMCMD]"
			: 'npmCommand:["pnpm"]',
	);
	expect(piLines).toContain("pi install npm:pi-lens");
	expect(piLines).toContain("pi list | grep -i 'pi-lens'");
	const rpcLines = executableLines(
		stepRun(workflow, jobName, "Verify pi-lens loads via RPC"),
	).join("\n");
	expect(rpcLines).toContain(
		'node "$GITHUB_WORKSPACE/scripts/rpc-load-check.mjs" "$(command -v pi)"',
	);
}

describe("install-smoke pnpm global-bin configuration", () => {
	const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
	const workflow = loadWorkflow(source);

	for (const jobName of ["pi-load", "mise-repro"] as const) {
		it(`covers the complete ${jobName} pnpm matrix path`, () => {
			assertPnpmInstallPath(workflow, jobName);
		});
	}
});
