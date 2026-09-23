// lane: windows-vitest — the case-variant cells below assert the HOST
// filesystem's own case-folding answer, and only a real Windows (or APFS) host
// answers it `true`; that arm is also the per-member mutation signature for the
// eight members whose reported spelling is byte-identical to our argv on POSIX.
// Every boundary mocked here is a process boundary (`safe-spawn`, the
// availability probes, `rust-client`), so the lane needs no Go, Java, Kotlin,
// .NET, Dart, Zig, Rust or CUE toolchain.
/**
 * #3278 — ONE seam answers "is this reported diagnostic about the file I
 * dispatched for?" for every runner:
 * `pathsEqual(path.resolve(<the cwd the tool RAN in>, reported), absTarget)`.
 *
 * Every cell enters through the REAL `createDispatchContext` + `dispatchForFile`
 * + `RunnerRegistry`: the defect is about the relationship between the
 * DISPATCHER's spelling of the file and the TOOL's, and a parser called
 * directly with a hand-made target cannot show it. The project root is always
 * NESTED two levels inside the temp dir and is never `process.cwd()`, so a
 * spelling that is relative to the runner cwd resolves to a DIFFERENT file
 * under the no-base `path.resolve` this change deletes.
 *
 * Recurrence prevented, per direction:
 *
 * - DROPPED (#209 / #3277): the tool's spelling of the edited file differs from
 *   the dispatcher's, the local compare drops every line for that file, and a
 *   run with a real finding is reported clean (or degrades to #1816's
 *   unparseable-output path). Reproduced from upstream source for
 *   `golangci-lint`, whose `PathPrettifier` OVERWRITES `Pos.Filename` with
 *   `filepath.Rel(basePath, …)` before the JSON printer sees it (v1.64.8
 *   `pkg/result/processors/path_prettifier.go:31` + `path_relativity.go:43`).
 * - OVER-MERGED: a DIFFERENT file's finding is attributed to the edited one.
 *   Reproduced from upstream source for `cue-vet`, whose locations are printed
 *   relative to the vet cwd with a `./` prefix (v0.11.0
 *   `cue/errors/errors.go:586-596`), so an imported package's file that merely
 *   SHARES the touched file's basename matched the old
 *   `path.posix.basename(...) === fileName` compare.
 * - CASE: a case-variant spelling must be ONE file exactly where the
 *   filesystem says it is, and two files where it does not — measured, never
 *   assumed from `process.platform`.
 *
 * The other eight members are handed the absolute target as argv and echo it
 * back (MEASURED for gcc 15.2.0 on this host; read from upstream for the rest —
 * see the PR's premise table), so for them the fold is behaviour-preserving
 * TODAY and these cells say so rather than feeding a spelling the tool never
 * emits (#2432: a double that mirrors the assumption proves nothing). Their
 * per-member proof is `tests/config/reported-path-attribution-sweep.test.ts`
 * plus the two mutation directions of the shared predicate.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, unavailableCommands, cargoPath } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	unavailableCommands: { current: new Set<string>() },
	cargoPath: { current: "/usr/bin/cargo" as string | null },
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
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => !unavailableCommands.current.has(command),
			isAvailableAsync: async () => !unavailableCommands.current.has(command),
			getCommand: () =>
				unavailableCommands.current.has(command) ? null : command,
		}),
		resolveAvailableOrInstall: async (_c: unknown, toolId: string) =>
			unavailableCommands.current.has(toolId) ? null : toolId,
		createCwdCachedProbe: () =>
			Object.assign(async () => true, {
				getVerdict: () => ({ outcome: "ok" as const }),
			}),
	}),
);

vi.mock("../../../../clients/rust-client.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/rust-client.js")
	>()),
	rustClient: {
		async findCargoPathAsync() {
			return cargoPath.current;
		},
	},
}));

/** Text every fixture output carries, so no cell can pass on a diagnostic the
 * runner manufactured for some other reason (an #1816 parse-error row). */
const MARKER = "lens3278";

interface Member {
	/** How the PR body's premise table names this member. */
	name: string;
	/** Runner id, as the registry knows it. */
	runnerId: string;
	modulePath: string;
	/** The dispatched file, POSIX-relative to the project root. */
	file: string;
	/** A DIFFERENT file under the same root, POSIX-relative. */
	sibling: string;
	fileContent: string;
	/** Config files this runner's own gates require before it will spawn. */
	prepare?(root: string): void;
	/** Commands the availability double must report absent. */
	unavailable?: string[];
	/** The tool's real output shape, naming `reported` at line 4 column 5. */
	output(reported: string): {
		status: number;
		stdout?: string;
		stderr?: string;
	};
	/** Dispatch status/semantic when the finding DOES attach. */
	attached: { status: string; semantic: string };
}

