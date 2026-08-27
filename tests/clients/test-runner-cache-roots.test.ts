import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestRunnerClient } from "../../clients/test-runner-client.js";

const tempRoots: string[] = [];

function linkAlias(root: string, alias: string): void {
	try {
		fs.symlinkSync(root, alias, "junction");
	} catch {
		fs.symlinkSync(root, alias, "dir");
	}
}

function makeUnlinkedProject(prefix: string): { root: string; alias: string } {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const root = path.join(parent, "project");
	const alias = path.join(parent, "project-alias");
	fs.mkdirSync(root);
	tempRoots.push(parent);
	return { root, alias };
}

function makeProject(): { root: string; alias: string } {
	const { root, alias } = makeUnlinkedProject("pi-lens-2048-");
	linkAlias(root, alias);
	return { root, alias };
}

function existingWindowsAlias(root: string): string | undefined {
	const alias = root
		.replace(/[A-Za-z]/g, (letter) =>
			letter === letter.toLowerCase()
				? letter.toUpperCase()
				: letter.toLowerCase(),
		)
		.replace(/[\\/]/g, "\\");
	return alias !== root && fs.existsSync(alias) ? alias : undefined;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("TestRunnerClient project-root caches (#2048)", () => {
	it("shares availability and Vitest glob state across a real symlink", () => {
		const { root, alias } = makeProject();
		const client = new TestRunnerClient();

		// No config yet through either spelling. #2252: a miss is never
		// memoized, so this is a live check each time, not a cached latch.
		expect(client.detectRunner(alias)).toBeNull();
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);
		// #2048: a POSITIVE verdict still shares its cache entry across the
		// canonical root, resolving through EITHER spelling.
		expect(client.detectRunner(root)?.runner).toBe("vitest");
		expect(client.detectRunner(alias)?.runner).toBe("vitest");

		const firstGlobs = client.parseVitestTestGlobs(alias);
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['changed/**/*.test.ts'] } }\n",
		);
		expect(client.parseVitestTestGlobs(root)).toEqual(firstGlobs);
	});

	it("re-resolves an alias first probed before its symlink existed (#2077)", () => {
		const { root, alias } = makeUnlinkedProject("pi-lens-2077-");
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default {}\n",
		);
		const client = new TestRunnerClient();

		// The alias does not exist yet, so canonicalization falls back to the
		// literal spelling and caches the miss under that fallback key.
		expect(client.detectRunner(alias)).toBeNull();

		linkAlias(root, alias);

		expect(client.detectRunner(root)?.runner).toBe("vitest");
		expect(client.detectRunner(alias)?.runner).toBe("vitest");
	});

	it("shares caches across a confirmed Windows separator and case alias", (ctx) => {
		const { root } = makeProject();
		const alias = existingWindowsAlias(root);
		if (!alias) {
			ctx.skip();
			return;
		}

		const client = new TestRunnerClient();
		expect(client.detectRunner(alias)).toBeNull();
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);
		// #2048: a POSITIVE verdict still shares its cache entry across the
		// canonical root, resolving through EITHER spelling.
		expect(client.detectRunner(root)?.runner).toBe("vitest");
		expect(client.detectRunner(alias)?.runner).toBe("vitest");

		const firstGlobs = client.parseVitestTestGlobs(alias);
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { exclude: ['changed/**'] } }\n",
		);
		expect(client.parseVitestTestGlobs(root)).toEqual(firstGlobs);
	});
});
