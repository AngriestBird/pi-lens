/**
 * #3968 class sweep — "a lane claims a dialect or capability it cannot serve,
 * with no ownership channel".
 *
 * Population census over the dispatch runners (`clients/dispatch/runners/**`,
 * `.ts` sources only, never the compiled twins), two detector families:
 *
 *   A. **literal-id self-skip predicates** — a CLI runner calling
 *      `lspPrimaryCoversFile(ctx, "<id>")` with an id that is not the
 *      runner's OWN id. The seam's arg is the RUNNER CAPABILITY being
 *      subsumed; asking for another lane's server id was #3968's defect
 *      (the shellcheck runner could never be deferred by a covering shell
 *      LSP that wasn't literally named `bash`).
 *
 *   B. **hardcoded dialect/tool-flag argv** — a runner that emits a dialect
 *      selector flag (`--shell`) without routing the value through the
 *      pinned resolver (`resolveShellFileDialect` in shellcheck.ts). The
 *      pre-fix runner hardcoded `--shell bash` on every file — the SC1071 /
 *      bash-semantics defect itself — so the census holds the flag to the
 *      resolver; a new runner gaining a dialect selector reds until it
 *      resolves dialects too.
 *
 * Sources are comment-and-string-blanked (`stripSource`) so prose or a
 * string literal can never satisfy a requirement, and the floors are real
 * populations (an empty census fails loud, defect shape 10).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const RUNNERS_DIR = path.resolve(
	import.meta.dirname,
	"../../clients/dispatch/runners",
);

interface RunnerScan {
	file: string;
	/** The runner id the file declares (`id: "<id>"` in the RunnerDefinition). */
	ownId: string | null;
	/** Every literal first string arg passed to lspPrimaryCoversFile calls. */
	coverArgs: string[];
	/** True when the (blanked) source references the pinned dialect resolver. */
	referencesDialectResolver: boolean;
	/** True when the (blanked) source emits a `--shell` flag. */
	emitsShellFlag: boolean;
}

function ownRunnerId(source: string): string | null {
	// A runner definition is registered as `const X: RunnerDefinition = { id: "..." }`
	// (or object literal `id: "..."` followed by appliesTo) — take the first
	// `id:` assignment that is followed by an appliesTo clause, so a comment
	// or an unrelated `id:` cannot satisfy it (strings are blanked first).
	const id = /id:\s*"([^"]+)"/.exec(source)?.[1];
	return id ?? null;
}

function scanRunner(file: string): RunnerScan {
	// Both needles live inside string literals (a runner id arg, an argv
	// flag), so this census keeps strings and strips comments — the
	// "per-needle policy" case: prose quoting a needle cannot satisfy it and
	// the literal evidence survives.
	const blanked = stripSource(fs.readFileSync(file, "utf8"), {
		strings: "keep",
	});
	const coverArgs = [
		...blanked.matchAll(/lspPrimaryCoversFile\(\s*ctx\s*,\s*"([^"]+)"/g),
	].map((m) => m[1] ?? "");
	return {
		file: relativePosix(RUNNERS_DIR, file),
		ownId: ownRunnerId(blanked),
		coverArgs,
		referencesDialectResolver: /resolveShellFileDialect/.test(blanked),
		emitsShellFlag: /--shell/.test(blanked),
	};
}

describe("#3968 class sweep — dialect/capability ownership over the runners", () => {
	const files = listSourceFiles(RUNNERS_DIR, {
		extensions: [".ts"],
		skipTests: true,
	});
	const scans = files.map(scanRunner).filter((scan) => scan.ownId !== null);

	it("finds the real runner population (floor)", () => {
		expect(files.length).toBeGreaterThanOrEqual(40);
		expect(scans.length).toBeGreaterThanOrEqual(40);
	});

	it("every self-skip predicate asks for the runner's OWN capability, never a literal server id", () => {
		const violations = scans
			.filter((scan) => scan.coverArgs.length > 0)
			.flatMap((scan) =>
				scan.coverArgs
					.filter((arg) => arg !== scan.ownId)
					.map(
						(arg) =>
							`${scan.file}: lspPrimaryCoversFile(ctx, "${arg}") — the arg is the RUNNER capability being subsumed (#3968); a server id here can never be deferred away from (the #3968 defect was the literal "bash")`,
					),
			);
		// Real floor: the two runners with a covering LSP lane. A third runner
		// gaining the pattern keeps this green iff it names its own id.
		const sites = scans
			.filter((scan) => scan.coverArgs.length > 0)
			.map((scan) => scan.file);
		assertNonEmptyScan("#3968 covers-call sites", sites.length, 2);
		expect(sites.sort()).toEqual(["shellcheck.ts", "taplo.ts"]);
		expect(violations).toEqual([]);
	});

	it("every --shell emit routes its dialect through the pinned resolver", () => {
		const emitters = scans.filter((scan) => scan.emitsShellFlag);
		// Real floor: exactly the shell runner emits the flag today.
		expect(emitters.map((scan) => scan.file)).toEqual(["shellcheck.ts"]);
		for (const emitter of emitters) {
			expect(
				emitter.referencesDialectResolver,
				`${emitter.file}: --shell value must come from resolveShellFileDialect (#3968) — a hardcoded dialect literal is the reported defect`,
			).toBe(true);
		}
	});

	it("pins the shell runner's supported-dialect set to the upstream fact", async () => {
		// Upstream-pinned per defect shape 16:
		// bash-lsp/bash-language-server@server-5.8.1 server/src/shellcheck/config.ts.
		// A set that silently gains zsh (or loses a member) changes what the
		// categorical gate skips — exactly the reported defect in reverse.
		const mod =
			(await import("../../../../clients/dispatch/runners/shellcheck.js")) as unknown as {
				SHELLCHECK_SUPPORTED_DIALECTS: readonly string[];
				resolveShellFileDialect: (f: string) => {
					dialect: string;
					shebang: string | null;
					directive: string | null;
				};
			};
		expect(mod.SHELLCHECK_SUPPORTED_DIALECTS).toEqual([
			"sh",
			"bash",
			"dash",
			"ksh",
			"busybox",
		]);
		expect(mod.SHELLCHECK_SUPPORTED_DIALECTS).not.toContain("zsh");
		expect(typeof mod.resolveShellFileDialect).toBe("function");
	});
});
