/**
 * helm-render runner — rendered-manifest validation (#1283 Slice B).
 *
 * The environment is mocked (tool presence, spawn results), never the behavior
 * under test: the opt-in gate reads a real `.pi-lens.json` through the real
 * project-config loader, chart discovery walks the real workspace topology over
 * real chart fixtures on disk, and source mapping resolves against the real
 * template files. The `helm template` mock writes rendered manifests into the
 * scratch directory the runner actually passed it, so `--output-dir` layout and
 * `# Source:` mapping are exercised rather than asserted about.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";

const { safeSpawnAsync, resolveAvailableOrInstall } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	resolveAvailableOrInstall: vi.fn(),
}));

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));
vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		resolveAvailableOrInstall,
	}),
);

const { resetProjectLensConfigCache } = await import(
	"../../../../clients/project-lens-config.js"
);
const { resetWorkspaceTopology } = await import(
	"../../../../clients/workspace-topology.js"
);
const {
	default: helmRenderRunner,
	checkManifestShape,
	isHelmRenderEnabled,
	mapRenderedToSource,
	parseHelmTemplateFailure,
	parseRenderedTrivyOutput,
	resolveTemplateSource,
} = await import("../../../../clients/dispatch/runners/helm-render.js");

const fixtures = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"fixtures",
	"helm-render",
);

let workspace: string;

/** Copy a chart fixture into the temp workspace and return its root. */
function installChart(name: "valid-chart" | "broken-chart"): string {
	const dest = path.join(workspace, name);
	fs.cpSync(path.join(fixtures, name), dest, { recursive: true });
	return dest;
}

function optIn(config: Record<string, unknown>): void {
	fs.writeFileSync(
		path.join(workspace, ".pi-lens.json"),
		JSON.stringify(config),
	);
	resetProjectLensConfigCache();
}

function outputDirFrom(args: string[]): string {
	const index = args.indexOf("--output-dir");
	if (index < 0) throw new Error("helm template was called without --output-dir");
	return args[index + 1];
}

interface SpawnStub {
	status: number | null;
	stdout?: string;
	stderr?: string;
	failure?: string;
	spawnFailure?: { kind: string };
	error?: Error;
}

/**
 * Drive the two spawns the runner makes. `render` may write rendered manifests
 * into the real scratch directory; `scan` answers the trivy pass.
 */
function stubSpawns(options: {
	render: SpawnStub | ((outputDir: string) => SpawnStub);
	scan?: SpawnStub;
}): { renderedIn: () => string | undefined } {
	let capturedOutputDir: string | undefined;
	safeSpawnAsync.mockImplementation(
		async (_cmd: string, args: string[]): Promise<SpawnStub> => {
			if (args[0] === "template") {
				capturedOutputDir = outputDirFrom(args);
				return typeof options.render === "function"
					? options.render(capturedOutputDir)
					: options.render;
			}
			if (args[0] === "config") {
				return options.scan ?? { status: 0, stdout: "{}", stderr: "" };
			}
			throw new Error(`unexpected spawn: ${args.join(" ")}`);
		},
	);
	return { renderedIn: () => capturedOutputDir };
}

function writeRendered(
	outputDir: string,
	relativePath: string,
	content: string,
): void {
	const target = path.join(outputDir, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

const RENDERED_DEPLOYMENT = [
	"---",
	"# Source: pi-lens-render-valid/templates/deployment.yaml",
	"apiVersion: apps/v1",
	"kind: Deployment",
	"metadata:",
	"  name: pi-lens-render-web",
	"",
].join("\n");

beforeEach(() => {
	workspace = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-helm-render-test-")),
	);
	resolveAvailableOrInstall.mockReset();
	resolveAvailableOrInstall.mockResolvedValue("helm");
	safeSpawnAsync.mockReset();
	resetProjectLensConfigCache();
	resetWorkspaceTopology();
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
	resetProjectLensConfigCache();
	resetWorkspaceTopology();
});

describe("helm-render opt-in gate", () => {
	it("spawns nothing when the project has not opted in", async () => {
		const chart = installChart("valid-chart");
		stubSpawns({ render: { status: 0 } });

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result).toMatchObject({ status: "skipped", diagnostics: [] });
		expect(resolveAvailableOrInstall).not.toHaveBeenCalled();
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("stays off when other pi-lens settings exist but the render switch does not", async () => {
		const chart = installChart("valid-chart");
		optIn({ trivy: { enabled: true }, helm: { renderValidation: {} } });
		stubSpawns({ render: { status: 0 } });

		const result = await helmRenderRunner.run(
			makeRunnerCtx(path.join(chart, "values.yaml"), workspace, {
				kind: "yaml",
				projectRoot: workspace,
			}),
		);

		expect(result.status).toBe("skipped");
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		expect(isHelmRenderEnabled(workspace)).toBe(false);
	});

	it("renders once the switch is explicitly true", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		expect(isHelmRenderEnabled(workspace)).toBe(true);
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "wrote manifests", stderr: "" };
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result).toMatchObject({ status: "succeeded", semantic: "none" });
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		expect(safeSpawnAsync.mock.calls[0][1].slice(0, 3)).toEqual([
			"template",
			"pi-lens-render",
			path.resolve(chart),
		]);
	});
});

