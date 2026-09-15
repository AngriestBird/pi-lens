import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	claimScratchDir,
	SCRATCH_DIR_ROOT,
} from "../../scripts/lib/scratch-dir.mjs";
import { createRealPiProject, withRealPi } from "../support/real-pi-harness.js";

/**
 * Read the cross-session project-diagnostics snapshot both sessions share.
 *
 * It lives under the `getProjectDataDir` slug for the project root inside the
 * shared `PI_LENS_HOME`, so this walks the one `projects/*` entry that home
 * has. Returning the raw text is deliberate: the assertions below are about
 * what the DURABLE record still says at the moment the second session reads
 * it, not about the shape the loader parses it into.
 */
function inheritedProjectSnapshots(home: string): string[] {
	const projects = path.join(home, "projects");
	if (!existsSync(projects)) return [];
	const found: string[] = [];
	for (const slug of readdirSync(projects)) {
		const file = path.join(
			projects,
			slug,
			"cache",
			"project-diagnostics.json",
		);
		if (existsSync(file)) found.push(readFileSync(file, "utf8"));
	}
	return found;
}

// flake-shape: real-process-spawn — this sequence must cross the registered pi tool boundary
describe("real pi harness: diagnostic provenance", () => {
	it("retires a clean runner finding after an out-of-band line shift", async () => {
		await withRealPi(
			{ fixture: "diagnostic-provenance", script: "script.json" },
			async (pi) => {
				await pi.prompt("record the diagnostic");
				const before = await pi.awaitToolResult("lens_diagnostics");
				const beforeText = JSON.stringify(before);
				expect(beforeText).toContain("staleExport");
				expect(beforeText).toContain("L41");

				const file = path.join(pi.projectPath(), "src", "moved.ts");
				const source = readFileSync(file, "utf8");
				writeFileSync(
					file,
					`// out-of-band 01\n// out-of-band 02\n// out-of-band 03\n${source.replace("export const staleExport = 2;\n", "")}`,
				);

				await pi.awaitAssistantTurn();
				await pi.prompt("recheck after the external clean edit");
				const after = await pi.awaitToolResult("lens_diagnostics");
				expect(JSON.stringify(after)).not.toContain("staleExport");

				await pi.awaitAssistantTurn();
				await pi.prompt("compare delta");
				const delta = await pi.awaitToolResult("lens_diagnostics");
				expect(JSON.stringify(delta)).not.toContain("staleExport");

				await pi.awaitAssistantTurn();
				await pi.prompt("compare session view");
				const all = await pi.awaitToolResult("lens_diagnostics");
				expect(JSON.stringify(all)).not.toContain("staleExport");
			},
		);
	}, 60_000);

	/**
	 * #2154 AC1, second half — the reported incident's own shape, which the
	 * single-session case above cannot reach: TWO LIVE `pi` sessions in one
	 * repository, the finding recorded by one and the condition removed while
	 * the other is running.
	 *
	 * Both children resolve the SAME project root (one `createRealPiProject`
	 * tree) and the SAME `PI_LENS_HOME`, so they share every store keyed by
	 * those two — in particular `cache/project-diagnostics.json`, the snapshot
	 * `clients/project-diagnostics/scanner.ts` calls "the authoritative
	 * cross-session cache". That store is the delivery channel AC2 is about:
	 * its key carries the project root (the data-dir slug) and nothing about
	 * the session or the content generation, so if nothing gated it at READ
	 * time, session B would render session A's pre-edit rows as current.
	 *
	 * Session A records both producer arms in one call — the cheap tier's
	 * blocking `debugger-statement`, which is what lands in that shared
	 * snapshot, and knip's `staleExport`, the reporter's own "Unused export"
	 * shape. The clean change then removes both while A is still alive, and
	 * session B — started after the edit and running concurrently — must serve
	 * neither, in any of the four modes, while still reporting the finding that
	 * genuinely survived the edit (`trip`, at its POST-edit line) so a silent
	 * session cannot pass for a clean one.
	 */
	it("does not serve a second live session the findings the first recorded before a clean edit", async () => {
		const project = createRealPiProject("diagnostic-provenance");
		const home = claimScratchDir(SCRATCH_DIR_ROOT, "real-pi-home");
		try {
			await withRealPi(
				{
					fixture: "diagnostic-provenance",
					script: "two-sessions-a.json",
					project,
					home,
				},
				async (sessionA) => {
					await sessionA.prompt("session A records the findings");
					const recorded = JSON.stringify(
						await sessionA.awaitToolResult("lens_diagnostics"),
					);
					expect(recorded).toContain("staleExport");
					expect(recorded).toContain("debugger-statement");

					// The clean change, out of band, while session A is still live.
					// The three prepended lines move every surviving line, so a
					// replayed row cannot coincidentally still match its old
					// coordinates (the #2868 line-movement axis, now across a
					// session boundary).
					const file = path.join(project, "src", "moved.ts");
					const source = readFileSync(file, "utf8");
					writeFileSync(
						file,
						`// out-of-band 01\n// out-of-band 02\n// out-of-band 03\n${source
							.replace("export const staleExport = 2;\n", "")
							.replace("\tdebugger;\n", "")}`,
					);

					// Anti-vacuity, half one: the stale row session B could serve is
					// really on disk in the shared store when B starts. Without this
					// the "B is clean" assertions below would also pass if nothing
					// had ever been persisted for B to inherit.
					const snapshots = inheritedProjectSnapshots(home);
					expect(snapshots.length).toBe(1);
					expect(snapshots[0]).toContain("debugger-statement");

					await withRealPi(
						{
							fixture: "diagnostic-provenance",
							script: "two-sessions-b.json",
							project,
							home,
						},
						async (sessionB) => {
							expect(sessionB.projectPath()).toBe(sessionA.projectPath());
							for (const mode of [
								"cached full",
								"delta",
								"fresh full",
								"session view",
							]) {
								await sessionB.prompt(`session B ${mode}`);
								const served = JSON.stringify(
									await sessionB.awaitToolResult("lens_diagnostics"),
								);
								expect(served, mode).not.toContain("staleExport");
								expect(served, mode).not.toContain("debugger-statement");
								// Anti-vacuity, half two: a session that reports nothing at
								// all would satisfy every assertion above. `trip` survived
								// the edit, so every scanning mode must still name it — at
								// its POST-edit line, never the line A recorded.
								if (mode !== "delta") {
									expect(served, mode).toContain("trip");
									expect(served, mode).toContain("L45");
								}
								await sessionB.awaitAssistantTurn();
							}
						},
					);
				},
			);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);
});
