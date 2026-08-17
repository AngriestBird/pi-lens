/**
 * helm render — rendered-manifest validation for Helm charts (#1283 Slice B).
 *
 * Slice A (`helm-lint`) checks the chart's SOURCE. This runner checks what the
 * chart actually PRODUCES: it renders the chart with `helm template` and then
 * validates the rendered manifests. Three defect classes only the rendered
 * output can show:
 *
 *   1. **the render itself fails** — a missing `values` key, a nil pointer in a
 *      template expression, a dependency declared in `Chart.yaml` but absent
 *      from `charts/`. `helm lint` passes on plenty of charts that cannot be
 *      installed;
 *   2. **the rendered document is not a Kubernetes object** — a conditional
 *      that produced an empty or headless document, so `apiVersion`/`kind` are
 *      missing. `helm template` does not require them;
 *   3. **the rendered object is insecure** — privileged containers, missing
 *      resource limits, host-path mounts. Trivy's misconfiguration engine reads
 *      those off the manifest, and it has never been able to see them for a
 *      Helm chart because the manifest did not exist on disk.
 *
 * ## Opt-in, because rendering EXECUTES the chart
 *
 * `helm template` evaluates Go templates from the repository, and a chart can
 * carry `lookup`, `getHostByName`, or arbitrary `tpl` expansion. That is a trust
 * boundary, not a lint, so it is **off by default** and enabled per project:
 *
 * ```json
 * { "helm": { "renderValidation": { "enabled": true } } }
 * ```
 *
 * With the switch absent the runner never spawns anything at all.
 *
 * The Trivy pass keeps Trivy's OWN consent switch (`trivy.enabled`), because
 * that is the switch that authorizes installing the binary. Opting into
 * rendering therefore gets render + manifest-shape validation; the IaC pass
 * needs both switches. When Trivy is opted in but unavailable, the runner says
 * so as an `info` diagnostic — a missing pass must never read as a clean one.
 *
 * ## No repo writes
 *
 * Rendering goes to a scratch directory under `os.tmpdir()`, removed on every
 * exit path. The chart directory is never touched, and `--dependency-update` is
 * deliberately NOT passed: it would fetch archives into `charts/`. A missing
 * dependency is reported as a finding instead.
 *
 * ## Source mapping
 *
 * A finding the agent cannot locate is noise. Rendered manifests carry helm's
 * own `# Source: <chart>/templates/<file>` annotation, and `--output-dir` mirrors
 * that layout on disk, so every rendered file maps back to the template that
 * produced it. Lines do not survive rendering, so a mapped diagnostic sits at
 * line 1 of the template and names the rendered file and line in its message.
 * When mapping fails the diagnostic attaches to `Chart.yaml` with the rendered
 * path in the message.
 *
 * Refs #1283
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PathKeyedMap } from "../../path-keyed-map.js";
import { normalizeMapKey } from "../../path-utils.js";
import { loadPiLensProjectConfig } from "../../project-lens-config.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { isTrivyEnabled, resolveSeverityFloor } from "../../trivy-client.js";
import { findNearestDirWithMarker } from "../../workspace-topology.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { describeUnavailability } from "./utils/availability-policy.js";
import {
	createAvailabilityChecker,
	resolveAvailableOrInstall,
} from "./utils/runner-helpers.js";

const helm = createAvailabilityChecker("helm", ".exe");
const trivy = createAvailabilityChecker("trivy", ".exe");

const inFlightByChartRoot = new PathKeyedMap<Promise<RunnerResult>>(
	normalizeMapKey,
);

const RENDER_TIMEOUT_MS = 45_000;
const TRIVY_TIMEOUT_MS = 60_000;
/** Rendered manifests we are willing to read back, so a chart cannot flood us. */
const MAX_RENDERED_FILES = 400;

const SKIPPED: RunnerResult = {
	status: "skipped",
	diagnostics: [],
	semantic: "none",
};

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(
		normalizeMapKey(root),
		normalizeMapKey(candidate),
	);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}