/** What a spelling function may read to build the tool's reported path. */
interface Spelling {
	/** The cwd the runner really spawns the tool in. */
	runnerCwd: string;
	/** The absolute path the runner hands the tool as argv. */
	argvPath: string;
	/** A sibling file under the same root, absolute. */
	siblingPath: string;
}

interface Observed {
	status: string | undefined;
	semantic: string | undefined;
	diagnostics: Array<{ line?: number; filePath?: string; message?: string }>;
	dispatchedPath: string;
	reported: string;
}

/**
 * Does THIS filesystem fold case? Measured once against a real temp directory,
 * never asserted from `process.platform` (#3159 round 2: a platform-shaped case
 * claim redded EEXIST on the first real macOS run). APFS and NTFS answer true,
 * ext4 answers false, and every case-variant cell asserts the filesystem's own
 * answer, so ONE cell is live on the ubuntu, macOS and windows lanes with
 * opposite expectations instead of being skipped off Windows.
 */
function hostFoldsPathCase(): boolean {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3278-case-"));
	try {
		fs.writeFileSync(path.join(probe, "probe.txt"), "");
		return fs.existsSync(path.join(probe, "PROBE.txt"));
	} finally {
		fs.rmSync(probe, { recursive: true, force: true });
	}
}

const HOST_FOLDS_PATH_CASE = hostFoldsPathCase();

/**
 * Drive ONE runner outcome through the real dispatcher, with the tool reporting
 * whatever `spell` builds from the runner's own resolved cwd and argv path.
 * Throws when the tool was never spawned: a gate-skip that read as "nothing
 * attached" would make every cell here vacuous (#448).
 */
async function dispatch(
	member: Member,
	spell: (spelling: Spelling) => string,
): Promise<Observed> {
	vi.resetModules();
	safeSpawnAsync.mockReset();
	unavailableCommands.current = new Set(member.unavailable ?? []);
	cargoPath.current = "/usr/bin/cargo";
	const env = setupTestEnvironment(`pi-lens-3278-${member.runnerId}-`);
	try {
		// NESTED: the runner cwd is never `process.cwd()`, which is what makes a
		// no-base `path.resolve` of the reported spelling observably wrong.
		const root = path.join(env.tmpDir, "workspace", "pkg");
		const absFile = path.join(root, ...member.file.split("/"));
		const absSibling = path.join(root, ...member.sibling.split("/"));
		fs.mkdirSync(path.dirname(absFile), { recursive: true });
		fs.mkdirSync(path.dirname(absSibling), { recursive: true });
		fs.writeFileSync(absFile, member.fileContent);
		fs.writeFileSync(absSibling, member.fileContent);
		member.prepare?.(root);

		const { createDispatchContext, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const { resolveRunnerCwd } =
			await import("../../../../clients/tool-cwd.js");
		const runner = (await import(member.modulePath)).default;
		const registry = new RunnerRegistry();
		registry.register(runner);
		const ctx = createDispatchContext(
			absFile,
			root,
			{ getFlag: () => false } as never,
			new FactStore(),
		);
		const runnerCwd = resolveRunnerCwd(ctx, member.runnerId);
		const reported = spell({
			runnerCwd,
			argvPath: path.resolve(runnerCwd, ctx.filePath),
			siblingPath: absSibling,
		});
		const outcome = member.output(reported);
		safeSpawnAsync.mockResolvedValue({
			status: outcome.status,
			stdout: outcome.stdout ?? "",
			stderr: outcome.stderr ?? "",
			error: null,
		} as never);

		let status: string | undefined;
		let semantic: string | undefined;
		let diagnostics: Observed["diagnostics"] = [];
		await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: [member.runnerId] }],
			registry,
			(_runnerId, result) => {
				status = result.status;
				semantic = result.semantic;
				diagnostics = result.diagnostics;
			},
		);
		if (safeSpawnAsync.mock.calls.length === 0) {
			throw new Error(
				`${member.name}: the tool was never spawned — a gate skipped the run, ` +
					"so this cell would assert nothing about path attribution",
			);
		}
		return {
			status,
			semantic,
			diagnostics,
			dispatchedPath: ctx.filePath,
			reported,
		};
	} finally {
		env.cleanup();
	}
}

