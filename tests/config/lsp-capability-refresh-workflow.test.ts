import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { workflowDocument } from "../../scripts/dispatch-safety.mjs";
import { extractVitestFailureBlock } from "../../scripts/extract-vitest-failures.mjs";
import {
	commandBasename,
	scannableRegions,
	splitSegments,
	splitWords,
	stripCommandGroupAndRunnerPrefixes,
	stripEnvAssignments,
} from "../../scripts/hooks/guard-bash.mjs";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW = resolve(ROOT, ".github/workflows/tool-smoke.yml");

function loadWorkflow(): any {
	return yaml.load(readFileSync(WORKFLOW, "utf8"));
}

describe("nightly LSP capability refresh contract (#4277)", () => {
	it("builds the in-place compiled twins before the census, after the promotion edit (#4302)", () => {
		const workflow = loadWorkflow();
		const smoke = workflow.jobs["tool-smoke"];
		const indexOf = (id: string) =>
			smoke.steps.findIndex((step: any) => step.id === id);
		// Only the in-place `npm run build`; `npm run build:dist` also matches a
		// substring check but emits dist/, which is not what vitest loads.
		const buildIndex = smoke.steps.findIndex(
			(step: any) => String(step.run).trim() === "npm run build",
		);

		expect(buildIndex).toBeGreaterThan(indexOf("idle_promote"));
		expect(buildIndex).toBeLessThan(indexOf("lsp_census"));
		expect(smoke.steps[buildIndex]["continue-on-error"]).toBeUndefined();
	});

	it("runs every matrix census before the refresh PR step", () => {
		const workflow = loadWorkflow();
		const smoke = workflow.jobs["tool-smoke"];
		const censusIndex = smoke.steps.findIndex(
			(step: any) => step.id === "lsp_census",
		);
		const diffIndex = smoke.steps.findIndex(
			(step: any) => step.id === "docs_diff",
		);
		const census = smoke.steps[censusIndex];
		const refresh = workflow.jobs["tool-smoke-prs"].steps.find(
			(step: any) => step.with?.branch === "bot/lsp-docs-refresh",
		);

		expect(censusIndex).toBeGreaterThan(diffIndex);
		expect(census["continue-on-error"]).toBe(true);
		for (const file of [
			"tests/config/lsp-first-publish-census.test.ts",
			"tests/config/lsp-clean-behavior-census.test.ts",
			"tests/config/lsp-idle-eviction-measurement.test.ts",
			"tests/scripts/lsp-matrix-refresh-expiry.test.ts",
		])
			expect(census.run).toContain(file);
		expect(census.run).toContain(
			'tee "$RUNNER_TEMP/lsp-capability-census.log"',
		);
		expect(refresh.if).toContain(
			"needs.tool-smoke.outputs.census == 'success'",
		);
	});

	it("routes every non-success outcome to the separately titled tracker", () => {
		const workflow = loadWorkflow();
		const smoke = workflow.jobs["tool-smoke"];
		const notify = workflow.jobs["tool-smoke-notify"];
		const tracker = notify.steps.find((step: any) =>
			step.name?.includes("LSP capability census"),
		);
		const run = String(tracker.run);

		expect(tracker.if).toBe("always()");
		expect(run).toContain("TITLE='nightly: LSP capability census drift'");
		expect(run).toContain("scripts/upsert-tracking-issue.mjs");
		expect(run).toContain('--body-file "$body"');
		expect(run).toContain("--clean --close-when-clean");
		expect(run).toContain(
			'node scripts/extract-vitest-failures.mjs "$CENSUS_LOG"',
		);
		expect(notify.needs).toBe("tool-smoke");

		for (const [output, variable] of [
			["census", "CENSUS_OUTCOME"],
			["seed_matrix", "SEED_OUTCOME"],
			["lsp_matrix", "MATRIX_OUTCOME"],
			["clean_signal", "CLEAN_OUTCOME"],
			["server_capabilities", "CAPABILITIES_OUTCOME"],
			["idle_measurement", "IDLE_OUTCOME"],
			["idle_promote", "PROMOTE_OUTCOME"],
			["docs_diff", "DIFF_OUTCOME"],
		]) {
			expect(smoke.outputs[output]).toBeDefined();
			expect(run).toContain(`$${variable}`);
		}
		expect(run).toContain("$JOB_STATUS");
	});

	it("keeps coloured census diagnostics in the tracking issue body", () => {
		const coloured = [
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m \u001b[30m\u001b[42m default \u001b[49m\u001b[39m tests/config/lsp-first-publish-census.test.ts\u001b[2m > \u001b[22m#3310 first-publish census",
			"\u001b[31m\u001b[1mAssertionError\u001b[22m: expected [ Array(1) ] to deeply equal []\u001b[39m",
			'\u001b[31m+   "typescript (typescript-language-server): measured empty-first but wait-policy/strategies.ts has no emptyFirstPublish marker for \\"typescript\\""\u001b[39m',
			" Test Files  1 failed | 3 passed (4)",
		].join("\n");
		const body = extractVitestFailureBlock(coloured);
		expect(body).toContain("tests/config/lsp-first-publish-census.test.ts");
		expect(body).toContain("typescript-language-server");
		expect(body).toContain("emptyFirstPublish marker");
	});

	it("keeps every coloured failure block, including non-census failures", () => {
		const coloured = [
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default tests/config/lsp-first-publish-census.test.ts > first",
			"first census detail",
			" Test Files  1 failed (1)",
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default tests/config/lsp-clean-behavior-census.test.ts > second",
			"second census detail",
			" Test Files  2 failed (2)",
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default tests/clients/unrelated.test.ts > third",
			"third unrelated detail",
			" Test Files  3 failed (3)",
		].join("\n");
		const body = extractVitestFailureBlock(coloured);
		expect(body).toContain("tests/config/lsp-first-publish-census.test.ts");
		expect(body).toContain("tests/config/lsp-clean-behavior-census.test.ts");
		expect(body).toContain("tests/clients/unrelated.test.ts");
	});

	it("bounds failure details with an explicit omitted-block count", () => {
		const output = Array.from({ length: 20 }, (_, index) =>
			[
				` FAIL default tests/config/failure-${index}.test.ts > case`,
				"x".repeat(1_000),
			].join("\n"),
		).join("\n");
		const body = extractVitestFailureBlock(output);
		expect(body.length).toBeLessThanOrEqual(12_000);
		expect(body).toMatch(/\(\d+ more failures truncated\)$/);
	});

	it("gates only the refresh PR, while preserving the independent promotion PR", () => {
		const workflow = loadWorkflow();
		const prs = workflow.jobs["tool-smoke-prs"].steps.filter((step: any) =>
			step.uses?.startsWith("peter-evans/create-pull-request"),
		);
		const refresh = prs.find(
			(step: any) => step.with?.branch === "bot/lsp-docs-refresh",
		);
		const promotion = prs.find(
			(step: any) => step.with?.branch === "bot/lsp-idle-evict-promote",
		);

		expect(refresh.if).toContain(
			"needs.tool-smoke.outputs.docs_changed == 'true'",
		);
		expect(refresh.if).toContain(
			"needs.tool-smoke.outputs.census == 'success'",
		);
		expect(promotion.if).toBe("needs.tool-smoke.outputs.promoted == 'true'");
	});
});

// ── #3952: a staged dot path must survive the artifact hand-off ─────────────
//
// `actions/upload-artifact` v4.4+ omits every file or folder whose name starts
// with `.` unless the step sets `include-hidden-files: true`. The nightly staged
// its promotion fragment as `.changelog/3989-lsp-idle-eviction-promote.md`, the
// `tool-smoke-pr-inputs` artifact arrived without it, and the promotion PR's
// `git add` died on `fatal: pathspec '.changelog/…' did not match any files`
// (run 40185196001). Two qualified promotions were lost, 2026-10-24 and 2026-10-25.
//
// Recurrence this keeps out: any staging step that copies a dot path into an
// uploaded directory and then uploads it without the key. The scan reads the
// parsed YAML and the real shell text of each job, never a hand list of file
// names, so a new artifact or a new staged literal is read on the next run.
//
// Read grammar (the whole of it): a job's shell stages a path through `cp`,
// `mv`, `install`, `rsync` and `tee` operands and through `>`/`>>` redirects;
// variables resolve through in-job assignments, `env:` blocks, and the symbolic
// names below; an inner shell invoked as `bash -c`/`sh -c` is rescanned once.
// A staged path the grammar cannot place (an unset variable, a command
// substitution) makes the step red instead of passing, and every uploaded
// root must be named by a step of its own job, so an upload whose content no
// step explains reds rather than reading clean.
const UPLOAD_ARTIFACT = "actions/upload-artifact";

/** The verbs whose operands the scan follows as staged paths. */
const ADMITTED_WRITES = new Set(["cp", "mv", "install", "rsync", "tee"]);

/** Shells whose `-c` script is the same job's shell text, one level down. */
const ADMITTED_SHELLS = new Set(["bash", "sh", "zsh"]);

/**
 * Variables whose value is the runner's own location rather than the
 * workflow's: they are read as symbolic path segments, not as unknowns.
 */
const SYMBOLIC_VARIABLES = new Set([
	"GITHUB_ENV",
	"GITHUB_JOB",
	"GITHUB_OUTPUT",
	"GITHUB_PATH",
	"GITHUB_STEP_SUMMARY",
	"GITHUB_WORKSPACE",
	"RUNNER_TEMP",
]);

const ALIAS_CANDIDATES = 8;
const BARE_REDIRECT = /^(?:[0-9]|&)?>>?$/;
const INLINE_REDIRECT = /^(?:[0-9]|&)?>>?(.+)$/;

type ArtifactStep = {
	name?: unknown;
	uses?: unknown;
	run?: unknown;
	with?: Record<string, unknown>;
	env?: Record<string, unknown>;
};
type ArtifactJob = { env?: Record<string, unknown>; steps?: ArtifactStep[] };
type ArtifactWorkflow = { jobs?: Record<string, ArtifactJob> };

/** A path one of the job's shell commands writes. */
type Slot = { file: string };
type Aliases = Map<string, string[]>;

/** `${{ runner.temp }}` and the other workflow spellings, as a shell holds them. */
function symbolic(value: string): string {
	return value
		.replace(/\$\{\{\s*runner\.temp\s*\}\}/g, "$RUNNER_TEMP")
		.replace(/\$\{\{\s*github\.workspace\s*\}\}/g, "$GITHUB_WORKSPACE")
		.replace(/\/{2,}/g, "/")
		.trim();
}

/**
 * `scripts/hooks/guard-bash.mjs`'s placeholder for the output of a live
 * substitution: the scan keeps the position and not the text, because the
 * text is whatever the command prints at run time.
 */
const SUBSTITUTION_MARK = "\uE000";

/** Why a spelling's value cannot be read, or `undefined` when it can. */
function unreadablePart(spelling: string): string | undefined {
	if (spelling.includes("`") || spelling.includes("$("))
		return "a command substitution";
	if (spelling.includes(SUBSTITUTION_MARK))
		return "a substitution the scan cannot read";
	if (/\$[0-9@*#?!$-]/.test(spelling)) return "a shell parameter";
	for (const match of spelling.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g))
		if (!SYMBOLIC_VARIABLES.has(match[1])) return `$${match[1]}`;
	return undefined;
}

/**
 * Is a landed component's NAME led by a value the scan cannot read? Only the
 * leading character decides whether it starts with `.`, so a component that
 * begins with a literal character is decided whatever follows it.
 */
function unreadableLead(part: string): boolean {
	if (part.startsWith(SUBSTITUTION_MARK) || part.startsWith("`")) return true;
	return part.startsWith("$") && unreadablePart(part) !== undefined;
}

/**
 * Whether a landed path survives the upload. `hidden` is a component whose
 * name starts with `.`; `unknown` is one whose FIRST character comes from a
 * value the scan cannot read, so whether the upload drops it cannot be
 * decided either way. A component that starts with a literal character cannot
 * become hidden from anything the scan cannot read further along it, and
 * pathname expansion never matches a leading dot, so a glob cannot produce
 * one. `.` and `..` are navigation, not names.
 */
function landingVerdict(spelling: string): "hidden" | "unknown" | "clean" {
	for (const part of spelling.split("/")) {
		if (part === "" || part === "." || part === "..") continue;
		if (part.startsWith(".")) return "hidden";
		if (unreadableLead(part)) return "unknown";
	}
	return "clean";
}

/** The components of a spelling the scan cannot read the value of. */
function unresolvedComponents(spelling: string): string[] {
	return spelling
		.split("/")
		.filter((part) => part !== "" && unreadableLead(part));
}

function expandWord(word: string, aliases: Aliases): string[] {
	let values = [symbolic(word)];
	for (let round = 0; round < ALIAS_CANDIDATES; round++) {
		const next = new Set<string>();
		let replaced = false;
		for (const value of values) {
			const match = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(value);
			const candidates = match ? aliases.get(match[1]) : undefined;
			if (!match || !candidates) {
				next.add(value);
				continue;
			}
			replaced = true;
			for (const candidate of candidates)
				next.add(value.replace(match[0], candidate));
		}
		values = [...next].slice(0, ALIAS_CANDIDATES);
		if (!replaced) break;
	}
	return values;
}

function recordAlias(aliases: Aliases, name: string, value: string): void {
	const known = aliases.get(name) ?? [];
	const candidates = new Set([...known, ...expandWord(value, aliases)]);
	aliases.set(name, [...candidates].slice(0, ALIAS_CANDIDATES));
}

function filesOf(value: string, aliases: Aliases): Slot[] {
	return expandWord(value, aliases).map((file) => ({ file }));
}

/** The words a segment writes to, split from the words it operates on. */
function splitRedirects(words: string[]): {
	operands: string[];
	targets: string[];
} {
	const operands: string[] = [];
	const targets: string[] = [];
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		if (BARE_REDIRECT.test(word)) {
			const target = words[index + 1];
			if (target !== undefined && !target.startsWith("&")) targets.push(target);
			index++;
			continue;
		}
		const inline = INLINE_REDIRECT.exec(word);
		if (inline) {
			if (!inline[1].startsWith("&")) targets.push(inline[1]);
			continue;
		}
		operands.push(word);
	}
	return { operands, targets };
}

/**
 * The paths `command` writes, and the destinations it writes them under. A
 * copy into a directory lands the source's own path with `--parents` and only
 * its basename without; a copy onto a name lands that name. `tee` writes
 * every operand.
 */
function writeSlots(
	command: string,
	operands: string[],
	aliases: Aliases,
): { slots: Slot[]; destinations: string[] } {
	const targets = operands.filter((word) => !word.startsWith("-"));
	if (command === "tee")
		return {
			slots: targets.flatMap((target) => filesOf(target, aliases)),
			destinations: targets.flatMap((target) => expandWord(target, aliases)),
		};
	if (targets.length < 2) return { slots: [], destinations: [] };
	const sources = targets.slice(0, -1);
	const parents = operands.includes("--parents");
	const slots: Slot[] = [];
	const destinations = expandWord(targets[targets.length - 1], aliases);
	for (const target of destinations) {
		if (!target.endsWith("/")) {
			slots.push({ file: target });
			continue;
		}
		for (const source of sources)
			for (const from of expandWord(source, aliases))
				slots.push({
					file: parents
						? `${target}${from.replace(/^\/+/, "")}`
						: `${target}${from.replace(/\/+$/, "").split("/").pop() ?? ""}`,
				});
	}
	return { slots, destinations };
}

/** Every path one job's shell writes, and the destinations it cannot place. */
type Staging = { slots: Slot[]; unplaceable: string[] };

function jobStaging(job: ArtifactJob): Staging {
	const aliases: Aliases = new Map();
	const slots: Slot[] = [];
	const unplaceable: string[] = [];
	const recordWrite = (file: string) => {
		const unresolved = unresolvedComponents(file);
		if (unresolved.length > 0)
			unplaceable.push(`${file} (${unresolved.join(", ")})`);
		else slots.push({ file });
	};
	const recordEnv = (env: Record<string, unknown> | undefined) => {
		for (const [name, value] of Object.entries(env ?? {}))
			recordAlias(aliases, name, String(value));
	};
	// `FOO=1`, then a keyword or runner prefix (`do`, `then`, `env`, `sudo`,
	// `time`), then possibly another assignment: the command is what remains,
	// so a `for ...; do cp ...; done` body is read as the `cp` it runs.
	const commandWords = (segment: string) => {
		let current = splitWords(segment);
		for (let round = 0; round < 3; round++) {
			const { env, rest } = stripEnvAssignments(current);
			for (const [name, value] of Object.entries(env))
				recordAlias(aliases, name, value);
			const stripped = stripCommandGroupAndRunnerPrefixes(rest);
			if (stripped.length === current.length) return stripped;
			current = stripped;
		}
		return current;
	};
	const scan = (text: string, depth: number) => {
		for (const region of scannableRegions(text))
			for (const segment of splitSegments(region)) {
				const words = commandWords(segment);
				const command = words.length > 0 ? commandBasename(words[0]) : "";
				const { operands, targets } = splitRedirects(words.slice(1));
				for (const target of targets)
					for (const expanded of expandWord(target, aliases))
						recordWrite(expanded);
				if (ADMITTED_WRITES.has(command)) {
					const written = writeSlots(command, operands, aliases);
					for (const destination of written.destinations)
						if (unresolvedComponents(destination).length > 0)
							unplaceable.push(destination);
					for (const slot of written.slots) slots.push(slot);
				}
				if (
					depth > 0 &&
					ADMITTED_SHELLS.has(command) &&
					operands[0] === "-c" &&
					operands[1] !== undefined
				)
					scan(operands[1], depth - 1);
			}
	};
	recordEnv(job.env);
	for (const step of job.steps ?? []) {
		recordEnv(step.env);
		if (typeof step.run === "string") scan(step.run, 1);
	}
	return { slots, unplaceable };
}

/** An uploaded path entry's readable prefix, and whether it was cut short. */
type Root = { prefix: string; partial: boolean };

function uploadRoot(entry: string): Root {
	const kept: string[] = [];
	for (const part of entry.split("/")) {
		const unreadable =
			unreadablePart(part) ??
			(part.includes("${{")
				? "a workflow expression"
				: /[*?]/.test(part)
					? "a glob"
					: undefined);
		if (unreadable === undefined) {
			kept.push(part);
			continue;
		}
		const literal = part.split(/[$*?]/)[0];
		return literal.length > 0
			? { prefix: [...kept, literal].join("/"), partial: true }
			: { prefix: kept.join("/"), partial: false };
	}
	return { prefix: kept.join("/"), partial: false };
}

/** What `path` holds below `root`, or `undefined` when it is outside. */
function underRoot(root: Root, path: string): string | undefined {
	if (root.partial)
		return path.startsWith(root.prefix)
			? path.slice(root.prefix.length)
			: undefined;
	if (path === root.prefix) return "";
	return path.startsWith(`${root.prefix}/`)
		? path.slice(root.prefix.length + 1)
		: undefined;
}

function uploadPaths(step: ArtifactStep): string[] {
	const path = step.with?.path;
	const text = Array.isArray(path) ? path.join("\n") : String(path ?? "");
	return text
		.split("\n")
		.map((line) => symbolic(line).replace(/\/+$/, ""))
		.filter((line) => line.length > 0);
}

const isUpload = (step: ArtifactStep) =>
	typeof step.uses === "string" && step.uses.startsWith(UPLOAD_ARTIFACT);

/**
 * One finding per upload step that drops a staged dot path, or whose staged
 * set the read grammar cannot place. Empty means every upload keeps what its
 * job stages.
 */
function hiddenUploadFindings(
	fileName: string,
	workflow: ArtifactWorkflow,
): string[] {
	const findings: string[] = [];
	for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
		const uploads = (job.steps ?? []).filter(isUpload);
		if (uploads.length === 0) continue;
		const { slots, unplaceable } = jobStaging(job);
		for (const upload of uploads) {
			const label = `${fileName}: ${jobName}: ${
				typeof upload.name === "string"
					? upload.name
					: String(upload.with?.name ?? "upload-artifact")
			}`;
			const keySet =
				upload.with?.["include-hidden-files"] === true ||
				String(upload.with?.["include-hidden-files"]) === "true";
			for (const entry of uploadPaths(upload)) {
				const root = uploadRoot(entry);
				if (root.prefix.length === 0) {
					findings.push(`${label}: cannot read the uploaded path ${entry}`);
					continue;
				}
				if (!keySet && landingVerdict(root.prefix) === "hidden")
					findings.push(
						`${label}: uploads ${root.prefix}, a dot path, without include-hidden-files: true`,
					);
				for (const slot of slots) {
					const relative = underRoot(root, slot.file);
					if (relative === undefined) continue;
					const verdict = landingVerdict(relative);
					if (verdict === "hidden" && !keySet)
						findings.push(
							`${label}: stages ${slot.file}, a dot path, without include-hidden-files: true`,
						);
					else if (verdict === "unknown" && !keySet)
						findings.push(
							`${label}: stages ${slot.file} from a value the scan cannot read, so whether the upload drops it cannot be derived; set include-hidden-files: true`,
						);
				}
				for (const write of unplaceable)
					findings.push(
						`${label}: cannot place the write ${write} against ${root.prefix}, so what the artifact holds cannot be derived`,
					);
			}
		}
	}
	return [...new Set(findings)];
}

describe("staged dot paths survive the artifact hand-off (#3952)", () => {
	it(
		"carries include-hidden-files on every upload step that stages a dot path",
		() => {
			const files = listSourceFiles(resolve(ROOT, ".github"), {
				extensions: [".yml", ".yaml"],
				exclude: (relative) =>
					!/^(workflows\/[^/]+|actions\/[^/]+\/action)\.ya?ml$/.test(relative),
			});
			assertNonEmptyScan("workflow files under .github", files.length, 10);
			const workflows = files.map((file) => ({
				name: relativePosix(ROOT, file),
				workflow: workflowDocument(
					readFileSync(file, "utf8"),
				) as ArtifactWorkflow,
			}));
			const uploads = workflows.flatMap(({ workflow }) =>
				Object.values(workflow.jobs ?? {}).flatMap((job) =>
					(job.steps ?? []).filter(isUpload),
				),
			);
			assertNonEmptyScan("actions/upload-artifact steps", uploads.length, 10);

			const findings = workflows.flatMap(({ name, workflow }) =>
				hiddenUploadFindings(name, workflow),
			);

			expect(findings).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// The witness that the scan reads the real staging: the nightly's fragment
	// is a landed path of the `tool-smoke` job, so a scan that sees nothing
	// cannot pass the case above by accident.
	it("derives the promotion fragment the nightly stages", () => {
		const workflow = loadWorkflow() as ArtifactWorkflow;
		const staged = jobStaging(workflow.jobs?.["tool-smoke"] ?? {}).slots.map(
			(slot) => slot.file,
		);

		expect(staged).toContain(
			"$RUNNER_TEMP/pr-inputs/files/.changelog/3989-lsp-idle-eviction-promote.md",
		);
		expect(staged).toContain("$RUNNER_TEMP/pr-inputs/idle-eviction-promote.md");
	});

	const plant = (
		staging: string[],
		uploadPath: string | string[],
		extra: string[] = [],
	) =>
		[
			"jobs:",
			"  smoke:",
			"    steps:",
			"      - name: Stage the inputs",
			"        run: |",
			...staging.map((line) => `          ${line}`),
			"      - uses: actions/upload-artifact@v7",
			"        with:",
			"          name: pr-inputs",
			...(Array.isArray(uploadPath)
				? [
						"          path:",
						...uploadPath.map((line) => `            - ${line}`),
					]
				: [`          path: ${uploadPath}`]),
			...extra.map((line) => `          ${line}`),
		].join("\n");
	const findingsFor = (source: string) =>
		hiddenUploadFindings(
			"fixture.yml",
			workflowDocument(source) as ArtifactWorkflow,
		);
	const staged = (extra: string) =>
		`stage="$RUNNER_TEMP/pr-inputs"\nmkdir -p "$stage/files"\n${extra}`.split(
			"\n",
		);
	const ROOT_PATH = "${{ runner.temp }}/pr-inputs";

	it.each([
		{
			title: "a dot path copied with --parents",
			staging: staged('cp --parents .changelog/x.md "$stage/files/"'),
			expected: 1,
		},
		{
			title: "a dot path reached through another binding",
			staging: staged(
				'file=.changelog/x.md\ncp --parents "$file" "$stage/files/"',
			),
			expected: 1,
		},
		{
			title: "a dot path reached through an alias of the staging directory",
			staging: staged(
				'stage_alias="$stage"\ncp --parents .changelog/x.md "$stage_alias/files/"',
			),
			expected: 1,
		},
		{
			title: "a dot path inside a bash -c script",
			staging: staged(
				'bash -c \'cp --parents .changelog/x.md "$0/files/"\' "$stage"',
			),
			expected: 1,
		},
		{
			title: "a source the scan cannot read, landing under a staged directory",
			staging: staged('cp "$FROM_A_STEP_OUTPUT" "$stage/files/"'),
			expected: 1,
		},
		{
			title: "a destination the scan cannot place",
			staging: staged(
				'DEST="$(mktemp -d)"\ncp --parents .changelog/x.md "$DEST/files/"',
			),
			expected: 1,
		},
		{
			title: "an upload whose own path is hidden",
			staging: [
				'stage="$RUNNER_TEMP/.state"',
				'mkdir -p "$stage"',
				'printf "%s\\n" x > "$stage/a.txt"',
			],
			uploadPath: "${{ runner.temp }}/.state",
			expected: 1,
		},
		{
			title: "a dot path staged by rsync, whose source is a directory",
			staging: staged('rsync -a .changelog/ "$stage/files/"'),
			expected: 1,
		},
		{
			title: "a dot path staged by install onto a hidden name",
			staging: staged(
				'install -Dm644 .changelog/x.md "$stage/files/.changelog/x.md"',
			),
			expected: 1,
		},
		{
			title: "a dot path spelled with a leading ./",
			staging: staged('cp --parents ./.changelog/x.md "$stage/files/"'),
			expected: 1,
		},
		{
			title: "a dot path reached through a for-loop variable",
			staging: staged(
				'for f in .changelog/x.md; do cp --parents "$f" "$stage/files/"; done',
			),
			expected: 1,
		},
		{
			title: "a dot path under an upload path that holds a workflow expression",
			staging: [
				'stage="$RUNNER_TEMP/out-7"',
				'mkdir -p "$stage"',
				'cp --parents .changelog/y.md "$stage/"',
			],
			uploadPath: "${{ runner.temp }}/out-${{ matrix.part }}",
			expected: 1,
		},
		{
			title: "a dot path under one entry of a list-form upload path",
			staging: staged('cp --parents .changelog/x.md "$stage/files/"'),
			uploadPath: ["${{ runner.temp }}/elsewhere", ROOT_PATH],
			expected: 1,
		},
		{
			title: "the key set on the same staging",
			staging: staged('cp --parents .changelog/x.md "$stage/files/"'),
			expected: 0,
			extra: ["include-hidden-files: true"],
		},
		{
			title:
				"a dot path copied WITHOUT --parents, which lands only its basename",
			staging: staged('cp .changelog/x.md "$stage/files/"'),
			expected: 0,
		},
		{
			title: "a commented-out copy, which is prose and not a command",
			staging: staged('# cp --parents .changelog/x.md "$stage/files/"'),
			expected: 0,
		},
		{
			title: "a glob source, which pathname expansion never matches a dot name",
			staging: staged('cp --parents "$stage"/../*.md "$stage/files/"'),
			expected: 0,
		},
	])("classifies $title", ({ staging, expected, uploadPath, extra }) => {
		const findings = findingsFor(
			plant(staging, uploadPath ?? ROOT_PATH, extra ?? []),
		);

		expect(findings).toHaveLength(expected);
		if (expected > 0) expect(findings[0]).toContain("pr-inputs");
	});

	it("names the dropped path it found", () => {
		const findings = findingsFor(
			plant(staged('cp --parents .changelog/x.md "$stage/files/"'), ROOT_PATH),
		);

		expect(findings).toEqual([
			"fixture.yml: smoke: pr-inputs: stages $RUNNER_TEMP/pr-inputs/files/.changelog/x.md, a dot path, without include-hidden-files: true",
		]);
	});
});