/**
 * Explicit opt-in for rendering. Rendering runs chart-authored template code,
 * so the default is OFF and only an explicit `helm.renderValidation.enabled`
 * in `.pi-lens.json` (the loader walks up, so `~/.pi-lens.json` enables it for
 * every project) turns it on. Exported for tests and gate-before-spawn callers.
 */
export function isHelmRenderEnabled(cwd: string): boolean {
	try {
		const config = loadPiLensProjectConfig(cwd);
		const helmConfig = (
			config.raw as
				| { helm?: { renderValidation?: { enabled?: unknown } } }
				| undefined
		)?.helm;
		return helmConfig?.renderValidation?.enabled === true;
	} catch {
		return false;
	}
}

/**
 * Resolve a helm source reference (`<chartName>/templates/x.yaml`, as it appears
 * in `# Source:` annotations and template error messages) to the template file
 * on disk. Helm prefixes every reference with the chart NAME, which is not a
 * directory under the chart root, so the first segment is dropped. Returns null
 * when the result would not be a file inside the chart.
 */
export function resolveTemplateSource(
	sourceRef: string,
	chartRoot: string,
): string | null {
	const segments = sourceRef
		.split(/[\\/]+/)
		.filter((segment) => segment && segment !== ".");
	if (segments.length < 2) return null;
	const candidate = path.resolve(chartRoot, ...segments.slice(1));
	if (!isWithin(chartRoot, candidate)) return null;
	try {
		if (!fs.statSync(candidate).isFile()) return null;
	} catch {
		return null;
	}
	return candidate;
}

function chartYaml(chartRoot: string): string {
	return path.join(chartRoot, "Chart.yaml");
}

const HELM_INSTALL_HINT = "https://helm.sh/docs/intro/install/";
const TRIVY_INSTALL_HINT =
	"https://trivy.dev/latest/getting-started/installation/";

/** Helm's own provenance comment, written into every rendered document. */
const SOURCE_ANNOTATION = /^#\s*Source:\s*(\S+)\s*$/m;

/** Template extensions a helm source reference can name. */
const TEMPLATE_EXTENSION = /\.(?:ya?ml|tpl)$/i;

/**
 * Pull the first `<chart>/templates/x.yaml[:line]` reference out of one line of
 * helm output. Tokenized rather than pattern-matched on purpose: the obvious
 * regex for "a slashed path with an optional `:line`" nests two unbounded
 * negated character classes and backtracks super-linearly on a long error line.
 */
