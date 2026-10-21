import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import piLens from "../index.js";
import { type PiRunner, startPiRunner } from "./support/pi-runner.js";
import { createPiMock, makeCtx, type PiMock } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

// Template for #171: a command test driven through the shared harnesses — no
// bespoke ExtensionAPI mock. Run the real entry, then invoke the registered
// command handler and assert captured UI calls.
//
// #4632 slice 9 moved the REGISTRATION case onto tier 1: the real host's
// loader holds the flags and resolves the commands, so a command that pi drops
// (or a name it prefixes) is a red here, not a value the double recorded. The
// four handler cases stay on the double, class `real-ui-harness`: their whole
// claim is the text `ctx.ui.notify` shows and the component `ctx.ui.setWidget`
// mounts, and a real `AgentSession` binds `mode: "print"` with `hasUI() ===
// false` (probed on host 1.3.0), so `notifyUi` suppresses the message and no
// widget mounts. Nothing in this slice builds that harness; slice 5 builds none
// and slice 10 is docs-and-stop, so the row names the missing capability rather
// than a slice that would move it (review F4 on #4702).

const tmpDirs: string[] = [];
let previousConfigPath: string | undefined;
let runner: PiRunner;

beforeAll(async () => {
	runner = await startPiRunner();
});

beforeEach(() => {
	previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-toggle-config-"));
	tmpDirs.push(dir);
	process.env.PI_LENS_CONFIG_PATH = path.join(dir, "missing-config.json");
});

afterEach(() => {
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	for (const dir of tmpDirs.splice(0)) {
		removeTempDirSync(dir);
	}
});

function installLens(
	flagValues: Record<string, boolean | string> = {},
): PiMock {
	const pi = createPiMock(flagValues);
	piLens(pi.asExtensionAPI());
	return pi;
}

describe("lens-toggle command", () => {
	it("registers the single session-level lens toggle command", () => {
		// Tier 1 (#4632 slice 9): the real host's loader and command resolver
		// hold the registration. The claim is the host's registry, not the
		// arguments `index.ts` handed a stand-in.
		expect(runner.getFlags().has("no-lens")).toBe(true);
		const registered = runner
			.getRegisteredCommands()
			.map((command) => command.name);
		expect(registered).toContain("lens-toggle");
		expect(registered).toContain("lens-widget-toggle");
		// The retired single-purpose commands stay gone, so this case fails on a
		// roster that quietly re-adds one.
		for (const retired of [
			"lens-enable",
			"lens-disable",
			"lens-status",
			"lens",
		]) {
			expect(registered).not.toContain(retired);
		}
	});

	it("toggles an enabled session off and back on", async () => {
		const pi = installLens();
		const ctx = makeCtx();

		await pi.runCommand("lens-toggle", "", ctx);
		await pi.runCommand("lens-toggle", "", ctx);

		expect(ctx.notifications[0]).toEqual({
			message:
				"pi-lens disabled for this session. Run /lens-toggle again to resume.",
			type: "warning",
		});
		expect(ctx.notifications[1]).toEqual({
			message: "pi-lens enabled for this session.",
			type: "info",
		});
	});

	it("re-enables a session started with --no-lens", async () => {
		const pi = installLens({ "no-lens": true });
		const ctx = makeCtx();

		await pi.runCommand("lens-toggle", "", ctx);

		expect(ctx.notifications).toContainEqual({
			message: "pi-lens enabled for this session.",
			type: "info",
		});
	});

	it("toggles the diagnostics widget off and on", async () => {
		const pi = installLens();
		const ctx = makeCtx();

		await pi.runCommand("lens-widget-toggle", "", ctx);
		await pi.runCommand("lens-widget-toggle", "", ctx);

		expect(ctx.widgetCalls[0]).toEqual({
			key: "pi-lens",
			content: undefined,
			options: undefined,
		});
		expect(ctx.widgetCalls[1].key).toBe("pi-lens");
		expect(typeof ctx.widgetCalls[1].content).toBe("function");
		expect(ctx.widgetCalls[1].options).toEqual({ placement: "belowEditor" });

		expect(ctx.notifications[0]).toEqual({
			message: "pi-lens widget hidden. Run /lens-widget-toggle to show it.",
			type: "info",
		});
		expect(ctx.notifications[1]).toEqual({
			message: "pi-lens widget shown. Run /lens-widget-toggle to hide it.",
			type: "info",
		});
	});

	it("starts the diagnostics widget hidden from global config", async () => {
		const configPath = process.env.PI_LENS_CONFIG_PATH;
		expect(configPath).toBeDefined();
		fs.writeFileSync(
			configPath as string,
			JSON.stringify({ widget: { visible: false } }),
			"utf-8",
		);
		const pi = installLens();
		const ctx = makeCtx();

		await pi.runCommand("lens-widget-toggle", "", ctx);

		expect(ctx.widgetCalls[0]).toEqual({
			key: "pi-lens",
			content: expect.any(Function),
			options: { placement: "belowEditor" },
		});
		expect(ctx.notifications).toContainEqual({
			message: "pi-lens widget shown. Run /lens-widget-toggle to hide it.",
			type: "info",
		});
	});
});