/** The spelling a tool emits when it names the file relative to its own cwd. */
const cwdRelative =
	(member: Member) =>
	({ runnerCwd, argvPath }: Spelling) =>
		path.relative(runnerCwd, argvPath).split(path.sep).join("/") || member.file;

/** The spelling a tool emits when it echoes the absolute argv path back. */
const echoesArgv = ({ argvPath }: Spelling) => argvPath;

/** The absolute argv spelling with its basename upper-cased. */
const caseVariantOfArgv = ({ argvPath }: Spelling) =>
	path.join(path.dirname(argvPath), path.basename(argvPath).toUpperCase());

/** The absolute spelling of a DIFFERENT file under the same root. */
const echoesSibling = ({ siblingPath }: Spelling) => siblingPath;

/** The tool's finding reached the agent, attributed to the dispatched file. */
function expectAttached(observed: Observed, member: Member): void {
	const attributed = observed.diagnostics.filter((diagnostic) =>
		diagnostic.message?.includes(MARKER),
	);
	expect(attributed).toHaveLength(1);
	expect(attributed[0]?.line).toBe(4);
	expect(attributed[0]?.filePath).toBe(observed.dispatchedPath);
	expect(observed.status).toBe(member.attached.status);
	expect(observed.semantic).toBe(member.attached.semantic);
}

/**
 * The tool's finding did NOT reach the agent as this file's problem. Asserted on
 * the MARKER rather than on `diagnostics.length`, because a nonzero exit whose
 * output parsed to nothing legitimately yields ONE #1816 parse-error row — that
 * row is not the tool's finding and must not make an over-merge look filtered.
 */
function expectDetached(observed: Observed): void {
	expect(
		observed.diagnostics.filter((diagnostic) =>
			diagnostic.message?.includes(MARKER),
		),
	).toEqual([]);
}

