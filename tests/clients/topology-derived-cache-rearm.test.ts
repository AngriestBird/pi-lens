import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjectLanguageProfile } from "../../clients/language-profile.js";
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
});
