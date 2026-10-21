// The recurrence this file guards (#4719 F1, greptile P1, sourcery High,
// CodeRabbit Functional Correctness): tier 2 held a STATIC import of
// `@earendil-works/pi-coding-agent`, so `PI_LENS_PI_HOST_PACKAGE` switched only
// the scripted provider. A directory holding nothing but a manifest and a
// pi-ai shim ran `tests/support/pi-session.test.ts` green 16/16, and the
// certified-host spread printed that result on an OLD host's line (measured:
// `Tests 16 passed (16)` before the fix, `15 failed | 1 passed` after it).
//
// The cases below drive the resolver the tier itself uses — the environment
// override included — so a host directory that supplies no session code is
// refused instead of being reported as probed. A stub of the resolver would
// pass with the defect in place, which is why every case plants a real
// package directory on disk.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { hostModule } from "./pi-session.js";

/** The one override the tier, and therefore this file, resolves through. */
const HOST_PACKAGE_ENV = "PI_LENS_PI_HOST_PACKAGE";

/** The session API members every host install must supply. */
const SESSION_API = [
	"AgentSessionRuntime",
	"ModelRuntime",
	"SessionManager",
	"createAgentSessionServices",
	"createAgentSessionFromServices",
] as const;

const fixtures: Array<{ tmpDir: string; cleanup: () => void }> = [];

function fixtureRoot(): string {
	const fixture = setupTestEnvironment("pi-lens-pi-session-host-");
	fixtures.push(fixture);
	return fixture.tmpDir;
}

/**
 * A package directory that answers for `names` and nothing else. Each export is
 * a function carrying the name it was exported under, so a case can tell the
 * fixture's module from any other copy of the API.
 */
function plantHost(root: string, names: readonly string[]): string {
	const dir = path.join(
		root,
		"pi-0.86.1",
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
	);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version: "0.86.1",
			main: "index.cjs",
		}),
	);
	const lines = [
		"const exported = {};",
		`for (const name of ${JSON.stringify(names)}) {`,
		"\texported[name] = Object.assign(function hosted() {}, { exportedAs: name });",
		"}",
		"module.exports = exported;",
	];
	fs.writeFileSync(path.join(dir, "index.cjs"), `${lines.join("\n")}\n`);
	return dir;
}

/** Run `body` with the override pointed at `dir`, and put the value back. */
function withHostOverride<T>(dir: string, body: () => T): T {
	const saved = process.env[HOST_PACKAGE_ENV];
	process.env[HOST_PACKAGE_ENV] = dir;
	try {
		return body();
	} finally {
		if (saved === undefined) delete process.env[HOST_PACKAGE_ENV];
		else process.env[HOST_PACKAGE_ENV] = saved;
	}
}

/** The fixture module's own marker, as the resolver handed it over. */
function exportedAs(name: string): string | undefined {
	const host = hostModule() as unknown as Record<
		string,
		{ exportedAs?: string } | undefined
	>;
	return host[name]?.exportedAs;
}

afterAll(async () => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
	await cleanupTestEnvironmentsDrained("pi-lens-pi-session-host-");
});

describe("the tier's session API comes from the host the override names (#4719 F1)", () => {
	it("loads the session API from that host, not from this repo's devDependency", () => {
		const dir = plantHost(fixtureRoot(), SESSION_API);
		const markers = withHostOverride(dir, () =>
			SESSION_API.map((name) => exportedAs(name)),
		);
		expect(markers).toEqual([...SESSION_API]);
	});

	it("refuses a host that carries no import entry instead of falling back", () => {
		// The reviewer's probe: a manifest and nothing else. Before the fix this
		// directory ran the whole tier against the dev host's session code.
		const root = fixtureRoot();
		const dir = path.join(root, "manifest-only");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				version: "0.86.1",
			}),
		);
		expect(() => withHostOverride(dir, () => hostModule())).toThrow(
			`${dir}/package.json declares no import entry`,
		);
	});

	it("refuses a host that stops exporting a session member", () => {
		// A host whose entry exists but no longer answers for the whole API is
		// NOT a host this tier can probe: naming the missing member is what turns
		// a half-loaded host into a refusal rather than a green run.
		const dir = plantHost(
			fixtureRoot(),
			SESSION_API.filter((name) => name !== "SessionManager"),
		);
		expect(() => withHostOverride(dir, () => hostModule())).toThrow(
			`does not export SessionManager, so the session API cannot come from the host ${HOST_PACKAGE_ENV} names (${dir})`,
		);
	});

	it("falls back to this repo's host when the override is unset", () => {
		// The per-PR tiers run with no override; a resolver that only worked when
		// `PI_LENS_PI_HOST_PACKAGE` was set would break every other tier-2 file.
		for (const name of SESSION_API)
			expect(
				typeof (hostModule() as unknown as Record<string, unknown>)[name],
			).toBe("function");
	});
});
