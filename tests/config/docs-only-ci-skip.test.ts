import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { run as runChangedFiles } from "../../scripts/ci-changed-files.mjs";

// #3801: a docs-only pull request skips the heavy CI jobs, a single non-docs
// file runs everything, and no REQUIRED check can be absent or skipped. This
// evaluates the real ci.yml: each job's `needs` and `if`, each gated step's
// `if`, under the outputs the real classifier script produced for a diff.
// Every case names the recurrence it keeps out.

const ROOT = path.resolve(import.meta.dirname, "../..");

type Step = { name?: string; uses?: string; if?: string; run?: string };
type Job = {
	name?: string;
	needs?: string | string[];
	if?: string;
	strategy?: { matrix?: { os?: string[] } };
	steps?: Step[];
};
const CI = (
	yaml.load(
		fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
	) as {
		jobs: Record<string, Job>;
	}
).jobs;
const asList = (needs: Job["needs"]) =>
	Array.isArray(needs) ? needs : needs ? [needs] : [];

// ── a GitHub Actions `if:` evaluator for exactly the grammar ci.yml uses ─────
// Unknown syntax THROWS, so a new construct cannot be silently read as true.

type Ctx = {
	event: string;
	changes: { code: string; formal: string };
	results: Record<string, string>;
	outputs: Record<string, Record<string, string>>;
	matrixOs?: string;
};

function evaluate(expression: string, ctx: Ctx): boolean {
	const tokens = expression.match(
		/'[^']*'|&&|\|\||==|!=|!|\(|\)|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*/g,
	);
	if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) {
		throw new Error(`unsupported if: expression: ${expression}`);
	}
	let pos = 0;
	const peek = () => tokens[pos];
	const take = () => tokens[pos++];
	const value = (token: string): string | boolean => {
		if (token.startsWith("'")) return token.slice(1, -1);
		if (token === "always()") return true;
		if (token === "cancelled()") return false;
		if (token === "github.event_name") return ctx.event;
		if (token === "matrix.os") return ctx.matrixOs ?? "";
		let match = /^needs\.([\w-]+)\.result$/.exec(token);
		if (match) return ctx.results[match[1]] ?? "skipped";
		match = /^needs\.([\w-]+)\.outputs\.(\w+)$/.exec(token);
		if (match) return ctx.outputs[match[1]]?.[match[2]] ?? "";
		if (token === "github.event.pull_request.head.repo.full_name")
			return "apmantza/pi-lens";
		if (token === "github.repository") return "apmantza/pi-lens";
		throw new Error(`unsupported context in if: ${token}`);
	};
	function primary(): string | boolean {
		const token = take();
		if (token === "(") {
			const inner = or();
			if (take() !== ")") throw new Error("unbalanced parentheses");
			return inner;
		}
		if (token === "!") return !primary();
		return value(token);
	}
	function comparison(): string | boolean {
		const left = primary();
		if (peek() === "==" || peek() === "!=") {
			const op = take();
			const right = primary();
			return op === "==" ? left === right : left !== right;
		}
		return left;
	}
	function and(): string | boolean {
		let left = comparison();
		while (peek() === "&&") {
			take();
			const right = comparison();
			left = left ? right : left;
		}
		return left;
	}
	function or(): string | boolean {
		let left = and();
		while (peek() === "||") {
			take();
			const right = and();
			left = left ? left : right;
		}
		return left;
	}
	const result = or();
	if (pos !== tokens.length)
		throw new Error(`trailing tokens in: ${expression}`);
	return Boolean(result);
}

const hasStatusFunction = (expression: string) =>
	/\b(always|cancelled|failure|success)\(\)/.test(expression);

