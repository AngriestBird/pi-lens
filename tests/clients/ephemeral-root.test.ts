import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isEphemeralCheckoutRoot } from "../../clients/ephemeral-root.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { saveProjectSnapshot } from "../../clients/project-snapshot.js";
import { getLspIdleEvictMsForRoot } from "../../clients/lsp/index.js";
import { removeTempDirSync } from "./test-utils.js";

const roots: string[] = [];
const previousIdleEnv = {
	generic: process.env.PI_LENS_LSP_IDLE_EVICT_MS,
	ephemeral: process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS,
};

afterEach(() => {
	for (const root of roots.splice(0)) removeTempDirSync(root);
	if (previousIdleEnv.generic === undefined)
		delete process.env.PI_LENS_LSP_IDLE_EVICT_MS;
	else process.env.PI_LENS_LSP_IDLE_EVICT_MS = previousIdleEnv.generic;
	if (previousIdleEnv.ephemeral === undefined)
		delete process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS;
	else
		process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS = previousIdleEnv.ephemeral;
});

describe("temporary checkout policy (#1129)", () => {
	it("marks a real tmp checkout without marking an ordinary tmp fixture", () => {
		const checkout = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-1129-repo-"),
		);
		const fixture = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-1129-fixture-"),
		);
		roots.push(checkout, fixture);
		fs.mkdirSync(path.join(checkout, ".git"));

		expect(isEphemeralCheckoutRoot(checkout)).toBe(true);
		expect(isEphemeralCheckoutRoot(fixture)).toBe(false);
		expect(getProjectDataDir(checkout)).toBe(getProjectDataDir(checkout));
		expect(getProjectDataDir(checkout)).not.toContain(path.basename(checkout));
	});

	it("does not read or write a snapshot for a temporary checkout", () => {
		const checkout = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-1129-snapshot-"),
		);
		roots.push(checkout);
		fs.mkdirSync(path.join(checkout, ".git"));
		const snapshot = {
			version: 2,
			projectRoot: checkout,
			generatedAt: new Date().toISOString(),
			seq: 1,
			files: {},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		} as never;
		const dataDir = getProjectDataDir(checkout);

		saveProjectSnapshot(checkout, snapshot);
		expect(fs.readdirSync(checkout)).toEqual([".git"]);
		expect(fs.existsSync(dataDir)).toBe(false);
	});

	it("uses the aggressive idle window only for real temporary checkouts", () => {
		const checkout = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-1129-idle-"),
		);
		const fixture = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-1129-idle-fixture-"),
		);
		roots.push(checkout, fixture);
		fs.mkdirSync(path.join(checkout, ".git"));
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = "120000";
		process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS = "1000";

		expect(getLspIdleEvictMsForRoot(checkout)).toBe(1000);
		expect(getLspIdleEvictMsForRoot(fixture)).toBe(120000);
	});
});