export function extractTemplateRef(
	line: string,
): { ref: string; line?: number } | null {
	for (const token of line.split(/[\s(),<>"']+/)) {
		const parts = token.split(":");
		const ref = parts[0];
		if (!ref.includes("/")) continue;
		if (!TEMPLATE_EXTENSION.test(ref)) continue;
		const lineNumber = /^\d+$/.test(parts[1] ?? "")
			? Number(parts[1])
			: undefined;
		return { ref, line: lineNumber };
	}
	return null;
}

/**
 * Where a rendered-manifest finding belongs. Prefer the `# Source:` annotation
 * helm writes into the manifest; fall back to the `--output-dir` layout, which
 * mirrors the same reference as a directory path; fall back to `Chart.yaml`
 * with the rendered path named in the message.
 */
export function mapRenderedToSource(options: {
	renderedContent: string;
	renderedPath: string;
	outputDir: string;
	chartRoot: string;
}): { filePath: string; mapped: boolean } {
	const annotation = SOURCE_ANNOTATION.exec(options.renderedContent);
	if (annotation) {
		const resolved = resolveTemplateSource(annotation[1], options.chartRoot);
		if (resolved) return { filePath: resolved, mapped: true };
	}
	const relative = path.relative(options.outputDir, options.renderedPath);
	if (relative && !relative.startsWith("..")) {
		const resolved = resolveTemplateSource(relative, options.chartRoot);
		if (resolved) return { filePath: resolved, mapped: true };
	}
	return { filePath: chartYaml(options.chartRoot), mapped: false };
}

/**
 * Turn a failed `helm template` into findings about the CHART. A render that
 * exits non-zero is a real defect the user needs (#1487): the chart cannot be
 * installed. It is NOT a runner failure — that distinction is made by the
 * caller, on the spawn outcome, before this parser is reached.
 *
 * Helm reports template faults as
 * `Error: template: <chart>/templates/x.yaml:12:9: executing ...` and parse
 * faults as `Error: parse error at (<chart>/templates/x.yaml:5): ...`. Anything
 * unrecognized still becomes one diagnostic on `Chart.yaml`, so a render that
 * failed can never come back empty.
 */
export function parseHelmTemplateFailure(
	raw: string,
	chartRoot: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const text = raw.trim();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("Error:")) continue;
		const location = extractTemplateRef(trimmed);
		const resolved = location
			? resolveTemplateSource(location.ref, chartRoot)
			: null;
		const chartName = path.basename(chartRoot);
		diagnostics.push({
			id: `helm-render-error-${diagnostics.length + 1}`,
			message: resolved
				? trimmed
				: `${trimmed} (helm template failed for chart ${chartName})`,
			filePath: resolved ?? chartYaml(chartRoot),
			line: resolved ? (location?.line ?? 1) : 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "helm-render",
			rule: "render-failed",
			fixable: false,
		});
	}
	if (diagnostics.length === 0) {
		diagnostics.push({
			id: "helm-render-error-1",
			message: `helm template failed: ${(text || "no output").slice(0, 400)}`,
			filePath: chartYaml(chartRoot),
			line: 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "helm-render",
			rule: "render-failed",
			fixable: false,
		});
	}
	return diagnostics;
}

/**
 * Every rendered YAML document must declare `apiVersion` and `kind`. `helm
 * template` does not check this, and a conditional that renders a headless
 * fragment (or nothing but whitespace under a `---`) installs as a no-op that
 * silently drops the object the chart was supposed to create.
 *
 * This is the manifest-shape half of "schema validation". Full OpenAPI schema
 * checking (kubeconform) needs another binary plus installer, availability and
 * gate wiring, and is deliberately out of Slice B's scope.
 */
export function checkManifestShape(options: {
	renderedContent: string;
	renderedRelativePath: string;
	sourcePath: string;
	sourceMapped: boolean;
}): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const documents = options.renderedContent.split(/^---\s*$/m);
	documents.forEach((document, index) => {
		const meaningful = document
			.split(/\r?\n/)
			.filter((line) => line.trim() && !line.trim().startsWith("#"));
		if (meaningful.length === 0) return;
		const missing: string[] = [];
		if (!/^apiVersion:\s*\S/m.test(document)) missing.push("apiVersion");
		if (!/^kind:\s*\S/m.test(document)) missing.push("kind");
		if (missing.length === 0) return;
		const where = options.sourceMapped
			? `rendered ${options.renderedRelativePath}`
			: `rendered ${options.renderedRelativePath} (source template could not be resolved)`;
		diagnostics.push({
			id: `helm-render-shape-${options.renderedRelativePath}-${index}`,
			message: `Rendered document ${index + 1} is missing ${missing.join(" and ")} — it is not a Kubernetes object (${where}).`,
			filePath: options.sourcePath,
			line: 1,
			column: 1,
			severity: "warning",
			semantic: "warning",
			tool: "helm-render",
			rule: "manifest-shape",
			fixable: false,
		});
	});
	return diagnostics;
}

/**
 * Map `trivy config --format json` over the rendered tree onto source
 * templates. Deliberately separate from `trivy-config.ts`'s parser: that one
 * pins every finding to the single file it was handed, while this one has to
 * read each result's `Target` and route it back through the render mapping.
 */
