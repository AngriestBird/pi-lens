import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertCleanGitConfig } from "./git-config-guard.js";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe("Git contamination guard", () => {
	it("fails on a local fixture identity", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(
			config,
			"[core]\n\tbare = false\n[user]\n\tname = fixture\n",
		);
		expect(() => assertCleanGitConfig(config)).toThrow(/local user identity/);
	});

	it("fails on a subsection identity, not only the bare user section", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(
			config,
			'[user "fixture"]\n\temail = fixture@example.com\n',
		);
		expect(() => assertCleanGitConfig(config)).toThrow(/local user identity/);
	});

	it("accepts a clean non-bare config", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(config, "[core]\n\tbare = false\n");
		expect(() => assertCleanGitConfig(config)).not.toThrow();
	});
});