describe("helm-render failure semantics", () => {
	it("reports a failed render as chart findings mapped to the template", async () => {
		const chart = installChart("broken-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: {
				status: 1,
				stdout: "",
				stderr:
					'Error: template: pi-lens-render-broken/templates/deployment.yaml:12:20: executing "pi-lens-render-broken/templates/deployment.yaml" at <.Values.image.registry.host>: nil pointer evaluating interface {}.host',
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.status).toBe("succeeded");
		expect(result.semantic).toBe("blocking");
		expect(result.failureKind).toBeUndefined();
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({
			filePath: path.join(chart, "templates", "deployment.yaml"),
			line: 12,
			severity: "error",
			rule: "render-failed",
			tool: "helm-render",
		});
	});

	it("never reads a failed render as clean, even when the error is unrecognized", async () => {
		const chart = installChart("broken-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: { status: 1, stdout: "", stderr: "panic: something went wrong" },
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(path.join(chart, "values.yaml"), workspace, {
				kind: "yaml",
				projectRoot: workspace,
			}),
		);

		expect(result.semantic).toBe("blocking");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].filePath).toBe(
			path.join(chart, "Chart.yaml"),
		);
		expect(result.diagnostics[0].message).toContain("something went wrong");
	});

	it("reports an absent helm as runner-unavailable, not as chart findings", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		resolveAvailableOrInstall.mockResolvedValue(null);
		stubSpawns({ render: { status: 0 } });

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result).toMatchObject({
			status: "failed",
			failureKind: "unavailable",
			diagnostics: [],
		});
		expect(result.failureMessage).toContain("helm");
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it.each([
		["tool-not-found", "unavailable"],
		["timeout", "timeout"],
		["killed", "aborted"],
	])(
		"reports a %s render spawn failure as a runner failure, never as a broken chart",
		async (kind, failureKind) => {
			const chart = installChart("valid-chart");
			optIn({ helm: { renderValidation: { enabled: true } } });
			stubSpawns({
				render: {
					status: null,
					stdout: "",
					stderr: "",
					failure: kind === "timeout" ? "timeout" : "aborted",
					spawnFailure: { kind },
					error: new Error("opaque failure"),
				},
			});

			const result = await helmRenderRunner.run(
				makeRunnerCtx(
					path.join(chart, "templates", "deployment.yaml"),
					workspace,
					{ kind: "yaml", projectRoot: workspace },
				),
			);

			expect(result).toMatchObject({ status: "failed", failureKind });
			expect(result.diagnostics).toEqual([]);
		},
	);
});

