// flake-shape: in-process-mock — #1712: the installer is the external tool boundary; it hands the real typescript-language-server 5.3.0 wrapper and a classic compiler to the real launcher, service, client, rename and watched-files paths.
/**
 * #1712 live twins: cross-file behaviour over a real classic TypeScript server.
 *
 * The recurrence: every cross-file path shipped against unit doubles only, so
 * no test had ever watched a real server take, or fail to take, one. Three
 * claims meet a real wrapper on one enlarged fixture: a module, its importer,
 * and a bystander.
 *
 *  - RENAME propagation (#1621, #1677): the `workspace/willRenameFiles`
 *    answer is applied to the files that reference the renamed one, so the
 *    project still compiles under the new name. A server whose answer is
 *    dropped leaves every importer pointing at a path that no longer exists,
 *    and only a live server can show that the edit it returns is the one that
 *    fixes them.
 *  - The rename chokepoint (#1971): pi-lens never sends
 *    `workspace/didRenameFiles` to a server that did not register it. The
 *    classic wrapper registers `willRename` only, so one live rename proves
 *    both halves.
 *  - DELETION watched-files (#1668, #1684): a delete of a dependency reaches
 *    the server as a type-3 event, and the importer's next read reports the
 *    module gone. That case stays skipped while pi-lens advertises no
 *    relative-pattern support, because the classic wrapper then asks for no
 *    client-side watching at all and drops every watched-files event pi-lens
 *    sends. The skip is derived from that capability, so it lifts on its own
 *    the moment the client claims it.
 *
 * Opt-in like the other live TypeScript suites: it runs only with
 * `PI_LENS_INTEGRATION=1` and a classic compiler named by
 * `PI_LENS_CLASSIC_TSC` (a `tsc` whose package still ships
 * `lib/tsserver.js`, TypeScript 6 or older; the repo's own devDependency is
 * TypeScript 7). Without either it skips and says why.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";
import { withEnv } from "../../support/with-env.js";
import { CLIENT_CAPABILITIES } from "../../../clients/lsp/client.js";

const { classicTsc } = vi.hoisted(() => ({
	classicTsc: { value: "" },
}));
// Installation/discovery is the external tool boundary. The launcher, the
// wrapper, the compiler, the service, the client and the rename path are real.
vi.mock("../../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/installer/index.js")
	>()),
	ensureTool: async (id: string) =>
		id === "typescript-language-server"
			? createRequire(import.meta.url).resolve(
					"typescript-language-server/lib/cli.mjs",
				)
			: id === "typescript"
				? classicTsc.value
				: undefined,
}));

function classicCompiler(): string | undefined {
	const tsc = process.env.PI_LENS_CLASSIC_TSC;
	if (!tsc || !fs.existsSync(tsc)) return undefined;
	const pkg = path.resolve(path.dirname(fs.realpathSync(tsc)), "..");
	return fs.existsSync(path.join(pkg, "lib", "tsserver.js")) ? tsc : undefined;
}

const LIVE = process.env.PI_LENS_INTEGRATION === "1";
const TSC = LIVE ? classicCompiler() : undefined;
const SKIP_REASON = !LIVE
	? "PI_LENS_INTEGRATION is not 1"
	: !TSC
		? "PI_LENS_CLASSIC_TSC names no classic compiler (lib/tsserver.js)"
		: "";

const EXPORTER = "export const foo: number = 1;\n";
const IMPORTER = 'import { foo } from "./a";\nexport const v: number = foo;\n';
const BYSTANDER = 'export const unrelated: string = "c";\n';
const STALE_IMPORTER = /Cannot find module '\.\/a'|is not a module/;
/**
 * The deletion case needs a client that claims relative-pattern support: that
 * claim is what makes a classic wrapper request client-side watching at all.
 * Without it the wrapper falls back to tsserver's own polling and drops every
 * `workspace/didChangeWatchedFiles` pi-lens sends, so a type-3 delete reaches
 * no server. Derived from the production capability, never a constant that
 * would outlive the gap.
 *
 * The claim is half of the enablement: the classic `TypeScriptServer.spawn`
 * initialization must also ask for watcher events
 * (`tsserver.useClientFileWatcher`), or the wrapper keeps polling. That
 * second half is deliberately NOT derived here — a claim without it turns
 * this case red, which is exactly the signal wanted.
 */
