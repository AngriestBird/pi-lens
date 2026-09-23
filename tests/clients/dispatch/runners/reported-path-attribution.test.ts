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
 *
 * `gleam-check` is the ELEVENTH member and the one this file could not cover
 * when it was written (#3285): its reported spelling arrives inside
 * codespan_reporting's `┌─` locus gutter, an `endsWith` was tolerating that
 * gutter, and #3284 had no captured gleam output to establish the gutter's shape
 * from. Its cells feed a REAL upstream-rendered vector
 * (`tests/fixtures/gleam-codespan/`), so the fold is proven against gleam's own
 * renderer rather than against a guess at it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, unavailableCommands, CARGO_PATH } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	/** Commands the availability double reports as absent (cpp-check's MSVC arm). */
	unavailableCommands: { current: new Set<string>() },
	/** rust-clippy resolves cargo through its own client, not the shared probe. */
	CARGO_PATH: "/usr/bin/cargo",
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
			return CARGO_PATH;
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
	diagnostics: Array<{
		line?: number;
		column?: number;
		filePath?: string;
		message?: string;
	}>;
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
/**
 * gleam's own rendering of a located error, byte-identical to the upstream
 * snapshot it was taken from:
 *
 *   curl -s https://raw.githubusercontent.com/gleam-lang/gleam/v1.18.1/compiler-core/src/type_/tests/snapshots/gleam_core__type___tests__assert__mismatched_types.snap \
 *     | diff - tests/fixtures/gleam-codespan/gleam-v1.18.1-assert-mismatched-types.snap.txt
 *
 * The vector is generated by UPSTREAM code, not by a transcription of it: that
 * snapshot's `----- ERROR` section is `Error::pretty_string()`
 * (`compiler-core/src/error.rs:978-989` at v1.18.1), which writes through the
 * same `Diagnostic::write` → `codespan_reporting::term::emit` the CLI's own
 * error printer uses (`compiler-cli/src/lib.rs:927-940`), into a
 * `Buffer::no_color()` — exactly what `gleam check` writes to stderr when its
 * stderr is a pipe (`compiler-cli/src/cli.rs:189-207`). #2432 is the recurrence:
 * a test double shaped from an issue's DESCRIPTION of a tool's output proves
 * nothing about the tool.
 */
const GLEAM_VECTOR = path.resolve(
	import.meta.dirname,
	"../../../fixtures/gleam-codespan/gleam-v1.18.1-assert-mismatched-types.snap.txt",
);

/** codespan's locus line inside that vector: `  ┌─ /src/one/two.gleam:1:8`. */
const GLEAM_VECTOR_LOCUS = /^(\s*┌─ )(\S.*):(\d+):(\d+)$/m;

/** The line and column the upstream vector's own locus line names. */
const GLEAM_VECTOR_LINE = 1;
const GLEAM_VECTOR_COLUMN = 8;

/**
 * The upstream vector's error block with ONLY the locus line's file name
 * swapped for `reported` — its gutter, its `:line:column`, its border lines and
 * its snippet stay upstream's bytes. Throws rather than silently degrading if a
 * fixture refresh ever removes the gutter, which is the whole point of the
 * vector.
 */
/**
 * The same rendering with the gutter coloured, which is what gleam emits when
 * `FORCE_COLOR` is non-empty: codespan wraps `chars().snippet_start` in the
 * source-border style and resets after it (codespan-reporting 0.13.1
 * `src/term/renderer.rs:386-388`), cyan by default (`src/term/config.rs:246`),
 * and termcolor writes that as the SGR pair below. The exact parameters are
 * codespan's choice; what this pins is the STRUCTURE — an escape sequence
 * between the line start and the gutter.
 */
function colourTheGutter(rendered: string): string {
	return rendered.replace("┌─", "\u001b[36m┌─\u001b[0m");
}

