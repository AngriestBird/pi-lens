/**
 * #4765 acceptance: an offline Opengrep spawn still produces findings.
 *
 * Recurrence this prevents: `opengrep lsp` started with `--config auto` needs the
 * network for its rules. Offline it published `[]` for every file, forever, and
 * nothing said so (#4764). pi-lens now hands it a local rule file, so the planted
 * finding below must arrive with the network cut. The other cases of this change
 * prove WHICH file the spawn is handed; only a real binary can prove the file
 * loads, so a pack the shipped file format no longer satisfies (a format change
 * in `vendor/opengrep-rules/rules.yaml`, a rule the installed Opengrep rejects)
 * passes every config assertion and fails here.
 *
 * Production chain: the real `OpengrepServer.spawn`, the real stdio wire and
 * the real LSP client. Only the launcher is wrapped: `opengrep` on PATH is a
 * script that runs the real binary under `unshare -rn` (no network at all) when
 * the host allows it, and otherwise with a dead proxy. It records which.
 *
 * Skipped, with a named reason, when no `opengrep` binary exists: the unit lanes
 * install no managed tools. Set `PI_LENS_TEST_OPENGREP_BIN` to point at one;
 * otherwise `opengrep` on PATH, then `~/.pi-lens/bin/opengrep`, is used.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLSPClient } from "../../../clients/lsp/client.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { OpengrepServer } from "../../../clients/lsp/server.js";
import { withEnv } from "../../support/with-env.js";
import { pinFixtureHome, removeTempDirSync } from "../test-utils.js";

const EXE = process.platform === "win32" ? "opengrep.exe" : "opengrep";

/** Resolved before any case pins HOME, so the real managed copy is still found. */
function findOpengrepBinary(): string | undefined {
	const candidates: string[] = [];
	if (process.env.PI_LENS_TEST_OPENGREP_BIN)
		candidates.push(process.env.PI_LENS_TEST_OPENGREP_BIN);
	for (const dir of (process.env.PATH ?? "").split(path.delimiter))
		if (dir) candidates.push(path.join(dir, EXE));
	candidates.push(path.join(os.homedir(), ".pi-lens", "bin", EXE));
	return candidates.find((file) => {
		try {
			fs.accessSync(file, fs.constants.X_OK);
			return fs.statSync(file).isFile();
		} catch {
			return false;
		}
	});
}

const REAL_OPENGREP = findOpengrepBinary();
const SKIP_REASON =
	process.platform === "win32"
		? "POSIX-only: the offline wrapper is a shell script"
		: REAL_OPENGREP
			? undefined
			: "no opengrep binary: set PI_LENS_TEST_OPENGREP_BIN, or put opengrep on PATH or at ~/.pi-lens/bin";

const PLANTED = [
	"import subprocess",
	"",
	"def run(cmd):",
	"    subprocess.call(cmd, shell=True)",
	"",
].join("\n");

let home: string;
let restoreHome: () => void;
let restoreEnv: (() => void) | undefined;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	({ home, restore: restoreHome } = pinFixtureHome("opengrep-offline-4765"));
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	restoreEnv?.();
	restoreEnv = undefined;
	restoreHome();
	removeTempDirSync(home);
});

describe.skipIf(SKIP_REASON !== undefined)(
	`an offline Opengrep spawn still produces findings (#4765)${
		SKIP_REASON ? ` [skipped: ${SKIP_REASON}]` : ""
	}`,
	() => {
		it("reports the planted finding from the shipped pack with the network cut", async () => {
			const project = path.join(home, "project");
			fs.mkdirSync(project, { recursive: true });
			const file = path.join(project, "app.py");
			fs.writeFileSync(file, PLANTED);

			const wrapperDir = path.join(home, "wrapper-bin");
			fs.mkdirSync(wrapperDir, { recursive: true });
			const isolation = path.join(home, "isolation");
			fs.writeFileSync(
				path.join(wrapperDir, "opengrep"),
				[
					"#!/bin/sh",
					`if unshare -rn true 2>/dev/null; then echo isolated > "${isolation}"; exec unshare -rn "${REAL_OPENGREP}" "$@"; fi`,
					`echo proxy > "${isolation}"`,
					`HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 exec "${REAL_OPENGREP}" "$@"`,
					"",
				].join("\n"),
				{ mode: 0o755 },
			);
			restoreEnv = withEnv({
				PI_LENS_HOME: path.join(home, ".pi-lens"),
				PATH: `${wrapperDir}${path.delimiter}${process.env.PATH ?? ""}`,
			});

			const launched = await OpengrepServer.spawn(project, {
				allowInstall: false,
			});
			if (!launched) throw new Error("OpengrepServer.spawn declined");
			const client = await createLSPClient({
				serverId: "opengrep",
				process: launched.process,
				root: project,
				initialization: launched.initialization,
				initializeTimeoutMs: 30_000,
			});
			cleanups.push(async () => {
				await client.shutdown().catch(() => undefined);
				await stopLSP(launched.process).catch(() => undefined);
			});

			await client.notify.open(file, PLANTED, "python");
			await client.waitForDiagnostics(file, 30_000);

			const rules = client
				.getDiagnostics(file)
				.map((d) => String(d.code ?? d.message));
			expect(rules.join(" ")).toMatch(/subprocess-shell-true/);
			// The spawn is handed a local file, never `auto`.
			const configuration = (
				launched.initialization as { scan: { configuration: string[] } }
			).scan.configuration;
			expect(configuration).toHaveLength(1);
			expect(configuration[0]).toMatch(
				/vendor[\\/]opengrep-rules[\\/]rules\.yaml$/,
			);
			expect(fs.readFileSync(isolation, "utf-8").trim()).toMatch(
				/^(isolated|proxy)$/,
			);
		}, 90_000);
	},
);
