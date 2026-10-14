/**
 * #4323: pi's `lens_diagnostics source=lsp` honours the operator's Opengrep
 * switch, `--no-opengrep` or `opengrep.enabled=false` in the global config.
 *
 * The tool asks `configDisabledAuxiliaryLspServerIds` which auxiliaries to
 * leave unstarted, through the flag resolver its host injects
 * (`createLensDiagnosticsTool`'s `getFlag`). This file pins pi's half of that
 * wiring: the real extension activation (`index.ts`), with the resolver
 * captured from the real tool factory's arguments. The service half, that an
 * excluded server is never spawned, is pinned in
 * `tests/tools/lsp-diagnostics-opengrep-disabled-4323.test.ts`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	getFlag: undefined as
		| undefined
		| ((name: string, cwd: string) => boolean | string | undefined),
}));

vi.mock("../tools/lens-diagnostics.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../tools/lens-diagnostics.js")>();
	return {
		...actual,
		createLensDiagnosticsTool: (
			...args: Parameters<typeof actual.createLensDiagnosticsTool>
		) => {
			captured.getFlag = args[8];
			return actual.createLensDiagnosticsTool(...args);
		},
	};
});
vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
	}));
});

import { configDisabledAuxiliaryLspServerIds } from "../clients/dispatch/auxiliary-lsp.js";
import extension from "../index.js";
import { createPiMock } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

describe("pi's lens_diagnostics leaves a switched-off Opengrep unstarted (#4323)", () => {
	let tmp: string;
	const savedConfigPath = process.env.PI_LENS_CONFIG_PATH;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4323-host-"));
		captured.getFlag = undefined;
	});

	afterEach(() => {
		if (savedConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
		else process.env.PI_LENS_CONFIG_PATH = savedConfigPath;
		removeTempDirSync(tmp);
	});

	/** The auxiliaries pi's `lens_diagnostics` would exclude for `tmp`. */
	function excludedAfterActivation(
		flags: Record<string, boolean | string>,
	): string[] {
		// An explicit, empty global config, so a maintainer's own
		// `~/.pi-lens/config.json` cannot decide the control case.
		if (process.env.PI_LENS_CONFIG_PATH === undefined) {
			const empty = path.join(tmp, "empty-config.json");
			fs.writeFileSync(empty, "{}\n");
			process.env.PI_LENS_CONFIG_PATH = empty;
		}
		const pi = createPiMock({ "no-lsp": true, ...flags });
		extension(pi.asExtensionAPI());
		const getFlag = captured.getFlag;
		expect(getFlag).toBeTypeOf("function");
		return [
			...configDisabledAuxiliaryLspServerIds((name) => getFlag!(name, tmp)),
		];
	}

	it("excludes Opengrep under --no-opengrep", () => {
		expect(excludedAfterActivation({ "no-opengrep": true })).toContain(
			"opengrep",
		);
	});

	it("excludes Opengrep when the global config sets opengrep.enabled=false", () => {
		const configPath = path.join(tmp, "config.json");
		fs.writeFileSync(configPath, '{"opengrep":{"enabled":false}}\n');
		process.env.PI_LENS_CONFIG_PATH = configPath;
		expect(excludedAfterActivation({})).toContain("opengrep");
	});

	it("excludes nothing when no switch is set", () => {
		expect(excludedAfterActivation({})).toEqual([]);
	});
});
