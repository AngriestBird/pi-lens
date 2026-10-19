/**
 * The tier-1 helper's own contract (#4632 slice 1): `startPiRunner` hands the
 * built pi-lens extension to pi's real loader and reports what the HOST holds,
 * not what `index.ts` passed to a stand-in.
 *
 * Every assertion below reads a value only pi produces: the source metadata of
 * the loaded entry, a flag definition's owning extension, a command resolved
 * through the host, and the host's handler registry.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type PiRunner, startPiRunner } from "./pi-runner.js";

/** The built extension `npm run build` writes; the helper loads this file. */
const BUILT_ENTRY = fileURLToPath(new URL("../../index.js", import.meta.url));

const LIFECYCLE_EVENTS = [
	"session_start",
	"session_shutdown",
	"tool_call",
	"tool_result",
	"turn_end",
] as const;

describe("pi-runner: the built extension in pi's real ExtensionRunner (#4632)", () => {
	let pi: PiRunner;

	beforeAll(async () => {
		pi = await startPiRunner();
	});

	it("loads the built entry with no load error and attributes every registration to it", () => {
		expect(pi.errors).toEqual([]);
		const tools = pi.getAllRegisteredTools();
		expect(tools.length).toBeGreaterThan(0);
		const owners = new Set(
			tools.map((tool) => path.resolve(tool.sourceInfo.path)),
		);
		expect([...owners]).toEqual([BUILT_ENTRY]);
	});

	it("holds each flag as a host flag definition owned by the built entry", () => {
		const flags = pi.getFlags();
		expect(flags.size).toBeGreaterThan(0);
		for (const [name, flag] of flags) {
			expect(flag.name).toBe(name);
			expect(["boolean", "string"]).toContain(flag.type);
			expect(path.resolve(flag.extensionPath)).toBe(BUILT_ENTRY);
		}
		// One named flag, so a load that silently registered nothing cannot pass
		// on a size alone.
		expect(flags.get("no-lens")?.type).toBe("boolean");
	});

	it("resolves registered commands through the host with a callable handler", () => {
		const commands = pi.getRegisteredCommands();
		expect(commands.length).toBeGreaterThan(0);
		const toggle = commands.find((command) => command.name === "lens-toggle");
		expect(toggle?.invocationName).toBe("lens-toggle");
		expect(typeof toggle?.handler).toBe("function");
	});

	it("registers the lifecycle handlers the extension declares, and no unknown one", () => {
		for (const event of LIFECYCLE_EVENTS) {
			expect(pi.hasHandlers(event), `handler: ${event}`).toBe(true);
		}
		expect(pi.hasHandlers("pi_runner_no_such_event")).toBe(false);
	});
});