describe("helm-render rendered-manifest checks", () => {
	it("maps a trivy misconfiguration back to the source template", async () => {
		const chart = installChart("valid-chart");
		optIn({
			helm: { renderValidation: { enabled: true } },
			trivy: { enabled: true },
		});
		const renderedRelative = path.join(
			"pi-lens-render-valid",
			"templates",
			"deployment.yaml",
		);
		stubSpawns({
			render: (outputDir) => {
				writeRendered(outputDir, renderedRelative, RENDERED_DEPLOYMENT);
				return { status: 0, stdout: "", stderr: "" };
			},
			scan: {
				status: 0,
				stdout: JSON.stringify({
					Results: [
						{
							Target: renderedRelative.split(path.sep).join("/"),
							Misconfigurations: [
								{
									ID: "KSV011",
									Title: "CPU not limited",
									Severity: "HIGH",
									CauseMetadata: { StartLine: 4 },
								},
							],
						},
					],
				}),
				stderr: "",
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.status).toBe("succeeded");
		expect(result.semantic).toBe("warning");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({
			filePath: path.join(chart, "templates", "deployment.yaml"),
			rule: "KSV011",
			severity: "warning",
			defectClass: "safety",
		});
		// Lines do not survive rendering, so the rendered coordinates go in the
		// message and the diagnostic sits at the top of the template.
		expect(result.diagnostics[0].line).toBe(1);
		expect(result.diagnostics[0].message).toContain("deployment.yaml:4");
	});

	it("flags a rendered document that is not a Kubernetes object", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					[
						"---",
						"# Source: pi-lens-render-valid/templates/deployment.yaml",
						"metadata:",
						"  name: headless",
						"",
					].join("\n"),
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({
			filePath: path.join(chart, "templates", "deployment.yaml"),
			rule: "manifest-shape",
			severity: "warning",
		});
		expect(result.diagnostics[0].message).toContain("apiVersion and kind");
	});

	it("says so when the IaC pass was requested but trivy is unavailable", async () => {
		const chart = installChart("valid-chart");
		optIn({
			helm: { renderValidation: { enabled: true } },
			trivy: { enabled: true },
		});
		resolveAvailableOrInstall.mockImplementation(
			async (_checker: unknown, toolId: string) =>
				toolId === "helm" ? "helm" : null,
		);
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		// Zero findings from a pass that never ran must not read as clean.
		expect(result.semantic).not.toBe("none");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({
			rule: "iac-pass-unavailable",
			filePath: path.join(chart, "Chart.yaml"),
		});
	});

	it("skips the IaC pass entirely when trivy is not opted in", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result).toMatchObject({ status: "succeeded", semantic: "none" });
		expect(
			safeSpawnAsync.mock.calls.map((call: unknown[]) => (call[1] as string[])[0]),
		).toEqual(["template"]);
	});

	it("reports an IaC pass that failed to complete instead of an empty clean result", async () => {
		const chart = installChart("valid-chart");
		optIn({
			helm: { renderValidation: { enabled: true } },
			trivy: { enabled: true },
		});
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
			scan: { status: 2, stdout: "", stderr: "FATAL policy bundle download" },
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].rule).toBe("iac-pass-failed");
		expect(result.semantic).toBe("warning");
	});

	it("writes nothing into the chart and removes its scratch directory", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		const before = fs.readdirSync(chart, { recursive: true }).sort();
		const stub = stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		});

		await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(fs.readdirSync(chart, { recursive: true }).sort()).toEqual(before);
		const scratch = stub.renderedIn();
		expect(scratch).toBeTruthy();
		expect(scratch?.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
		expect(fs.existsSync(scratch as string)).toBe(false);
	});

	it("deduplicates concurrent edits by chart root", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		let settle!: (value: SpawnStub) => void;
		safeSpawnAsync.mockReturnValue(
			new Promise<SpawnStub>((resolve) => {
				settle = resolve;
			}),
		);

		const first = helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);
		const second = helmRenderRunner.run(
			makeRunnerCtx(path.join(chart, "values.yaml"), workspace, {
				kind: "yaml",
				projectRoot: workspace,
			}),
		);
		await vi.waitFor(() => expect(safeSpawnAsync).toHaveBeenCalledTimes(1));
		settle({ status: 0, stdout: "", stderr: "" });
		await Promise.all([first, second]);

		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});

