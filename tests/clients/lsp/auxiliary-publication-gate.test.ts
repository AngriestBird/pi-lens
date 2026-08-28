import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { setupTestEnvironment } from "../test-utils.js";

interface PublicationGateHarness {
	state: { clients: Map<string, unknown> };
	resolveServerRoot: () => Promise<string>;
	hasServerPublishedForFileRoot(
		serverId: string,
		filePath: string,
	): Promise<boolean>;
}

describe("auxiliary first-publication gate", () => {
	it("requires a live root client to publish before it supersedes a fallback", async () => {
		const env = setupTestEnvironment("pi-lens-aux-publication-gate-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			const service = new LSPService() as unknown as PublicationGateHarness;
			service.resolveServerRoot = async () => env.tmpDir;
			const client = { isAlive: () => true, diagnosticsVersion: 0 };
			service.state.clients.set(
				`ast-grep:${normalizeMapKey(env.tmpDir)}`,
				client,
			);

			expect(
				await service.hasServerPublishedForFileRoot("ast-grep", filePath),
			).toBe(false);

			client.diagnosticsVersion = 1;
			expect(
				await service.hasServerPublishedForFileRoot("ast-grep", filePath),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