function gleamCheckStderr(reported: string): string {
	const marker = "----- ERROR\n";
	const upstream = fs.readFileSync(GLEAM_VECTOR, "utf8");
	const rendered = upstream.slice(upstream.indexOf(marker) + marker.length);
	const locus = GLEAM_VECTOR_LOCUS.exec(rendered);
	if (!locus)
		throw new Error(
			`the upstream gleam vector no longer carries a codespan locus line: ${GLEAM_VECTOR}`,
		);
	return rendered.replace(
		locus[0],
		`${locus[1]}${reported}:${locus[3]}:${locus[4]}`,
	);
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
	{
		name: "gleam-check",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "gleam-check",
		modulePath: "../../../../clients/dispatch/runners/gleam-check.js",
		file: "src/app.gleam",
		sibling: "src/other.gleam",
		fileContent: "pub fn main() {\n  assert 10\n}\n",
		prepare(root) {
			// gleam's own root rule and ours are the same marker: the CLI walks up
			// for `gleam.toml` (`compiler-cli/src/fs.rs:46-62`) and
			// `clients/language-profile.ts:63` anchors the runner cwd on it.
			fs.writeFileSync(path.join(root, "gleam.toml"), 'name = "demo"\n');
		},
		// gleam check takes no file argument; it compiles the project and prints
		// through codespan, to STDERR (`compiler-cli/src/lib.rs:927-940`).
		output: (reported) => ({ status: 1, stderr: gleamCheckStderr(reported) }),
	},
	{
		name: "gleam-check (colour-forced)",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "gleam-check",
		modulePath: "../../../../clients/dispatch/runners/gleam-check.js",
		file: "src/app.gleam",
		sibling: "src/other.gleam",
		fileContent: "pub fn main() {\n  assert 10\n}\n",
		prepare(root) {
			fs.writeFileSync(path.join(root, "gleam.toml"), 'name = "demo"\n');
		},
		output: (reported) => ({
			status: 1,
			stderr: colourTheGutter(gleamCheckStderr(reported)),
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
	gleamCheck,
	gleamCheckColoured,
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

// ── gleam-check — the codespan gutter member (#3285) ─────────────────────────

/**
 * gleam's finding is recognized by the LINE:COLUMN the upstream vector's locus
 * names, not by a marker in the message: this runner takes the first non-blank
 * line AFTER the locus as the message, and in every codespan rich rendering
 * that line is the empty border `│` (`renderer.rs` writes the snippet start,
 * then a bordered blank line, then the source line). The #1816 fallback row a
 * nonzero exit with no parsed location produces carries NO line or column, so it
 * can never be mistaken for the finding.
 */
function gleamFindings(observed: Observed) {
	return observed.diagnostics.filter(
		(diagnostic) =>
			diagnostic.line === GLEAM_VECTOR_LINE &&
			diagnostic.column === GLEAM_VECTOR_COLUMN,
	);
}

function expectGleamAttached(observed: Observed, member: Member): void {
	const attributed = gleamFindings(observed);
	expect(attributed).toHaveLength(1);
	expect(attributed[0]?.filePath).toBe(observed.dispatchedPath);
	// F14: the fold must change WHICH lines attach, nothing else. This is the
	// message today — codespan's own empty border line, because the message
	// extraction takes the first non-blank line after the locus. Pinned as
	// CURRENT behaviour, not endorsed: filed separately as #3292.
	expect(attributed[0]?.message).toBe("│");
	expect(observed.status).toBe(member.attached.status);
	expect(observed.semantic).toBe(member.attached.semantic);
}

function expectGleamDetached(observed: Observed): void {
	expect(gleamFindings(observed)).toEqual([]);
}

describe("gleam-check reported-path attribution (#3285)", () => {
	it("pins the upstream gleam vector's codespan locus gutter (#3285)", () => {
		// The vector is the premise. If a refresh ever drops the gutter or the
		// `:line:column` suffix, the cells below would silently stop covering the
		// shape that made #3284 revert its fold.
		const upstream = fs.readFileSync(GLEAM_VECTOR, "utf8");
		expect(upstream).toContain("----- ERROR\nerror: Type mismatch\n");
		expect(upstream).toContain(
			`  ┌─ /src/one/two.gleam:${GLEAM_VECTOR_LINE}:${GLEAM_VECTOR_COLUMN}`,
		);
		expect(gleamCheckStderr("/abs/proj/src/app.gleam")).toContain(
			`  ┌─ /abs/proj/src/app.gleam:${GLEAM_VECTOR_LINE}:${GLEAM_VECTOR_COLUMN}`,
		);
	});

	it("attributes a codespan-guttered gleam locus line to the dispatched file (#3285)", async () => {
		const observed = await dispatch(gleamCheck, echoesArgv);
		// gleam's `location.path` is absolute by construction: the CLI walks up
		// from the absolute cwd to `gleam.toml` and joins `src`
		// (`compiler-cli/src/fs.rs:32-62`, `compiler-core/src/paths.rs:42-48`).
		expect(observed.reported).toBe(observed.dispatchedPath);
		expectGleamAttached(observed, gleamCheck);
	});

	// gleam colours the gutter whenever FORCE_COLOR is non-empty, whatever stderr
	// is (`compiler-cli/src/cli.rs:194-207`). The pre-#3285 suffix compare never
	// saw the line's prefix; an anchored capture without `stripAnsi` refuses the
	// whole line and drops every diagnostic in that environment.
	it("still attributes a colour-forced gleam locus line (#3285)", async () => {
		const observed = await dispatch(gleamCheckColoured, echoesArgv);
		expectGleamAttached(observed, gleamCheckColoured);
	});

	// The over-merge direction: one gleam diagnostic renders one locus line PER
	// FILE GROUP — an extra label in another module adds a second `files.add`
	// and a second `┌─` line (`compiler-core/src/diagnostic.rs:100-113`) — so a
	// sibling module's locus must not be charged to the edited file.
	it("does not attribute a sibling gleam module's guttered locus line (#3285)", async () => {
		expectGleamDetached(await dispatch(gleamCheck, echoesSibling));
	});

	// Recurrence prevented (#209 / #3277): on Windows gleam joins OUR cwd
	// spelling with the on-disk filename case from its own directory walk, so a
	// case-variant spelling is reachable there, and the pre-#3285 `endsWith`
	// dropped every diagnostic for the edited file. The opposite direction
	// matters just as much: on a case-SENSITIVE host these are two files and a
	// sibling's error must not attach.
	it("treats a case-variant gleam locus path exactly as this filesystem does (#3285)", async () => {
		const observed = await dispatch(gleamCheck, caseVariantOfArgv);
		if (HOST_FOLDS_PATH_CASE) expectGleamAttached(observed, gleamCheck);
		else expectGleamDetached(observed);
	});
});
