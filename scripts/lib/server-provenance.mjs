// #4512 acceptance 1: what a matrix row ran. A capability change cannot be
// told apart from a server upgrade or a different install route unless the row
// records both, so the nightly writes each server's `version` and `install`
// source next to its measurements.
//
// Pure over injected facts (installer statuses, a version reader) so the
// recorded-run tests need no spawn; `readVersionFromBinary` is the one place
// that runs the server's own `--version`.
import { spawnSync } from "node:child_process";

const VERSION_RE = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/;

/** First semver-ish token of a `--version` answer, or `undefined`. */
export function versionToken(output) {
	return String(output ?? "").match(VERSION_RE)?.[0];
}

/**
 * The installer tool a fixture's server runs through: its only `tools` entry.
 * A fixture that names none (native `tsc --lsp`, a fake server) or several
 * (a linter beside the server) has no unambiguous answer and records nothing,
 * which the matrix keeps as the last known value or `—`.
 */
export function serverToolId(fixture) {
	const tools = fixture?.tools ?? [];
	return tools.length === 1 ? tools[0] : undefined;
}

/**
 * Run the resolved binary's `--version`, bounded. A server that does not know
 * the flag and starts speaking LSP is closed by EOF on stdin; a hang is killed
 * by the timeout. Anything but a clean read is `undefined`, never a guess.
 */
export function readVersionFromBinary(binPath) {
	if (!binPath) return undefined;
	try {
		const run = spawnSync(binPath, ["--version"], {
			input: "",
			encoding: "utf8",
			timeout: 5000,
			killSignal: "SIGKILL",
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (run.error || run.status !== 0) return undefined;
		return `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
	} catch {
		return undefined;
	}
}

/**
 * Per-lang provenance for a run: `Map<lang, { install, version? }>`. A server
 * the installer cannot find (not installed, or only an `npx` fallback) gets no
 * entry: a miss, so the matrix keeps the row's last known value.
 *
 * @param {Array<{ lang: string, tools?: string[] }>} fixtures
 * @param {{ statuses: Array<{ id: string, installed: boolean, source: string, path?: string }>, readVersion?: (status: object) => string | undefined }} facts
 */
export function collectServerProvenance(fixtures, facts) {
	const byTool = new Map(facts.statuses.map((s) => [s.id, s]));
	const out = new Map();
	for (const fx of fixtures) {
		const id = serverToolId(fx);
		const status = id ? byTool.get(id) : undefined;
		if (!status?.installed) continue;
		const version = versionToken(facts.readVersion?.(status));
		out.set(fx.lang, {
			install: status.source,
			...(version ? { version } : {}),
		});
	}
	return out;
}