export function parseRenderedTrivyOutput(
	raw: string,
	locate: (target: string) => { filePath: string; detail: string },
): Diagnostic[] {
	if (!raw.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const results = (parsed as { Results?: unknown })?.Results;
	if (!Array.isArray(results)) return [];

	const diagnostics: Diagnostic[] = [];
	for (const entry of results) {
		if (!entry || typeof entry !== "object") continue;
		const target = (entry as { Target?: unknown }).Target;
		const rows = (entry as { Misconfigurations?: unknown }).Misconfigurations;
		if (!Array.isArray(rows)) continue;
		const located = locate(typeof target === "string" ? target : "");
		for (const row of rows) {
			if (!row || typeof row !== "object") continue;
			const misconfig = row as Record<string, unknown>;
			const id = typeof misconfig.ID === "string" ? misconfig.ID : undefined;
			if (!id) continue;
			const cause = (misconfig.CauseMetadata ?? {}) as { StartLine?: unknown };
			const renderedLine =
				typeof cause.StartLine === "number" && cause.StartLine > 0
					? cause.StartLine
					: undefined;
			const severity =
				typeof misconfig.Severity === "string"
					? misconfig.Severity.toUpperCase()
					: "UNKNOWN";
			const title =
				typeof misconfig.Title === "string" && misconfig.Title
					? misconfig.Title
					: id;
			const resolution =
				typeof misconfig.Resolution === "string" && misconfig.Resolution
					? ` ${misconfig.Resolution}`
					: "";
			const at = renderedLine
				? `${located.detail}:${renderedLine}`
				: located.detail;
			diagnostics.push({
				id: `helm-render-${id}-${diagnostics.length + 1}`,
				message: `[${id}] ${title} (${severity}) in ${at}.${resolution}`.trim(),
				filePath: located.filePath,
				line: 1,
				column: 1,
				severity: severity === "CRITICAL" ? "error" : "warning",
				semantic: severity === "CRITICAL" ? "blocking" : "warning",
				defectClass: "safety",
				tool: "helm-render",
				rule: id,
				fixable: false,
			});
		}
	}
	return diagnostics;
}

function unavailableResult(tool: string, cwd: string): RunnerResult {
	const verdict =
		tool === "helm" ? helm.getVerdict(cwd) : trivy.getVerdict(cwd);
	return {
		status: "failed",
		diagnostics: [],
		semantic: "warning",
		// One failureKind for both arms — a consumer must read this as "the runner
		// could not start", never as a chart finding. Whether the absence is
		// durable or a probe timeout is the MESSAGE's job, and the availability
		// seam has already logged the decision with its honest cause.
		failureKind: "unavailable",
		failureMessage: describeUnavailability({
			tool,
			installHint: tool === "helm" ? HELM_INSTALL_HINT : TRIVY_INSTALL_HINT,
			outcome: verdict.outcome,
			cause: verdict.cause,
			elapsedMs: verdict.elapsedMs,
			retryAfterMs: verdict.retryAtMs
				? Math.max(0, verdict.retryAtMs - Date.now())
				: undefined,
		}).slice(0, 300),
	};
}

function failedResult(kind: string, message: string): RunnerResult {
	return {
		status: "failed",
		diagnostics: [],
		semantic: "warning",
		failureKind: kind,
		failureMessage: message.slice(0, 200),
	};
}

/** Classify a spawn that never produced a verdict about the chart. */
function spawnFailureKind(result: {
	failure?: string;
	spawnFailure?: { kind?: string };
}): string | null {
	const typed = result.spawnFailure?.kind;
	if (typed === "tool-not-found") return "unavailable";
	if (typed === "timeout" || result.failure === "timeout") return "timeout";
	if (typed === "killed" || result.failure === "aborted") return "aborted";
	if (result.failure) return "server_error";
	return null;
}

function collectRenderedFiles(root: string): string[] {
	const files: string[] = [];
	const stack = [root];
	while (stack.length > 0 && files.length < MAX_RENDERED_FILES) {
		const dir = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
				files.push(full);
				if (files.length >= MAX_RENDERED_FILES) break;
			}
		}
	}
	return files.sort((left, right) => left.localeCompare(right));
}

