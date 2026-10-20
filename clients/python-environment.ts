import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path, { dirname, join, resolve } from "node:path";
import {
	extractTomlTableSection,
	hasTomlTable,
	parseTomlScalarString,
	parseTomlStringArray,
} from "./cargo-manifest.js";
import { resolveLanguage } from "./language-registry.js";
import {
	isAtOrAboveHomeDir,
	matchesWorkspaceMemberPattern,
	toPosix,
	UV_WORKSPACE_EXCLUDE_DIALECT,
	UV_WORKSPACE_MEMBERS_DIALECT,
	walkUpDirs,
	type WorkspaceMemberGlobDialect,
} from "./path-utils.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { logExtension } from "./extension-log.js";
import { getProjectTrustState } from "./project-trust.js";

export type PythonEnvironmentSource =
	| "virtual-env"
	| "conda"
	| "project-dot-venv"
	| "project-venv"
	| "uv-project-environment"
	| "uv-workspace";

export interface PythonEnvironment {
	root: string;
	binDir: string;
	pythonPath: string;
	source: PythonEnvironmentSource;
}

interface UvWorkspace {
	/** The workspace root — the project itself unless an ancestor declares one. */
	root: string;
	/** True when {@link root} declares `[tool.uv.workspace]`. */
	explicit: boolean;
	/** The nearest ancestor (inclusive) holding a `pyproject.toml`. */
	projectRoot: string;
	/**
	 * True when {@link projectRoot} IS the directory the walk started from —
	 * i.e. the caller's root is itself a uv project, not merely a directory
	 * somewhere beneath one. This is the whole gate for "does this directory
	 * get uv's project settings": the walk answers "which project OWNS this
	 * directory", which is a different question and only decides membership
	 * (review round 3, S1).
	 */
	isStartDir: boolean;
	members: string[];
	exclude: string[];
}

const UV_WORKSPACE_TABLE = "tool\\.uv\\.workspace";

/**
 * Resolve the uv workspace root using the same discovery shape as uv:
 * start at the nearest pyproject, then continue upward for an explicit
 * `[tool.uv.workspace]` declaration. A nearest pyproject without that table
 * is an implicit single-project workspace.
 *
 * The walk stops AT `homeDir` (`isAtOrAboveHomeDir`, the shared ceiling
 * primitive from #625) so a `pyproject.toml` sitting in `/tmp`, `/home`, or
 * `$HOME` itself cannot supply the environment for every project beneath it.
 * `homeDir` is injected rather than read from `os.homedir()` inside the walk
 * for the same reason every sibling walker takes it (#2536, #2544 F2): the
 * ceiling is otherwise untestable.
 */
async function findUvWorkspace(
	startDir: string,
	homeDir: string,
): Promise<UvWorkspace | undefined> {
	const resolvedStart = path.resolve(startDir);
	let nearestProject: string | undefined;
	for (const dir of walkUpDirs(startDir)) {
		if (isAtOrAboveHomeDir(dir, homeDir)) break;

		let content: string;
		try {
			content = await readFile(path.join(dir, "pyproject.toml"), "utf8");
		} catch {
			continue;
		}

		if (!nearestProject) nearestProject = dir;
		if (hasTomlTable(content, UV_WORKSPACE_TABLE)) {
			const workspaceTable = extractTomlTableSection(
				content,
				UV_WORKSPACE_TABLE,
			);
			return {
				root: dir,
				explicit: true,
				projectRoot: nearestProject,
				isStartDir: nearestProject === resolvedStart,
				members: parseTomlStringArray(workspaceTable, "members"),
				exclude: parseTomlStringArray(workspaceTable, "exclude"),
			};
		}
	}

	return nearestProject
		? {
				root: nearestProject,
				explicit: false,
				projectRoot: nearestProject,
				isStartDir: nearestProject === resolvedStart,
				members: [],
				exclude: [],
			}
		: undefined;
}

