import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjectLanguageProfile } from "../../clients/language-profile.js";
import {
	aliasedImportTargets,
	parseTsconfigPaths,
} from "../../clients/review-graph/tsconfig-paths.js";
import { resolveStartupScanContext } from "../../clients/startup-scan.js";
import { resetWorkspaceTopology } from "../../clients/workspace-topology.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("topology-derived cache re-arm (#2263)", () => {
	it("re-derives startup scan context after topology reset", () => {
		const env = setupTestEnvironment("pi-lens-topology-startup-");
		try {
			const homeDir = path.join(env.tmpDir, "home");
			const before = resolveStartupScanContext(env.tmpDir, { homeDir });
			expect(before.projectRoot).toBeNull();

			fs.mkdirSync(path.join(env.tmpDir, ".git"));
			resetWorkspaceTopology();

			const after = resolveStartupScanContext(env.tmpDir, { homeDir });
			expect(after.projectRoot).toBe(path.resolve(env.tmpDir));
		} finally {
			env.cleanup();
		}
	});

	it("re-derives language profile after topology reset", () => {
		const env = setupTestEnvironment("pi-lens-topology-language-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, "index.ts"), "export {}\n");
			const before = detectProjectLanguageProfile(env.tmpDir);
			expect(before.configured.jsts).toBeUndefined();

			fs.writeFileSync(path.join(env.tmpDir, "package.json"), "{}\n");
			resetWorkspaceTopology();

			const after = detectProjectLanguageProfile(env.tmpDir);
			expect(after.configured.jsts).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("re-derives tsconfig paths after topology reset", () => {
		const env = setupTestEnvironment("pi-lens-topology-tsconfig-");
		try {
			const configPath = path.join(env.tmpDir, "tsconfig.json");
			const sourceDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(sourceDir);
			const initialConfig = JSON.stringify({
				compilerOptions: { baseUrl: ".", paths: { "@old/*": ["old/*"] } },
			});
			fs.writeFileSync(configPath, initialConfig);
			fs.utimesSync(configPath, 946684800, 946684800);
			expect(parseTsconfigPaths(sourceDir)).toEqual([
				expect.objectContaining({ pattern: "@old/*" }),
			]);
			expect(aliasedImportTargets("@old/value", sourceDir)).toEqual([
				path.join(env.tmpDir, "old/*").replace("*", "value"),
			]);

			const originalStat = fs.statSync(configPath);
			const replacementConfig = JSON.stringify({
				compilerOptions: { baseUrl: ".", paths: { "@new/*": ["new/*"] } },
			});
			expect(replacementConfig.length).toBe(initialConfig.length);
			fs.writeFileSync(configPath, replacementConfig);
			fs.utimesSync(configPath, originalStat.atime, originalStat.mtime);
			const replacementStat = fs.statSync(configPath);
			expect(replacementStat.size).toBe(originalStat.size);
			expect(replacementStat.mtimeMs).toBe(originalStat.mtimeMs);

			resetWorkspaceTopology();

			expect(parseTsconfigPaths(sourceDir)).toEqual([
				expect.objectContaining({ pattern: "@new/*" }),
			]);
			expect(aliasedImportTargets("@new/value", sourceDir)).toEqual([
				path.join(env.tmpDir, "new/value"),
			]);
		} finally {
			env.cleanup();
		}
	});
});
