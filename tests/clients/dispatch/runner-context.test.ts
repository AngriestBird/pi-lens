/**
 * #4576: the runner-side path seam (`resolveRunnerPath`, used by
 * `createDispatchContext` for runner file location) resolved a host-supplied
 * `~` operand as a literal relative directory, so a runner reported
 * `<cwd>/~/proj/a.ts` — a path that never existed. It now normalizes once at
 * entry through the shared host resolver, and leaves every other relative
 * path's ancestor walk untouched.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRunnerPath } from "../../../clients/dispatch/runner-context.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

let tmp: string;
let cwd: string;
let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-runner-context-4576-"));
	cwd = path.join(tmp, "workspace");
	home = path.join(tmp, "home");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(path.join(home, "proj"), { recursive: true });
	previousHome = process.env.HOME;
	previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
});

afterEach(() => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousUserProfile;
	removeTempDirSync(tmp);
});

describe("resolveRunnerPath host-path normalization (#4576)", () => {
	it("expands a ~ file to $HOME instead of pinning it under the cwd", () => {
		expect(os.homedir()).toBe(home);
		const realFile = path.join(home, "proj", "a.ts");
		fs.writeFileSync(realFile, "export const a = 1;\n");
		expect(resolveRunnerPath(cwd, "~/proj/a.ts")).toBe(
			normalizeMapKey(realFile),
		);
		expect(resolveRunnerPath(cwd, "~/proj/a.ts")).not.toBe(
			normalizeMapKey(path.join(cwd, "~", "proj", "a.ts")),
		);
	});

	it("keeps the ancestor walk for a plain relative path", () => {
		const realFile = path.join(cwd, "src", "b.ts");
		fs.mkdirSync(path.dirname(realFile), { recursive: true });
		fs.writeFileSync(realFile, "export const b = 1;\n");
		expect(resolveRunnerPath(cwd, "src/b.ts")).toBe(normalizeMapKey(realFile));
	});

	it("leaves ~user relative to the cwd, matching the host tool resolver", () => {
		expect(resolveRunnerPath(cwd, "~user/proj/a.ts")).toBe(
			normalizeMapKey(path.join(cwd, "~user", "proj", "a.ts")),
		);
	});
});