function summarize(diagnostics: Diagnostic[]): RunnerResult {
	let semantic: RunnerResult["semantic"] = "none";
	if (diagnostics.some((item) => item.severity === "error")) {
		semantic = "blocking";
	} else if (diagnostics.length > 0) {
		semantic = "warning";
	}
	return { status: "succeeded", diagnostics, semantic };
}

/** One rendered manifest, paired with the template it came from. */
interface RenderedManifest {
	renderedPath: string;
	relativePath: string;
	content: string;
	sourcePath: string;
	sourceMapped: boolean;
}

/** Read the rendered tree back and resolve each file to its source template. */
function readRenderedTree(
	outputDir: string,
	chartRoot: string,
): RenderedManifest[] {
	const manifests: RenderedManifest[] = [];
	for (const renderedPath of collectRenderedFiles(outputDir)) {
		let content: string;
		try {
			content = fs.readFileSync(renderedPath, "utf-8");
		} catch {
			continue;
		}
		const mapping = mapRenderedToSource({
			renderedContent: content,
			renderedPath,
			outputDir,
			chartRoot,
		});
		manifests.push({
			renderedPath,
			relativePath: path.relative(outputDir, renderedPath),
			content,
			sourcePath: mapping.filePath,
			sourceMapped: mapping.mapped,
		});
	}
	return manifests;
}

/**
 * One `info` diagnostic saying a requested pass did not happen. Zero findings
 * from a pass that never ran must not read as a clean pass (defect shape 10).
 */
function iacPassGap(
	chartRoot: string,
	rule: "iac-pass-unavailable" | "iac-pass-failed",
	detail: string,
): Diagnostic {
	return {
		id: `helm-render-${rule}`,
		message: `Rendered-manifest IaC checks did not run: ${detail}`,
		filePath: chartYaml(chartRoot),
		line: 1,
		column: 1,
		severity: "info",
		semantic: "warning",
		tool: "helm-render",
		rule,
		fixable: false,
	};
}

/**
 * The Trivy half of the pass. Returns the findings it produced, or a single gap
 * diagnostic when it could not run — never an empty "clean" answer.
 */
async function runIacPass(options: {
	chartRoot: string;
	cwd: string;
	outputDir: string;
	manifests: RenderedManifest[];
}): Promise<Diagnostic[]> {
	const { chartRoot, cwd, outputDir } = options;
	const trivyCmd = await resolveAvailableOrInstall(trivy, "trivy", cwd);
	if (!trivyCmd) {
		const verdict = trivy.getVerdict(cwd);
		return [
			iacPassGap(
				chartRoot,
				"iac-pass-unavailable",
				describeUnavailability({
					tool: "trivy",
					installHint: TRIVY_INSTALL_HINT,
					outcome: verdict.outcome,
					cause: verdict.cause,
					elapsedMs: verdict.elapsedMs,
				}),
			),
		];
	}

	const scan = await safeSpawnAsync(
		trivyCmd,
		[
			"config",
			"--quiet",
			"--no-progress",
			"--format",
			"json",
			"--severity",
			resolveSeverityFloor(cwd).join(","),
			outputDir,
		],
		{
			cwd,
			timeout: TRIVY_TIMEOUT_MS,
			deadlineAt: Date.now() + TRIVY_TIMEOUT_MS,
			resourceLabel: "helm-render-trivy",
		},
	);
	const scanFailure = spawnFailureKind(scan);
	if (scanFailure || (scan.status !== 0 && !scan.stdout?.trim())) {
		const why = scanFailure ?? `exit ${scan.status}`;
		const detail = (scan.stderr || scan.error?.message || "no output").slice(
			0,
			200,
		);
		return [iacPassGap(chartRoot, "iac-pass-failed", `${why} - ${detail}`)];
	}

	const sourceByRendered = new PathKeyedMap<{
		filePath: string;
		detail: string;
	}>(normalizeMapKey);
	for (const manifest of options.manifests) {
		sourceByRendered.set(manifest.renderedPath, {
			filePath: manifest.sourcePath,
			detail: manifest.relativePath,
		});
	}
	return parseRenderedTrivyOutput(scan.stdout || "", (target) => {
		const hit = sourceByRendered.get(path.resolve(outputDir, target));
		return (
			hit ?? {
				filePath: chartYaml(chartRoot),
				detail: target || "rendered manifest",
			}
		);
	});
}