describe("helm-render source mapping", () => {
	it("drops helm's chart-name prefix and confines the result to the chart", () => {
		const chart = installChart("valid-chart");
		expect(
			resolveTemplateSource(
				"pi-lens-render-valid/templates/deployment.yaml",
				chart,
			),
		).toBe(path.join(chart, "templates", "deployment.yaml"));
		expect(
			resolveTemplateSource("chart/../../../etc/passwd", chart),
		).toBeNull();
		expect(resolveTemplateSource("chart/templates/absent.yaml", chart)).toBeNull();
	});

	it("prefers the # Source annotation, then the output-dir layout, then Chart.yaml", () => {
		const chart = installChart("valid-chart");
		const outputDir = path.join(workspace, "out");
		const rendered = path.join(
			outputDir,
			"pi-lens-render-valid",
			"templates",
			"deployment.yaml",
		);

		expect(
			mapRenderedToSource({
				renderedContent:
					"# Source: pi-lens-render-valid/templates/deployment.yaml\nkind: Deployment\n",
				renderedPath: path.join(outputDir, "elsewhere.yaml"),
				outputDir,
				chartRoot: chart,
			}),
		).toEqual({
			filePath: path.join(chart, "templates", "deployment.yaml"),
			mapped: true,
		});

		expect(
			mapRenderedToSource({
				renderedContent: "kind: Deployment\n",
				renderedPath: rendered,
				outputDir,
				chartRoot: chart,
			}),
		).toEqual({
			filePath: path.join(chart, "templates", "deployment.yaml"),
			mapped: true,
		});

		expect(
			mapRenderedToSource({
				renderedContent: "# Source: other/templates/gone.yaml\n",
				renderedPath: path.join(outputDir, "other", "templates", "gone.yaml"),
				outputDir,
				chartRoot: chart,
			}),
		).toEqual({ filePath: path.join(chart, "Chart.yaml"), mapped: false });
	});
});

describe("parseHelmTemplateFailure", () => {
	it("keeps one diagnostic per Error line and always produces at least one", () => {
		const chartRoot = path.resolve("chart-root");
		expect(parseHelmTemplateFailure("", chartRoot)).toHaveLength(1);
		expect(parseHelmTemplateFailure("", chartRoot)[0].filePath).toBe(
			path.join(chartRoot, "Chart.yaml"),
		);

		const dependency = parseHelmTemplateFailure(
			"Error: An error occurred while checking for chart dependencies: found in Chart.yaml, but missing in charts/ directory: redis",
			chartRoot,
		);
		expect(dependency).toHaveLength(1);
		expect(dependency[0].message).toContain("missing in charts/");
		expect(dependency[0].severity).toBe("error");
	});

	it("ignores non-error chatter around the failure", () => {
		const diagnostics = parseHelmTemplateFailure(
			[
				"walk.go:74: found symbolic link in path",
				"Error: parse error at (chart/templates/x.yaml:5): unclosed action",
			].join("\n"),
			path.resolve("chart-root"),
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("unclosed action");
	});
});

describe("checkManifestShape", () => {
	it("flags only documents that carry content but no object identity", () => {
		const diagnostics = checkManifestShape({
			renderedContent: [
				"---",
				"# Source: c/templates/a.yaml",
				"apiVersion: v1",
				"kind: Service",
				"---",
				"# a comment-only document is not a defect",
				"---",
				"metadata:",
				"  name: headless",
				"",
			].join("\n"),
			renderedRelativePath: "c/templates/a.yaml",
			sourcePath: "/repo/chart/templates/a.yaml",
			sourceMapped: true,
		});
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("missing apiVersion and kind");
		expect(diagnostics[0].filePath).toBe("/repo/chart/templates/a.yaml");
	});
});

describe("parseRenderedTrivyOutput", () => {
	it("routes each result through its own target and tolerates malformed input", () => {
		const locate = (target: string) => ({
			filePath: `/repo/chart/templates/${path.basename(target || "unknown")}`,
			detail: target,
		});
		expect(parseRenderedTrivyOutput("not json", locate)).toEqual([]);
		expect(parseRenderedTrivyOutput("", locate)).toEqual([]);
		expect(parseRenderedTrivyOutput('{"Results":"nope"}', locate)).toEqual([]);

		const diagnostics = parseRenderedTrivyOutput(
			JSON.stringify({
				Results: [
					{
						Target: "c/templates/a.yaml",
						Misconfigurations: [
							{ ID: "KSV001", Severity: "CRITICAL", CauseMetadata: {} },
							{ Severity: "HIGH" },
						],
					},
					{ Target: "c/templates/b.yaml", Misconfigurations: [] },
				],
			}),
			locate,
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			filePath: "/repo/chart/templates/a.yaml",
			rule: "KSV001",
			severity: "error",
			semantic: "blocking",
		});
	});
});