/** Run the job graph for one event and diff; every job that runs succeeds. */
function simulate(event: string, files: string[], gateReady = "true") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-docs-skip-"));
	const output = path.join(dir, "output");
	try {
		runChangedFiles(
			["--event", event, "--repo", "apmantza/pi-lens", "--pr", "1"],
			{
				env: { GITHUB_OUTPUT: output },
				fetchFiles: () => files,
				log: () => {},
			},
		);
		const changes = Object.fromEntries(
			fs
				.readFileSync(output, "utf8")
				.trim()
				.split("\n")
				.map((l) => l.split("=")),
		) as { code: string; formal: string };
		const results: Record<string, string> = {};
		const outputs: Record<string, Record<string, string>> = {
			changes,
			"heavy-gate": { ready: gateReady },
		};
		const remaining = Object.keys(CI);
		while (remaining.length) {
			const id = remaining.find((candidate) =>
				asList(CI[candidate].needs).every((need) => need in results),
			);
			if (!id) throw new Error("needs cycle");
			remaining.splice(remaining.indexOf(id), 1);
			const job = CI[id];
			const ctx: Ctx = { event, changes, results, outputs };
			let runs: boolean;
			if (job.if === undefined) {
				runs = asList(job.needs).every((need) => results[need] === "success");
			} else {
				runs =
					(hasStatusFunction(job.if)
						? true
						: asList(job.needs).every((need) => results[need] === "success")) &&
					evaluate(job.if, ctx);
			}
			results[id] = runs ? "success" : "skipped";
		}
		return { changes, results };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Which steps of a job run, per matrix leg (one leg for a plain job). */
function stepsRun(
	id: string,
	event: string,
	changes: Ctx["changes"],
	results: Ctx["results"],
) {
	const job = CI[id];
	const legs = job.strategy?.matrix?.os ?? [undefined];
	return Object.fromEntries(
		legs.map((matrixOs) => [
			matrixOs ?? "-",
			(job.steps ?? [])
				.filter(
					(step) =>
						step.if === undefined ||
						evaluate(step.if, {
							event,
							changes,
							results,
							outputs: { changes },
							matrixOs,
						}),
				)
				.map((step) => step.name ?? step.uses ?? "?"),
		]),
	);
}

// The branch-protection contexts (probed 2026-09-30) and the ci.yml job that
// produces each; knip and `oxfmt format check` come from lint.yml, which this
// change does not touch.
const REQUIRED_FROM_CI: Record<string, string> = {
	"Lint & type-check": "lint-and-typecheck",
	"Unit tests": "unit-tests",
	"Install test (ubuntu-latest)": "install-test",
	"Install test (windows-latest)": "install-test",
	"Install test (macos-latest)": "install-test",
	"TLA+ models": "tla-models",
};

const DOCS_ONLY = [
	"docs/pi-lens-fixer.md",
	"README.md",
	".changelog/3801-x.md",
];
const HEAVY = [
	"test",
	"prod-install-build",
	"targeted-tests-advisory",
	"heavy-gate",
	"unit-tests-windows",
	"mutation",
];

describe("#3801 docs-only pull requests skip the heavy CI", () => {
	it("skips every heavy job for a docs-only diff and runs the cheap ones", () => {
		const { changes, results } = simulate("pull_request", DOCS_ONLY);
		expect(changes).toEqual({ code: "false", formal: "false" });
		for (const id of HEAVY) expect(results[id], id).toBe("skipped");
		expect(results["mutation-comment"]).toBe("skipped");
		for (const id of [
			"validate-merge-train-dispatch",
			"changes",
			"dependency-boundaries",
			"changelog-fragment-fastfail",
			"lint-and-typecheck",
			"docs-governance",
		]) {
			expect(results[id], id).toBe("success");
		}
	});

	// Recurrence: one non-docs file in an otherwise docs diff (the allowlist is
	// strict: agent contracts, workflows, formal/, scripts and tests are code).
	it.each([
		[".claude/agents/pi-lens-fixer.md"],
		[".github/workflows/ci.yml"],
		["formal/file-locks/FileLock.tla"],
		["scripts/ci-verdict.mjs"],
		["tests/config/a.test.ts"],
		["skills/pi-lens/SKILL.md"],
	])("runs everything when %s joins a docs diff", (file) => {
		const { changes, results } = simulate("pull_request", [...DOCS_ONLY, file]);
		expect(changes.code).toBe("true");
		for (const id of HEAVY) expect(results[id], id).toBe("success");
		expect(results["docs-governance"]).toBe("skipped");
		expect(results["mutation-comment"]).toBe("success");
	});

	// Recurrence: master, merge-train replays and (later) merge_group losing the
	// full suite to the classifier.
	it.each(["push", "repository_dispatch", "merge_group"])(
		"runs the full suite for a %s event even for a docs-only file list",
		(event) => {
			const { changes, results } = simulate(event, DOCS_ONLY);
			expect(changes).toEqual({ code: "true", formal: "true" });
			for (const id of [
				"test",
				"unit-tests",
				"install-test",
				"tla-models",
				"prod-install-build",
				"heavy-gate",
				"unit-tests-windows",
			]) {
				expect(results[id], id).toBe("success");
			}
			expect(results["docs-governance"]).toBe("skipped");
			// mutation, targeted tests and the changelog fast-fail are pull_request jobs
			for (const id of [
				"mutation",
				"targeted-tests-advisory",
				"changelog-fragment-fastfail",
			]) {
				expect(results[id], id).toBe("skipped");
			}
		},
	);

	// Recurrence (AGENTS.md shape 11, and #3756's aggregate lesson): a required
	// context that does not run. GitHub reads a skipped job as passing, but
	// ci-verdict and the merge train demand a literal success, and a skipped
	// MATRIX job reports under its raw name, leaving the required names absent.
	it.each([
		["docs-only", "pull_request", DOCS_ONLY],
		["code", "pull_request", ["clients/index.ts"]],
		["formal", "pull_request", ["formal/file-locks/FileLock.tla"]],
		["push", "push", ["clients/index.ts"]],
		["repository_dispatch", "repository_dispatch", ["clients/index.ts"]],
	])(
		"runs every required ci.yml job on a %s run, so no required check is absent or skipped",
		(_label, event, files) => {
			const { results } = simulate(event, files);
			for (const [context, id] of Object.entries(REQUIRED_FROM_CI)) {
				expect(results[id], `${context} <- ${id}`).toBe("success");
			}
			expect(CI["install-test"].strategy?.matrix?.os).toEqual([
				"ubuntu-latest",
				"windows-latest",
				"macos-latest",
			]);
		},
	);

	// Recurrence: the install legs skipping at job level (raw-name quirk) or
	// still doing the heavy work on a docs-only diff.
	it("skips every step of every Install test leg on a docs-only diff, and none on a code diff except per-leg ones", () => {
		const docs = simulate("pull_request", DOCS_ONLY);
		const docsSteps = stepsRun(
			"install-test",
			"pull_request",
			docs.changes,
			docs.results,
		);
		for (const [leg, steps] of Object.entries(docsSteps))
			expect(steps, leg).toEqual([]);

		const code = simulate("pull_request", ["clients/index.ts"]);
		const codeSteps = stepsRun(
			"install-test",
			"pull_request",
			code.changes,
			code.results,
		);
		const total = (CI["install-test"].steps ?? []).length;
		expect(codeSteps["ubuntu-latest"]).toHaveLength(total - 2); // dispatch validation, macOS-only APFS step
		expect(codeSteps["windows-latest"]).toHaveLength(total - 2);
		expect(codeSteps["macos-latest"]).toHaveLength(total - 1); // dispatch validation
	});

	// Recurrence: TLA+ running on every diff (8 minutes of the heaviest required
	// job), or skipping when formal/ or its checker changed.
	it("model-checks only when formal/ or what runs it changed, and always on master", () => {
		const names = (event: string, files: string[]) => {
			const sim = simulate(event, files);
			return stepsRun("tla-models", event, sim.changes, sim.results)["-"];
		};
		expect(names("pull_request", ["clients/index.ts"])).toEqual([
			"Skip the model check (formal/ unchanged)",
		]);
		expect(names("pull_request", DOCS_ONLY)).toEqual([
			"Skip the model check (formal/ unchanged)",
		]);
		for (const files of [
			["formal/file-locks/FileLock.tla"],
			["scripts/check-tla-models.mjs"],
			[".github/workflows/ci.yml"],
		]) {
			const ran = names("pull_request", files);
			expect(ran).toContain(
				"Model-check formal/ against each config's expected verdict",
			);
			expect(ran).not.toContain("Skip the model check (formal/ unchanged)");
		}
		expect(names("push", ["clients/index.ts"])).toContain(
			"Model-check formal/ against each config's expected verdict",
		);
	});

	// Recurrence: a failed or empty classification reading as docs-only. The
	// aggregate may pass on skipped shards only for code == 'false'.
	it("passes the Unit tests aggregate on skipped shards ONLY for a proven docs-only diff", () => {
		const aggregate = CI["unit-tests"];
		expect(aggregate.if).toBe("always()");
		expect(asList(aggregate.needs)).toEqual(["test", "changes"]);
		const run = String(aggregate.steps?.[0].run);
		const docsBranch =
			/if \[\[ "\$\{SHARDS_RESULT\}" == "skipped" && "\$\{CODE_CHANGED\}" == "false" \]\]; then[\s\S]*?\n\s*exit 0\n\s*fi/;
		expect(run).toMatch(docsBranch);
		// the failure branch still follows it, and nothing else exits 0
		expect(run.replace(docsBranch, "")).toMatch(
			/if \[\[ "\$\{SHARDS_RESULT\}" != "success" \]\]; then[\s\S]*\n\s*exit 1\n\s*fi\s*$/,
		);
		expect(run.match(/exit 0/g)).toHaveLength(1);
	});

	// Recurrence: a docs edit that breaks a governance suite merging unread,
	// because the shards that would have run it were skipped.
	it("keeps tests/config and tests/docs running for a docs-only diff, and only for one", () => {
		const job = CI["docs-governance"];
		expect(job.name).toBe("Docs governance tests");
		expect(job.if).toBe("needs.changes.outputs.code == 'false'");
		const command = (job.steps ?? [])
			.map((s) => s.run)
			.find((r) => r?.startsWith("npm test"));
		expect(command).toBe("npm test -- tests/config tests/docs");
	});

	// Recurrence: a heavy job that forgot the skip (a new job copied without the
	// `changes` need). Every job that is not cheap-by-design must depend on it.
	it("makes every non-cheap ci.yml job depend on `changes`", () => {
		const cheap = new Set([
			"validate-merge-train-dispatch",
			"changes",
			"dependency-boundaries",
			"changelog-fragment-fastfail",
			"lint-and-typecheck",
			"record-post-merge-validation",
			"mutation-comment",
			"unit-tests-windows",
			"mutation",
		]);
		for (const [id, job] of Object.entries(CI)) {
			if (cheap.has(id)) continue;
			expect(asList(job.needs), `${id} must need changes`).toContain("changes");
		}
		// the two heavy advisory jobs reach it through heavy-gate, which needs it
		expect(asList(CI["heavy-gate"].needs)).toContain("changes");
		expect(CI["heavy-gate"].if).toContain(
			"needs.changes.outputs.code == 'true'",
		);
	});
});
