/**
 * #4515: under project trust "unknown" (or "untrusted"), `launchLSP` refuses the
 * project-local candidate `<root>/node_modules/.bin/<cmd>` by path shape, and
 * the refusal used to end `resolveAndLaunch` before the managed-install step, so
 * a managed binary was never tried (the nightly LSP probes lost 30 of 54 rows).
 *
 * The refusal goes through the REAL `launchLSP` (it throws before any spawn);
 * only a launch of the managed binary is stubbed, because spawning a language
 * server is the process boundary. The recurrence this guards: a fail-closed
 * trust gate on one candidate silently deleting every later fallback.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { removeTempDirSync } from "../test-utils.js";

const { managedLaunch, ensureTool } = vi.hoisted(() => ({
	managedLaunch: vi.fn(),
	ensureTool: vi.fn(),
}));
let managedPath = "";

vi.mock("../../../clients/lsp/launch.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../../clients/lsp/launch.js")>();
	return {
		...original,
		launchLSP: (
			command: string,
			args: string[],
			options: Parameters<typeof original.launchLSP>[2],
		) =>
			command === managedPath
				? managedLaunch(command, args, options)
				: original.launchLSP(command, args, options),
	};
});
vi.mock("../../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/installer/index.js")
	>()),
	ensureTool,
	findManagedToolBinary: vi.fn(async () => undefined),
}));

import { withLspProjectCodePermission } from "../../../clients/lsp/launch.js";
import { resolveAndLaunch as resolveAndLaunchRaw } from "../../../clients/lsp/server.js";

// Production runs every launch inside the service's spawn scope; an own,
// trusted root is granted project-code permission there.
const resolveAndLaunch = (
	...args: Parameters<typeof resolveAndLaunchRaw>
): ReturnType<typeof resolveAndLaunchRaw> =>
	withLspProjectCodePermission(true, () => resolveAndLaunchRaw(...args));

const fakeProc = { stdout: {}, stderr: {} } as never;
const dirs: string[] = [];

function makeProject(withLocalBinary: boolean): {
	root: string;
	marker: string;
} {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4515-"));
	dirs.push(root);
	const marker = path.join(root, "executed.marker");
	if (withLocalBinary) {
		const bin = path.join(root, "node_modules", ".bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(
			path.join(bin, "fixture-lsp"),
			`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
			{ mode: 0o755 },
		);
	}
	return { root, marker };
}

function spec(root: string) {
	return {
		candidates: [
			path.join(root, "node_modules", ".bin", "fixture-lsp"),
			"fixture-lsp-not-on-path-4515",
		],
		args: ["--stdio"],
		cwd: root,
		managedToolId: "fixture-lsp",
	};
}

beforeEach(() => {
	managedPath = path.join(os.tmpdir(), "pi-lens-4515-managed", "fixture-lsp");
	managedLaunch.mockReset().mockResolvedValue(fakeProc);
	ensureTool.mockReset().mockResolvedValue(managedPath);
	resetDegradationLedger();
	resetProjectTrust();
});

afterEach(() => {
	resetProjectTrust();
	while (dirs.length) removeTempDirSync(dirs.pop() as string);
});

describe.each(["unknown", "untrusted"] as const)(
	"resolveAndLaunch with project trust %s (#4515)",
	(trust) => {
		it("reaches the managed binary when the project-local candidate does not exist", async () => {
			setProjectTrustState(trust);
			const { root } = makeProject(false);

			const result = await resolveAndLaunch(spec(root), true);

			expect(ensureTool).toHaveBeenCalledWith("fixture-lsp");
			expect(managedLaunch).toHaveBeenCalledTimes(1);
			expect(result?.source).toBe("managed");
		});

		it("keeps an existing project-local binary refused and still reaches the managed binary", async () => {
			setProjectTrustState(trust);
			const { root, marker } = makeProject(true);

			const result = await resolveAndLaunch(spec(root), true);

			expect(fs.existsSync(marker)).toBe(false); // never executed
			expect(result?.source).toBe("managed");
		});
	},
);

describe("resolveAndLaunch trust-refusal surface (#4515)", () => {
	it("still throws the refusal when installs are blocked", async () => {
		setProjectTrustState("unknown");
		const { root, marker } = makeProject(true);

		await expect(resolveAndLaunch(spec(root), false)).rejects.toThrow(
			/project-local binary refused: project trust is unknown/,
		);

		expect(ensureTool).not.toHaveBeenCalled();
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("rethrows the refusal when the managed install fails too", async () => {
		setProjectTrustState("unknown");
		ensureTool.mockResolvedValue(null);
		const { root } = makeProject(true);

		await expect(resolveAndLaunch(spec(root), true)).rejects.toThrow(
			/project-local binary refused: project trust is unknown/,
		);
	});

	it("records the refusal once per session per tool across repeated attempts", async () => {
		setProjectTrustState("unknown");
		const { root } = makeProject(false);

		await resolveAndLaunch(spec(root), true);
		await resolveAndLaunch(spec(root), true);

		const rows = getDegradationSummary()
			.filter((group) => group.kind === "lsp-registry-decision")
			.flatMap((group) => group.latestReasons)
			.filter((row) => row.subject.includes("project-local-binary"));
		expect(rows).toHaveLength(1);
	});

	it("keeps launching the managed binary after a trusted project-local miss", async () => {
		// Trusted projects keep the old behaviour: the missing project-local file
		// is a plain tool-not-found and the managed binary still launches.
		setProjectTrustState("trusted");
		const { root } = makeProject(false);

		const result = await resolveAndLaunch(spec(root), true);

		expect(result?.source).toBe("managed");
	});
});