/** Exactly what THIS filesystem says about a case-variant spelling. */
function expectFilesystemAnswer(observed: Observed, member: Member): void {
	if (HOST_FOLDS_PATH_CASE) expectAttached(observed, member);
	else expectDetached(observed);
}
const MEMBERS: Member[] = [
	{
		name: "golangci-lint",
		attached: { status: "succeeded", semantic: "warning" },
		runnerId: "golangci-lint",
		modulePath: "../../../../clients/dispatch/runners/golangci-lint.js",
		file: "sub/b.go",
		sibling: "sub/a.go",
		fileContent: "package sub\n",
		prepare(root) {
			fs.writeFileSync(path.join(root, "go.mod"), "module demo\n");
			fs.writeFileSync(
				path.join(root, ".golangci.yml"),
				"linters:\n  enable:\n    - govet\n",
			);
		},
		output: (reported) => ({
			status: 1,
			stdout: JSON.stringify({
				Issues: [
					{
						FromLinter: "govet",
						Text: `printf format %d has arg of wrong type (${MARKER})`,
						Severity: "",
						Pos: { Filename: reported, Offset: 0, Line: 4, Column: 5 },
					},
				],
			}),
		}),
	},
	{
		name: "rust-clippy",
		attached: { status: "succeeded", semantic: "warning" },
		runnerId: "rust-clippy",
		modulePath: "../../../../clients/dispatch/runners/rust-clippy.js",
		file: "src/main.rs",
		sibling: "src/other.rs",
		fileContent: "fn main() {}\n",
		prepare(root) {
			fs.writeFileSync(
				path.join(root, "Cargo.toml"),
				'[package]\nname = "demo"\nversion = "0.1.0"\n',
			);
		},
		output: (reported) => ({
			status: 0,
			stdout: `${JSON.stringify({
				reason: "compiler-message",
				message: {
					code: { code: "unused_variables" },
					message: `unused variable: \`x\` (${MARKER})`,
					level: "warning",
					spans: [{ file_name: reported, line_start: 4, column_start: 5 }],
				},
			})}\n`,
		}),
	},
	{
		name: "javac",
		attached: { status: "failed", semantic: "warning" },
		runnerId: "javac",
		modulePath: "../../../../clients/dispatch/runners/javac.js",
		file: "src/App.java",
		sibling: "src/Other.java",
		fileContent: "class App {}\n",
		output: (reported) => ({
			status: 1,
			stderr: `${reported}:4: error: cannot find symbol (${MARKER})\n`,
		}),
	},
	{
		name: "zig-check",
		attached: { status: "failed", semantic: "warning" },
		runnerId: "zig-check",
		modulePath: "../../../../clients/dispatch/runners/zig-check.js",
		file: "src/main.zig",
		sibling: "src/other.zig",
		fileContent: "pub fn main() void {}\n",
		output: (reported) => ({
			status: 1,
			stderr: `${reported}:4:5: error: expected type 'u8' (${MARKER})\n`,
		}),
	},
	{
		name: "detekt",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "detekt",
		modulePath: "../../../../clients/dispatch/runners/detekt.js",
		file: "src/Main.kt",
		sibling: "src/Other.kt",
		fileContent: "fun main() {}\n",
		prepare(root) {
			fs.writeFileSync(
				path.join(root, "detekt.yml"),
				"build:\n  maxIssues: 0\n",
			);
		},
		output: (reported) => ({
			status: 1,
			stdout: `${reported}:4:5: error: This expression contains a magic number (${MARKER}) [MagicNumber]\n`,
		}),
	},
	{
		name: "cpp-check (gcc)",
		attached: { status: "failed", semantic: "warning" },
		runnerId: "cpp-check",
		modulePath: "../../../../clients/dispatch/runners/cpp-check.js",
		file: "src/a.c",
		sibling: "src/b.c",
		fileContent: "int main(void){return 0;}\n",
		output: (reported) => ({
			status: 1,
			stderr: `${reported}:4:5: error: 'q' undeclared (${MARKER})\n`,
		}),
	},
	{
		name: "cpp-check (msvc)",
		attached: { status: "failed", semantic: "warning" },
		runnerId: "cpp-check",
		modulePath: "../../../../clients/dispatch/runners/cpp-check.js",
		file: "src/a.c",
		sibling: "src/b.c",
		fileContent: "int main(void){return 0;}\n",
		unavailable: ["clang", "gcc", "cc", "clang++", "g++", "c++"],
		output: (reported) => ({
			status: 1,
			stdout: `${reported}(4,5): error C2065: 'q': undeclared identifier (${MARKER})\n`,
		}),
	},
	{
		name: "dotnet-build",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "dotnet-build",
		modulePath: "../../../../clients/dispatch/runners/dotnet-build.js",
		file: "Program.cs",
		sibling: "Other.cs",
		fileContent: "class Program {}\n",
		prepare(root) {
			fs.writeFileSync(
				path.join(root, "Demo.csproj"),
				'<Project Sdk="Microsoft.NET.Sdk" />\n',
			);
		},
		output: (reported) => ({
			status: 1,
			stdout: `${reported}(4,5): error CS0103: The name 'q' does not exist (${MARKER})\n`,
		}),
	},
	{
		name: "dart-analyze",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "dart-analyze",
		modulePath: "../../../../clients/dispatch/runners/dart-analyze.js",
		file: "lib/main.dart",
		sibling: "lib/other.dart",
		fileContent: "void main() {}\n",
		output: (reported) => ({
			status: 1,
			stderr: `ERROR|COMPILE_TIME_ERROR|UNDEFINED_IDENTIFIER|${reported}|4|5|3|Undefined name 'q' (${MARKER})\n`,
		}),
	},
	{
		name: "cue-vet",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "cue-vet",
		modulePath: "../../../../clients/dispatch/runners/cue-vet.js",
		file: "config.cue",
		sibling: "sub/config.cue",
		fileContent: "package demo\n\na: int\n",
		output: (reported) => ({
			status: 1,
			stderr: `a: conflicting values int and "hello" (${MARKER}):\n    ${reported}:4:5\n`,
		}),
	},
];

const [
	golangciLint,
	rustClippy,
	javac,
	zigCheck,
	detekt,
	cppCheckGcc,
	cppCheckMsvc,
	dotnetBuild,
	dartAnalyze,
	cueVet,
] = MEMBERS;

/** `cue` prefixes a cwd-relative position with `./` (v0.11.0 errors.go:590-596). */
const cueRelative =
	(target: (spelling: Spelling) => string) => (spelling: Spelling) =>
		`./${path
			.relative(spelling.runnerCwd, target(spelling))
			.split(path.sep)
			.join("/")}`;

// ── golangci-lint — reproduced defect (relative Pos.Filename) ────────────────

describe("golangci-lint reported-path attribution (#3278)", () => {
	it("attributes a cwd-relative golangci-lint Pos.Filename to the dispatched file (#3278)", async () => {
		const observed = await dispatch(golangciLint, cwdRelative(golangciLint));
		expect(observed.reported).toBe("sub/b.go");
		expectAttached(observed, golangciLint);
	});

	it("does not attribute a sibling Go file's golangci-lint finding to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(golangciLint, echoesSibling));
	});

	it("treats a case-variant golangci-lint path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(golangciLint, caseVariantOfArgv),
			golangciLint,
		);
	});
});

// ── cue-vet — reproduced defect (basename over-merge) ────────────────────────

describe("cue-vet reported-path attribution (#3278)", () => {
	it("does not attribute a sibling-directory cue location that shares the touched file's basename (#3278)", async () => {
		const observed = await dispatch(cueVet, cueRelative(echoesSibling));
		expect(observed.reported).toBe("./sub/config.cue");
		expectDetached(observed);
	});

	it("attributes a './'-prefixed cue location for the touched file itself (#3278)", async () => {
		const observed = await dispatch(cueVet, cueRelative(echoesArgv));
		expect(observed.reported).toBe("./config.cue");
		expectAttached(observed, cueVet);
	});

	it("treats a case-variant cue location exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(await dispatch(cueVet, caseVariantOfArgv), cueVet);
	});
});

// ── the eight argv-echo members — two-directional contract pins ──────────────

describe("rust-clippy reported-path attribution (#3278)", () => {
	it("attributes a package-relative clippy span to the dispatched file (#3278)", async () => {
		expectAttached(
			await dispatch(rustClippy, cwdRelative(rustClippy)),
			rustClippy,
		);
	});

	it("does not attribute a crate-mate's clippy span to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(rustClippy, echoesSibling));
	});

	it("treats a case-variant clippy span exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(rustClippy, caseVariantOfArgv),
			rustClippy,
		);
	});
});

describe("javac reported-path attribution (#3278)", () => {
	it("attributes the absolute path javac echoes back to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(javac, echoesArgv), javac);
	});

	it("does not attribute a sibling Java file's javac error to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(javac, echoesSibling));
	});

	it("treats a case-variant javac path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(await dispatch(javac, caseVariantOfArgv), javac);
	});
});

describe("zig-check reported-path attribution (#3278)", () => {
	it("attributes the absolute path zig echoes back to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(zigCheck, echoesArgv), zigCheck);
	});

	it("does not attribute a sibling Zig file's error to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(zigCheck, echoesSibling));
	});

	it("treats a case-variant zig path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(zigCheck, caseVariantOfArgv),
			zigCheck,
		);
	});
});

describe("detekt reported-path attribution (#3278)", () => {
	it("attributes the absolute path detekt echoes back to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(detekt, echoesArgv), detekt);
	});

	it("does not attribute a sibling Kotlin file's detekt finding to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(detekt, echoesSibling));
	});

	it("treats a case-variant detekt path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(await dispatch(detekt, caseVariantOfArgv), detekt);
	});
});

describe("cpp-check gcc-flavour reported-path attribution (#3278)", () => {
	it("attributes the absolute path gcc echoes back to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(cppCheckGcc, echoesArgv), cppCheckGcc);
	});

	it("does not attribute an included header's gcc error to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(cppCheckGcc, echoesSibling));
	});

	it("treats a case-variant gcc path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(cppCheckGcc, caseVariantOfArgv),
			cppCheckGcc,
		);
	});
});

describe("cpp-check msvc-flavour reported-path attribution (#3278)", () => {
	it("attributes the absolute path cl echoes back to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(cppCheckMsvc, echoesArgv), cppCheckMsvc);
	});

	it("does not attribute another translation unit's cl error to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(cppCheckMsvc, echoesSibling));
	});

	it("treats a case-variant cl path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(cppCheckMsvc, caseVariantOfArgv),
			cppCheckMsvc,
		);
	});
});

describe("dotnet-build reported-path attribution (#3278)", () => {
	it("attributes the full path MSBuild reports to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(dotnetBuild, echoesArgv), dotnetBuild);
	});

	it("does not attribute a sibling C# file's compiler error to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(dotnetBuild, echoesSibling));
	});

	it("treats a case-variant MSBuild path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(dotnetBuild, caseVariantOfArgv),
			dotnetBuild,
		);
	});
});

describe("dart-analyze reported-path attribution (#3278)", () => {
	it("attributes the absolute path dart analyze reports to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(dartAnalyze, echoesArgv), dartAnalyze);
	});

	// The `endsWith` arm this fold deleted accepted ANY reported path whose TAIL
	// spelled the dispatched file, with no separator or case rule of its own.
	it("does not attribute a sibling Dart file's diagnostic to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(dartAnalyze, echoesSibling));
	});

	it("treats a case-variant dart path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(dartAnalyze, caseVariantOfArgv),
			dartAnalyze,
		);
	});
});