const WATCHED_FILES_DELIVERABLE =
	(
		CLIENT_CAPABILITIES.workspace.didChangeWatchedFiles as {
			relativePatternSupport?: boolean;
		}
	).relativePatternSupport === true;

let tmp = "";
let restoreEnv: () => void = () => {};
const pids = new Set<number>();

/** One fixture project: `a.ts` exports, `b.ts` imports it, `c.ts` is a bystander. */
function writeProject(proj: string): { a: string; b: string; c: string } {
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.writeFileSync(path.join(proj, "package.json"), "{}\n");
	fs.writeFileSync(
		path.join(proj, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { strict: true } }),
	);
	const a = path.join(proj, "src", "a.ts");
	const b = path.join(proj, "src", "b.ts");
	const c = path.join(proj, "src", "c.ts");
	fs.writeFileSync(a, EXPORTER);
	fs.writeFileSync(b, IMPORTER);
	fs.writeFileSync(c, BYSTANDER);
	return { a, b, c };
}

describe.skipIf(SKIP_REASON !== "")(
	`cross-file behaviour over a real classic TypeScript server (#1712, #1621, #1668, #1677)${SKIP_REASON ? ` [skipped: ${SKIP_REASON}]` : ""}`,
	() => {
		beforeAll(() => {
			classicTsc.value = TSC ?? "";
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-crossfile-live-"));
			const childTmp = path.join(tmp, "os-temp");
			fs.mkdirSync(childTmp);
			restoreEnv = withEnv({
				HOME: path.join(tmp, "home"),
				TMPDIR: childTmp,
				TEMP: childTmp,
				TMP: childTmp,
				PI_LENS_HOME: path.join(tmp, "pi-lens-home"),
				PILENS_DATA_DIR: path.join(tmp, "data"),
				PI_LENS_TEST_MODE: "0",
				PI_LENS_DISABLE_TOOL_INSTALL: "1",
				PI_LENS_DISABLE_LSP_INSTALL: "1",
			});
		});

		afterAll(async () => {
			const { resetLSPService, getLSPService } =
				await import("../../../clients/lsp/index.js");
			await getLSPService().shutdown({ fast: false, reason: "test" });
			resetLSPService();
			// Every server this suite spawned is gone; kill a survivor by PID.
			for (const pid of pids) {
				try {
					process.kill(pid, 0);
					process.kill(pid, "SIGKILL");
				} catch {
					/* already exited */
				}
			}
			const { resetProjectTrust } =
				await import("../../../clients/project-trust.js");
			resetProjectTrust();
			restoreEnv();
			removeTempDirSync(tmp);
		});

		it("applies the server's willRenameFiles edit to the importer, so the project compiles under the new name", async () => {
			const proj = path.join(tmp, "project");
			const { a, b, c } = writeProject(proj);
			const renamed = path.join(proj, "src", "renamed.ts");

			const { setProjectTrustState } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState("trusted");
			const { getLSPService } = await import("../../../clients/lsp/index.js");
			const service = getLSPService();
			// Warm: the exporter and its importer are open and clean, so the
			// server holds a program that resolves `./a`.
			for (const file of [a, b, c]) {
				await service.touchFile(file, fs.readFileSync(file, "utf8"), {
					diagnostics: "document",
					collectDiagnostics: true,
				});
			}
			const spawned = await service.getClientForFile(b);
			expect(spawned?.client.serverId ?? spawned?.info.id).toBe("typescript");
			const pid = spawned?.client.getProcessPid?.();
			if (pid) pids.add(pid);

			const result = await service.renameFile(a, renamed, {
				cwd: proj,
				apply: true,
			});
			expect(result.willRenameFailures).toEqual([]);
			expect(fs.existsSync(a)).toBe(false);
			expect(fs.existsSync(renamed)).toBe(true);
			// The importer's specifier is the server's own edit, not a rewrite of
			// pi-lens' invention: only a live wrapper returns it.
			expect(fs.readFileSync(b, "utf8")).toBe(
				IMPORTER.replace('"./a"', '"./renamed"'),
			);

			// The next write of the importer is what the agent's edit would send.
			const importerNow = fs.readFileSync(b, "utf8");
			await service.touchFile(b, importerNow, {
				diagnostics: "document",
				collectDiagnostics: true,
			});
			const diagnostics = (await service.getDiagnostics(b)) ?? [];
			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([]);
		}, 120_000);

		it("never sends workspace/didRenameFiles to a server that did not register it", async () => {
			const proj = path.join(tmp, "project-capability");
			const { a, b } = writeProject(proj);
			const renamed = path.join(proj, "src", "renamed.ts");

			const { setProjectTrustState } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState("trusted");
			const { getLSPService } = await import("../../../clients/lsp/index.js");
			const { getDegradationSummary, resetDegradationLedger } =
				await import("../../../clients/degradation-ledger.js");
			// This case reads the ledger, so it starts from an empty one rather
			// than from whatever a sibling case recorded.
			resetDegradationLedger();
			const service = getLSPService();
			for (const file of [a, b]) {
				await service.touchFile(file, fs.readFileSync(file, "utf8"), {
					diagnostics: "document",
					collectDiagnostics: true,
				});
			}
			const spawned = await service.getClientForFile(b);
			const pid = spawned?.client.getProcessPid?.();
			if (pid) pids.add(pid);
			// The premise of the assertion: this wrapper registers willRename
			// only. A wrapper that starts registering didRename turns this case
			// red first, which is the signal to re-read the claim.
			expect(spawned?.client.getOperationSupport()).toMatchObject({
				willRenameFiles: true,
				didRenameFiles: false,
			});

			const result = await service.renameFile(a, renamed, {
				cwd: proj,
				apply: true,
			});
			expect(result.didRenameFailures).toEqual([]);
			expect(result.applied).toBe(true);

			const skip = getDegradationSummary()
				.filter((group) => group.kind === "lsp-capability-skip")
				.flatMap((group) => group.latestReasons)
				.find(
					(reason) => reason.subject === "typescript:workspace/didRenameFiles",
				);
			expect(skip?.reason).toBe("no-registration");
		}, 120_000);

		it.skipIf(!WATCHED_FILES_DELIVERABLE)(
			`reports a deleted dependency as a missing module after the type-3 watched-files event${WATCHED_FILES_DELIVERABLE ? "" : " [skipped: pi-lens advertises no relative-pattern support, so a classic wrapper asks for no client-side watching and drops every watched-files event pi-lens sends (#1712)]"}`,
			async () => {
				const proj = path.join(tmp, "project-delete");
				const { a, b } = writeProject(proj);

				const { setProjectTrustState } =
					await import("../../../clients/project-trust.js");
				setProjectTrustState("trusted");
				const { getLSPService } = await import("../../../clients/lsp/index.js");
				const service = getLSPService();
				// Only the importer is opened. The dependency stays a closed project
				// file, so what the server believes about it on disk is exactly what a
				// type-3 event corrects.
				await service.touchFile(b, fs.readFileSync(b, "utf8"), {
					diagnostics: "document",
					collectDiagnostics: true,
				});
				const spawned = await service.getClientForFile(b);
				const pid = spawned?.client.getProcessPid?.();
				if (pid) pids.add(pid);
				expect(
					((await service.getDiagnostics(b)) ?? []).map(
						(diagnostic) => diagnostic.message,
					),
					"the fixture must start clean, or the deleted-module line proves nothing",
				).toEqual([]);

				const client = spawned?.client;
				const versionBefore = client?.getDiagnosticsVersionForPath(b) ?? 0;
				fs.rmSync(a);
				await service.notifyExternalFileChange(a, 3);
				// A push-mode server answers on its own schedule, so wait for its OWN
				// publication rather than polling a clock (#1767). A budget that lapses
				// is not fatal here: the assertion below names the claim, so a red says
				// "the importer never reported it" instead of "a wait timed out".
				await client
					?.waitForDiagnostics(b, 20_000, { minVersion: versionBefore + 1 })
					.catch(() => undefined);
				const messages = ((await service.getDiagnostics(b)) ?? []).map(
					(diagnostic) => diagnostic.message,
				);
				expect(
					messages.some((message) => STALE_IMPORTER.test(message)),
					`the importer never reported the deleted dependency: ${JSON.stringify(messages)}`,
				).toBe(true);
			},
			120_000,
		);
	},
);
