/**
 * The seam's per-install reset, observed through the surface production reads
 * (#4720 review F1/F2, on #4709's helper).
 *
 * Recurrence: deleting `resetInstalledLspService()` from either installer left
 * all 165 cases of the moved files green, because every override in those files
 * is a file-scoped hoisted spy and a stale cached double answers identically to
 * a fresh one. The next slice installs a DIFFERENT double per case, so the reset
 * is the only thing that makes a reinstall produce a new service.
 *
 * Each case installs twice inside itself, so the witness depends on no sibling
 * case's state (AGENTS.md test screen: a case never reads what a sibling wrote).
 */
import { describe, expect, it } from "vitest";
import { getLSPService } from "../../clients/lsp/capabilities.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import {
	installLspService,
	installLspServiceDouble,
} from "../support/lsp-service-seam.js";

describe("installLspServiceDouble replaces the cached service", () => {
	it("reads the second double after a second install", async () => {
		await installLspServiceDouble({ getAliveClientCount: () => 1 });
		expect(getLSPService().getAliveClientCount()).toBe(1);
		await installLspServiceDouble({ getAliveClientCount: () => 2 });
		expect(getLSPService().getAliveClientCount()).toBe(2);
	});
});

describe("installLspService replaces the cached service", () => {
	it("reads the second double after a second install", () => {
		installLspService(makeLspServiceDouble({ getAliveClientCount: () => 1 }));
		expect(getLSPService().getAliveClientCount()).toBe(1);
		installLspService(makeLspServiceDouble({ getAliveClientCount: () => 2 }));
		expect(getLSPService().getAliveClientCount()).toBe(2);
	});
});