/**
 * Apply uv's explicit-workspace membership rules before inheriting its root
 * environment. The workspace root is always a member; descendants must match
 * a declared member glob and must not match an exclusion glob.
 *
 * The glob dialects are pinned to uv 3c979abda4530fe9bf3d92e9bcf5c5575e3b3126,
 * `crates/uv-workspace/src/workspace.rs`, and live beside the ONE shared
 * workspace-member matcher (#2591) instead of as a minimatch options block
 * here: `UV_WORKSPACE_MEMBERS_DIALECT` for `members`
 * (`is_included_in_workspace` — `MatchOptions { require_literal_separator:
 * true, ..MatchOptions::new() }`) and `UV_WORKSPACE_EXCLUDE_DIALECT` for
 * `exclude` (`WorkspaceExclusions::matches` — `Pattern::matches_path`, i.e.
 * `MatchOptions::new()` defaults, where `require_literal_separator` is FALSE
 * and a `*` therefore crosses `/`). Both normalize the pattern first
 * (`normalize_path`, so a leading `./` is not part of the pattern) and are
 * case-SENSITIVE on every platform with no literal-leading-dot requirement.
 *
 * That `exclude` option set used to be a documented limitation rather than
 * behavior: minimatch cannot express a separator-crossing `*`, so
 * `exclude = ['packages/a*c']` did not exclude `packages/a/b/c`. A dialect
 * object can, so #2591 implements it — the one intentional answer change in
 * that fold.
 */
function isUvWorkspaceMember(
	workspace: UvWorkspace,
	projectRoot: string,
): boolean {
	// No `projectRoot === workspace.root` shortcut. uv treats the workspace
	// root as a member of its own workspace, but only in its capacity as a
	// PROJECT — and a project already gets uv's settings through `isStartDir`,
	// with its own `<root>/.venv` reached by the ordinary project candidate at
	// the very same path. Answering "member" on directory equality made every
	// non-project subdirectory of the workspace root inherit the workspace
	// `.venv`, `exclude` included, because equality was tested before the
	// walk result was consulted (review round 3, S2). The relative-path guard
	// below returns false for the root itself, which is the intended answer.
	const relative = toPosix(path.relative(workspace.root, projectRoot));
	if (
		relative.length === 0 ||
		relative === ".." ||
		relative.startsWith("../") ||
		path.isAbsolute(relative)
	) {
		return false;
	}

	const matches =
		(dialect: WorkspaceMemberGlobDialect) =>
		(pattern: string): boolean =>
			matchesWorkspaceMemberPattern(pattern, relative, dialect, () =>
				recordDegradationOnce({
					kind: "workspace-glob-cap",
					subject: String(pattern.length),
					reason: "workspace glob matcher exceeded its memo-table cell cap",
				}),
			);
	return (
		!workspace.exclude.some(matches(UV_WORKSPACE_EXCLUDE_DIALECT)) &&
		workspace.members.some(matches(UV_WORKSPACE_MEMBERS_DIALECT))
	);
}

/**
 * #3871: the process-wide channels a shell can point at any environment on the
 * machine. A linked-worktree run (`allowAmbient: false`) takes one only when
 * its root lies inside the requested project root.
 */
/** Project-config-sourced environments, refused unless the project is trusted. */
const PROJECT_SOURCED_PYTHON_SOURCES = new Set<PythonEnvironmentSource>([
	"project-dot-venv",
	"project-venv",
	"uv-workspace",
]);

const AMBIENT_ENVIRONMENT_VARIABLES = {
	"uv-project-environment": "UV_PROJECT_ENVIRONMENT",
	"virtual-env": "VIRTUAL_ENV",
	conda: "CONDA_PREFIX",
} as const;

/** True when any ambient Python environment channel is set in `env`. */
export function hasAmbientPythonEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return Object.values(AMBIENT_ENVIRONMENT_VARIABLES).some((name) =>
		Boolean(env[name]),
	);
}

/**
 * Resolve the interpreter and executable directory for the project's Python
 * environment without activating it or invoking a package manager.
 */