async function renderAndValidate(
	chartRoot: string,
	cwd: string,
): Promise<RunnerResult> {
	const helmCmd = await resolveAvailableOrInstall(helm, "helm", cwd);
	if (!helmCmd) return unavailableResult("helm", cwd);

	const outputDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-helm-render-"),
	);
	try {
		const render = await safeSpawnAsync(
			helmCmd,
			["template", "pi-lens-render", chartRoot, "--output-dir", outputDir],
			{
				cwd,
				timeout: RENDER_TIMEOUT_MS,
				deadlineAt: Date.now() + RENDER_TIMEOUT_MS,
				resourceLabel: "helm-render",
			},
		);

		const startupFailure = spawnFailureKind(render);
		if (startupFailure) {
			// The runner never got a verdict about the chart. Reporting this as a
			// chart finding would blame the user's chart for our own missing tool
			// (#1487); reporting nothing would read as clean (defect shape 10).
			return failedResult(
				startupFailure,
				render.error?.message || `helm template ${startupFailure}`,
			);
		}
		if (render.status !== 0) {
			// A failed RENDER is a real diagnostic: the chart cannot be installed.
			const renderOutput = [render.stdout, render.stderr]
				.filter(Boolean)
				.join("\n");
			return summarize(parseHelmTemplateFailure(renderOutput, chartRoot));
		}

		const manifests = readRenderedTree(outputDir, chartRoot);
		const diagnostics: Diagnostic[] = [];
		for (const manifest of manifests) {
			diagnostics.push(
				...checkManifestShape({
					renderedContent: manifest.content,
					renderedRelativePath: manifest.relativePath,
					sourcePath: manifest.sourcePath,
					sourceMapped: manifest.sourceMapped,
				}),
			);
		}

		// The IaC pass keeps trivy's own consent switch — that switch authorizes
		// installing the binary and pulling its policy bundle.
		if (isTrivyEnabled(cwd)) {
			diagnostics.push(
				...(await runIacPass({ chartRoot, cwd, outputDir, manifests })),
			);
		}
		return summarize(diagnostics);
	} finally {
		fs.rmSync(outputDir, { recursive: true, force: true });
	}
}

const helmRenderRunner: RunnerDefinition = {
	id: "helm-render",
	appliesTo: ["yaml", "helm-template"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,
	timeoutMs: RENDER_TIMEOUT_MS + TRIVY_TIMEOUT_MS + 10_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		// Off by default: rendering executes chart-authored template code.
		if (!isHelmRenderEnabled(cwd)) return SKIPPED;

		const workspaceRoot = path.resolve(ctx.projectRoot ?? cwd);
		const startDir = path.dirname(path.resolve(ctx.filePath));
		const discovered = findNearestDirWithMarker(startDir, "chartYamlPath");
		if (!discovered) return SKIPPED;
		const chartRoot = path.resolve(discovered);
		if (!isWithin(workspaceRoot, chartRoot)) return SKIPPED;

		const existing = inFlightByChartRoot.get(chartRoot);
		if (existing) return existing;
		const promise = renderAndValidate(chartRoot, cwd).finally(() => {
			if (inFlightByChartRoot.get(chartRoot) === promise)
				inFlightByChartRoot.delete(chartRoot);
		});
		inFlightByChartRoot.set(chartRoot, promise);
		return promise;
	},
};

export default helmRenderRunner;