export async function detectPythonEnvironment(
	projectRoot: string,
	homeDir: string = os.homedir(),
	options: { allowAmbient?: boolean } = {},
): Promise<PythonEnvironment | undefined> {
	// `path.resolve` once at the seam entry so `isStartDir` below compares like
	// with like: `walkUpDirs` resolves its input, a caller's argument need not
	// be normalized.
	const root = path.resolve(projectRoot);
	const uvWorkspace = await findUvWorkspace(root, homeDir);
	// `UV_PROJECT_ENVIRONMENT` and the workspace `.venv` are uv PROJECT
	// settings. uv applies them to a directory only when that directory IS the
	// project — a `pyproject.toml` merely sitting somewhere ABOVE it makes it a
	// subdirectory of a project, not a project, and nothing below a project
	// root inherits from it (the F3 decision, applied consistently). Exporting
	// `UV_PROJECT_ENVIRONMENT` process-wide is uv's own documented CI/Docker
	// recipe, so a gate on "a pyproject exists at or above root" lets one
	// image-level variable capture every subdirectory on the box that happens
	// to sit under some Python project.
	const isProjectRoot = uvWorkspace?.isStartDir === true;
	// A declared, non-excluded member of an EXPLICIT workspace is itself a
	// project root, so this is a strict refinement of `isProjectRoot`: it adds
	// the workspace `.venv` candidate and re-anchors a relative
	// `UV_PROJECT_ENVIRONMENT` at the workspace root.
	const memberWorkspaceRoot =
		isProjectRoot &&
		uvWorkspace.explicit &&
		isUvWorkspaceMember(uvWorkspace, root)
			? uvWorkspace.root
			: undefined;
	const uvEnvironmentRoot = isProjectRoot
		? (memberWorkspaceRoot ?? uvWorkspace.projectRoot)
		: undefined;
	const uvProjectEnvironment = process.env.UV_PROJECT_ENVIRONMENT;
	// PEP 723 `uv run --script` environments are cache-keyed by script content;
	// without a stable project marker or explicit path, they remain undiscoverable.
	const allowAmbient = options.allowAmbient ?? true;
	const isWithinProjectRoot = (candidateRoot: string): boolean => {
		const relative = path.relative(root, path.resolve(candidateRoot));
		return (
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			// #3871 V1: another Windows drive has no relative path, so
			// `path.relative` returns the absolute target: no `..`, not inside.
			!path.isAbsolute(relative)
		);
	};
	const candidates: Array<{
		root: string | undefined;
		source: PythonEnvironmentSource;
	}> = [
		...(uvEnvironmentRoot !== undefined && uvProjectEnvironment
			? [
					{
						// `path.resolve` leaves an absolute value untouched and
						// anchors a relative one at the project's workspace root.
						root: path.resolve(uvEnvironmentRoot, uvProjectEnvironment),
						source: "uv-project-environment" as const,
					},
				]
			: []),
		...(memberWorkspaceRoot !== undefined
			? [
					{
						root: path.join(memberWorkspaceRoot, ".venv"),
						source: "uv-workspace" as const,
					},
				]
			: []),
		{ root: process.env.VIRTUAL_ENV, source: "virtual-env" },
		{ root: process.env.CONDA_PREFIX, source: "conda" },
		{ root: path.join(root, ".venv"), source: "project-dot-venv" },
		{ root: path.join(root, "venv"), source: "project-venv" },
	];

	for (const candidate of candidates) {
		if (!candidate.root) continue;
		if (
			!allowAmbient &&
			candidate.source in AMBIENT_ENVIRONMENT_VARIABLES &&
			!isWithinProjectRoot(candidate.root)
		)
			continue;
		// A project-sourced interpreter (`.venv`, a uv workspace venv) is a
		// project-local executable and carries the same trust gate as every other
		// one (#4268 acceptance 1, MED-6): unknown/untrusted falls through to a
		// global interpreter, while an explicitly exported `VIRTUAL_ENV`,
		// `CONDA_PREFIX` or `UV_PROJECT_ENVIRONMENT` remains the user's own
		// choice. Explicit untrusted always refuses.
		if (
			PROJECT_SOURCED_PYTHON_SOURCES.has(candidate.source) &&
			getProjectTrustState() !== "trusted"
		) {
			if (
				recordDegradationOnce({
					kind: "trust-refusal",
					subject: `python-environment:${candidate.root}`,
					reason: `project Python environment refused: pi project trust is ${getProjectTrustState()}`,
				})
			) {
				logExtension({
					subsystem: "project-trust",
					level: "warn",
					message:
						"project Python environment refused: mark the project trusted in pi or upgrade pi",
					metadata: { source: candidate.source },
				});
			}
			continue;
		}
		const binDir = path.join(
			candidate.root,
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const pythonPath = path.join(
			binDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		try {
			await access(pythonPath);
			return {
				root: candidate.root,
				binDir,
				pythonPath,
				source: candidate.source,
			};
		} catch {
			// The marker can outlive its environment. Continue to the next candidate.
		}
	}

	return undefined;
}

/** Preserve the existing interpreter-only API used by LSP initialization. */
export async function detectPythonVenv(
	projectRoot: string,
): Promise<string | undefined> {
	return (await detectPythonEnvironment(projectRoot))?.pythonPath;
}

/**
 * Build a child-only environment for Python tools. The host process remains
 * unchanged, so another project can resolve a different environment.
 */
export function augmentPythonEnvironment(
	baseEnvironment: NodeJS.ProcessEnv,
	environment: PythonEnvironment | undefined,
): NodeJS.ProcessEnv {
	if (!environment) return baseEnvironment;

	const inheritedPath =
		baseEnvironment.PATH ?? baseEnvironment.Path ?? baseEnvironment.path ?? "";
	const augmentedPath = inheritedPath
		? `${environment.binDir}${path.delimiter}${inheritedPath}`
		: environment.binDir;
	const childEnvironment: NodeJS.ProcessEnv = {
		...baseEnvironment,
		PATH: augmentedPath,
		VIRTUAL_ENV: environment.root,
	};
	if (process.platform === "win32") childEnvironment.Path = augmentedPath;
	return childEnvironment;
}

/** Return explicit project-environment candidates before a bare PATH fallback. */
export function pythonEnvironmentToolCandidates(
	environment: PythonEnvironment | undefined,
	command: string,
): string[] {
	if (!environment) return [];
	if (process.platform !== "win32") {
		return [path.join(environment.binDir, command)];
	}
	return [
		path.join(environment.binDir, `${command}.exe`),
		path.join(environment.binDir, `${command}.cmd`),
		path.join(environment.binDir, command),
	];
}

/**
 * #4638: where a project declared its Python syntax level, named by the source
 * so a degradation record can say which declaration it overrode.
 */
export type PythonTargetVersionSource =
	| "ruff-target-version"
	| "pyright-python-version"
	| "requires-python"
	| "python-version-file";

export interface PythonTargetVersion {
	major: number;
	minor: number;
	source: PythonTargetVersionSource;
	/** Absolute path of the file that declared it. */
	file: string;
}

/** The LSP server whose `compile` verdict a project declaration outranks. */
export const PYTHON_COMPILE_VERDICT_SERVER_ID = "python-jedi";

/** First declared level at which jedi's own `compile` verdict is outranked. */
const PYTHON_COMPILE_VERDICT_FLOOR = { major: 3, minor: 14 } as const;

/**
 * jedi compiles a file with the interpreter it launched. Under a declared level
 * at or above the floor its `compile` row describes a grammar the project does
 * not use (PEP 758's unparenthesized `except` is the common case), so the row is
 * not evidence about this project. Every other server, source, and level keeps
 * its verdict, and no declaration keeps every verdict.
 */
export function isJediCompileVerdictOutranked(
	diagnostic: { serverId?: string; source?: string },
	declared: PythonTargetVersion | undefined,
): boolean {
	if (declared === undefined) return false;
	if (diagnostic.serverId !== PYTHON_COMPILE_VERDICT_SERVER_ID) return false;
	if (diagnostic.source !== "compile") return false;
	return (
		declared.major > PYTHON_COMPILE_VERDICT_FLOOR.major ||
		(declared.major === PYTHON_COMPILE_VERDICT_FLOOR.major &&
			declared.minor >= PYTHON_COMPILE_VERDICT_FLOOR.minor)
	);
}

interface DeclaredPythonVersion {
	major: number;
	minor: number;
}

function reducePythonVersion(
	match: RegExpMatchArray | null,
): DeclaredPythonVersion | undefined {
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Reduce one version-ish text to its major/minor. Anything that does not BEGIN
 * with `<major>.<minor>` names no CPython syntax level: `pypy-3.10`, a branch
 * name in `.python-version`, or a bare major `3` with no minor. A patch or
 * trailing suffix (`3.14.2`, `3.10-pypy`) is not part of the syntax level.
 */
function reduceBarePythonVersion(
	text: string,
): DeclaredPythonVersion | undefined {
	return reducePythonVersion(
		text.trim().match(/^v?(\d+)\.(\d+)(?:\.\d+)?[-+._a-z0-9]*$/i),
	);
}

/**
 * Reduce a PEP 440 specifier to its lower bound (`>=3.12`, `>=3.12,<4`,
 * `==3.14.*`, `~=3.11`). A clause with no inclusive lower bound (`<4`, `>3.12`,
 * `!=3.12`, `===3.12`) yields nothing rather than a guess, so a specifier made
 * only of those is absent.
 */
function reducePythonSpecifier(
	text: string,
): DeclaredPythonVersion | undefined {
	for (const clause of text.split(",")) {
		const lowerBound = reducePythonVersion(
			clause.trim().match(/^(?:>=|==|~=)\s*v?(\d+)\.(\d+)/),
		);
		if (lowerBound) return lowerBound;
	}
	return reduceBarePythonVersion(text);
}

/** `py312` -> 3.12. Ruff names the level this way and never as a bare version. */
function reduceRuffTargetVersion(
	text: string,
): DeclaredPythonVersion | undefined {
	return reducePythonVersion(text.trim().match(/^py(\d)(\d+)$/i));
}

function withSource(
	level: DeclaredPythonVersion | undefined,
	source: PythonTargetVersionSource,
	file: string,
): PythonTargetVersion | undefined {
	return level ? { ...level, source, file } : undefined;
}

/**
 * Read a declaration file. A missing file declares nothing, which is what the
 * walk is for; any other read failure is recorded once and also declares
 * nothing, so a probe never throws over an unreadable manifest.
 */
async function readDeclarationFile(
	filePath: string,
): Promise<string | undefined> {
	try {
		return await readFile(filePath, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		recordDegradationOnce({
			kind: "python-target-version-unreadable",
			subject: filePath,
			reason: `Python syntax-level declaration could not be read: ${err instanceof Error ? err.message : String(err)}`,
		});
		return undefined;
	}
}

/**
 * pyright's `pythonVersion`, from its own JSON config. Text that does not parse
 * is no declaration: pyright reads JSONC, and inventing a failure record for a
 * commented config would misreport a file pyright accepts.
 */
function parsePyrightJsonVersion(
	content: string,
): DeclaredPythonVersion | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		// none: unparseable text is no declaration (pyright reads JSONC, so a
		// commented config is a file pyright still accepts, not a failure); the
		// read that could fail is recorded as `python-target-version-unreadable`.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const value = (parsed as Record<string, unknown>).pythonVersion;
	return typeof value === "string" ? reduceBarePythonVersion(value) : undefined;
}

/**
 * The declarations one directory can hold, probed in the documented order:
 * ruff `target-version`, pyright `pythonVersion`, `requires-python`, then
 * `.python-version`. Within a tier the nearest declaration wins, so the first
 * directory that declares anything answers for the file.
 */
async function readPythonDeclarationInDirectory(
	dir: string,
): Promise<PythonTargetVersion | undefined> {
	const pyprojectPath = join(dir, "pyproject.toml");
	const pyproject = await readDeclarationFile(pyprojectPath);
	const ruffSection =
		pyproject !== undefined && hasTomlTable(pyproject, "tool\\.ruff")
			? extractTomlTableSection(pyproject, "tool\\.ruff")
			: undefined;

	// Ruff reads ONE config file per project: pyproject `[tool.ruff]`, else
	// `.ruff.toml`, else `ruff.toml`. A file with no usable `target-version` ends
	// the ruff tier rather than falling through to a spelling ruff would ignore.
	let ruffFile = ruffSection !== undefined ? pyprojectPath : undefined;
	let ruffContent = ruffSection;
	if (ruffFile === undefined) {
		for (const name of [".ruff.toml", "ruff.toml"]) {
			const candidatePath = join(dir, name);
			const content = await readDeclarationFile(candidatePath);
			if (content === undefined) continue;
			ruffFile = candidatePath;
			ruffContent = content;
			break;
		}
	}
	if (ruffFile !== undefined && ruffContent !== undefined) {
		const target = parseTomlScalarString(ruffContent, "target-version");
		const resolved = withSource(
			target ? reduceRuffTargetVersion(target) : undefined,
			"ruff-target-version",
			ruffFile,
		);
		if (resolved) return resolved;
	}

	const pyrightConfigPath = join(dir, "pyrightconfig.json");
	const pyrightConfig = await readDeclarationFile(pyrightConfigPath);
	if (pyrightConfig !== undefined) {
		const resolved = withSource(
			parsePyrightJsonVersion(pyrightConfig),
			"pyright-python-version",
			pyrightConfigPath,
		);
		if (resolved) return resolved;
	} else if (pyproject !== undefined) {
		const section = extractTomlTableSection(pyproject, "tool\\.pyright");
		const raw = section
			? parseTomlScalarString(section, "pythonVersion")
			: undefined;
		const resolved = withSource(
			raw ? reduceBarePythonVersion(raw) : undefined,
			"pyright-python-version",
			pyprojectPath,
		);
		if (resolved) return resolved;
	}

	if (pyproject !== undefined) {
		const projectSection = extractTomlTableSection(pyproject, "project");
		const raw =
			projectSection !== undefined
				? parseTomlScalarString(projectSection, "requires-python")
				: undefined;
		const resolved = withSource(
			raw ? reducePythonSpecifier(raw) : undefined,
			"requires-python",
			pyprojectPath,
		);
		if (resolved) return resolved;
	}

	const versionFilePath = join(dir, ".python-version");
	const versionFile = await readDeclarationFile(versionFilePath);
	if (versionFile !== undefined) {
		const firstLine = (versionFile.split(/\r?\n/, 1)[0] ?? "").trim();
		const resolved = withSource(
			reduceBarePythonVersion(firstLine),
			"python-version-file",
			versionFilePath,
		);
		if (resolved) return resolved;
	}

	return undefined;
}

/**
 * #4638: the Python syntax level the project declares for `filePath`, or
 * undefined when it declares none. Walks up from the file's directory (so every
 * project root is on the way) and stops at `homeDir`, the shared ceiling for
 * walk-up discovery. Only a Python source file has an answer, so a mixed sweep
 * pays nothing for its other files.
 *
 * A declaration that names no CPython major/minor is absent, never a default:
 * guessing a level is what produced the spurious `compile` verdict in the first
 * place.
 */
export async function detectPythonTargetVersion(
	filePath: string,
	homeDir: string = os.homedir(),
): Promise<PythonTargetVersion | undefined> {
	if (resolveLanguage(filePath)?.id !== "python") return undefined;
	for (const dir of walkUpDirs(dirname(resolve(filePath)))) {
		if (isAtOrAboveHomeDir(dir, homeDir)) return undefined;
		const resolved = await readPythonDeclarationInDirectory(dir);
		if (resolved) return resolved;
	}
	return undefined;
}
