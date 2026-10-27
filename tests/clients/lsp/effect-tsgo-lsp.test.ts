/**
 * #4914: a project that installed `@effect/tsgo` next to TypeScript 7+ gets the
 * Effect language service through its own `effect-tsgo tsc --lsp --stdio`.
 *
 * Real seams only: the production `TypeScriptServer.spawn`, the real
 * `admitProjectSuppliedTsserver` trust gate (driven by the host trust seam,
 * `setProjectTrustState`, and the spawn-scope permission). Only the child launcher and the
 * installer are doubled, as in `tsserver-project-trust.test.ts`; nothing here
 * claims the fixture binaries speak LSP (the smoke row
 * `effect-tsgo` in `scripts/smoke-tools.mjs` runs the real server).
 *
 * Recurrences each cell names:
 *  - selection: a project that opted in kept the plain native launch and never
 *    saw an Effect diagnostic (the issue's whole point);
 *  - fallback: an `@effect/tsgo` that is not usable at the compiler's own
 *    `node_modules` level launched anyway, or an ancestor's install shadowed
 *    the nearer compiler (the #526 shadowing rule, applied to the wrapper);
 *  - trust: `effect-tsgo` is project-supplied code, so a launch that skips the
 *    gate runs a cloned repository's bytes under unknown trust (#4296).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const launchLSPMock = vi.hoisted(() => vi.fn());
const ensureToolMock = vi.hoisted(() => vi.fn());
const getToolEnvironmentMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../../../clients/lsp/launch.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/launch.js")>()),
	launchLSP: launchLSPMock,
}));
vi.mock("../../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/installer/index.js")
	>()),
	ensureTool: ensureToolMock,
	getToolEnvironment: getToolEnvironmentMock,
}));

const dirs: string[] = [];
const fakeProcess = { kill: vi.fn() } as never;

function binName(name: string): string {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

function makeRoot(label: string): string {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), `pi-lens-etsgo-${label}-`),
	);
	dirs.push(root);
	fs.writeFileSync(path.join(root, "package.json"), "{}\n");
	return root;
}

/** `<dir>/node_modules/typescript` at `version`, plus its `.bin/tsc`. */
function addTypeScript(dir: string, version: string): string {
	const pkg = path.join(dir, "node_modules", "typescript");
	fs.mkdirSync(pkg, { recursive: true });
	fs.writeFileSync(
		path.join(pkg, "package.json"),
		JSON.stringify({ name: "typescript", version }),
	);
	const bin = path.join(dir, "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	const tsc = path.join(bin, binName("tsc"));
	fs.writeFileSync(tsc, "");
	return tsc;
}

/** `<dir>/node_modules/@effect/tsgo` with a manifest, and its `.bin` link. */
function addEffectTsgo(
	dir: string,
	opts: { manifest?: string | null; bin?: boolean } = {},
): string {
	const pkg = path.join(dir, "node_modules", "@effect", "tsgo");
	fs.mkdirSync(pkg, { recursive: true });
	const manifest =
		opts.manifest === undefined
			? JSON.stringify({ name: "@effect/tsgo", version: "0.62.0" })
			: opts.manifest;
	if (manifest !== null)
		fs.writeFileSync(path.join(pkg, "package.json"), manifest);
	const bin = path.join(dir, "node_modules", ".bin", binName("effect-tsgo"));
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	if (opts.bin !== false) fs.writeFileSync(bin, "");
	return bin;
}

function addClassic(dir: string): { wrapper: string; tsserver: string } {
	const bin = path.join(dir, "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	const wrapper = path.join(bin, "typescript-language-server");
	fs.writeFileSync(wrapper, "");
	const tsserver = path.join(
		dir,
		"node_modules",
		"typescript",
		"lib",
		"tsserver.js",
	);
	fs.mkdirSync(path.dirname(tsserver), { recursive: true });
	fs.writeFileSync(tsserver, "");
	return { wrapper, tsserver };
}

async function trustedSpawn(root: string) {
	const { setProjectTrustState } =
		await import("../../../clients/project-trust.js");
	setProjectTrustState("trusted");
	const { TypeScriptServer } = await import("../../../clients/lsp/server.js");
	const { withLspProjectCodePermission } =
		await import("../../../clients/lsp/launch.js");
	return withLspProjectCodePermission(true, () =>
		TypeScriptServer.spawn(root, { allowInstall: false }),
	);
}

beforeEach(() => {
	launchLSPMock.mockReset();
	launchLSPMock.mockResolvedValue(fakeProcess);
	ensureToolMock.mockReset();
	ensureToolMock.mockResolvedValue(undefined);
	getToolEnvironmentMock.mockClear();
});

afterEach(async () => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	const trust = await import("../../../clients/project-trust.js");
	trust.resetProjectTrust();
});

describe("effect-tsgo selection (#4914)", () => {
	it("launches the project's effect-tsgo for TypeScript 7 with @effect/tsgo installed", async () => {
		const root = makeRoot("selected");
		addTypeScript(root, "7.0.2");
		const effect = addEffectTsgo(root);

		const spawned = await trustedSpawn(root);

		expect(launchLSPMock).toHaveBeenCalledTimes(1);
		expect(launchLSPMock).toHaveBeenCalledWith(
			effect,
			["tsc", "--lsp", "--stdio"],
			{ cwd: root, env: {} },
		);
		expect(spawned).toEqual({
			process: fakeProcess,
			source: "direct",
			launchVariant: "effect-tsgo",
		});
	});

	it("keeps the native launch for TypeScript 7 without @effect/tsgo", async () => {
		const root = makeRoot("native");
		const tsc = addTypeScript(root, "7.0.2");

		const spawned = await trustedSpawn(root);

		expect(launchLSPMock).toHaveBeenCalledWith(tsc, ["--lsp", "--stdio"], {
			cwd: root,
			env: {},
		});
		expect(spawned?.launchVariant).toBe("native-ts7");
	});

	it("never selects effect-tsgo for TypeScript 6, even with @effect/tsgo installed", async () => {
		const root = makeRoot("ts6");
		addTypeScript(root, "6.0.3");
		const effect = addEffectTsgo(root);
		const { wrapper, tsserver } = addClassic(root);

		const spawned = await trustedSpawn(root);

		expect(launchLSPMock).toHaveBeenCalledTimes(1);
		expect(launchLSPMock.mock.calls[0]?.[0]).toBe(wrapper);
		expect(launchLSPMock.mock.calls[0]?.[0]).not.toBe(effect);
		expect(spawned?.launchVariant).toBe("classic");
		expect(spawned?.initialization).toEqual({ tsserver: { path: tsserver } });
	});

	it("uses a hoisted @effect/tsgo that sits beside the hoisted TypeScript 7", async () => {
		const workspace = makeRoot("hoisted");
		addTypeScript(workspace, "7.0.2");
		const effect = addEffectTsgo(workspace);
		const pkgRoot = path.join(workspace, "packages", "app");
		fs.mkdirSync(pkgRoot, { recursive: true });
		fs.writeFileSync(path.join(pkgRoot, "package.json"), "{}\n");

		const spawned = await trustedSpawn(pkgRoot);

		expect(launchLSPMock).toHaveBeenCalledWith(
			effect,
			["tsc", "--lsp", "--stdio"],
			{ cwd: pkgRoot, env: {} },
		);
		expect(spawned?.launchVariant).toBe("effect-tsgo");
	});
});

describe("effect-tsgo fallback (#4914)", () => {
	it.for([
		["a directory with no manifest", { manifest: null }],
		["a malformed manifest", { manifest: "{" }],
		["a manifest with no version", { manifest: JSON.stringify({ name: "x" }) }],
		["a manifest with an empty version", { manifest: '{"version":""}' }],
		[
			"a manifest with a non-string version",
			{ manifest: JSON.stringify({ version: 7 }) },
		],
		["no bin link", { bin: false }],
	] as const)("keeps the native launch for %s", async ([, shape]) => {
		const root = makeRoot("malformed");
		const tsc = addTypeScript(root, "7.0.2");
		const effect = addEffectTsgo(root, shape);

		const spawned = await trustedSpawn(root);

		expect(launchLSPMock).toHaveBeenCalledTimes(1);
		expect(launchLSPMock).toHaveBeenCalledWith(tsc, ["--lsp", "--stdio"], {
			cwd: root,
			env: {},
		});
		expect(launchLSPMock.mock.calls[0]?.[0]).not.toBe(effect);
		expect(spawned?.launchVariant).toBe("native-ts7");
	});

	it("does not let an ancestor's @effect/tsgo shadow a nearer TypeScript 7 that has none", async () => {
		const workspace = makeRoot("shadow");
		addTypeScript(workspace, "7.0.2");
		addEffectTsgo(workspace);
		const pkgRoot = path.join(workspace, "packages", "app");
		fs.mkdirSync(pkgRoot, { recursive: true });
		fs.writeFileSync(path.join(pkgRoot, "package.json"), "{}\n");
		const nearTsc = addTypeScript(pkgRoot, "7.0.2");

		const spawned = await trustedSpawn(pkgRoot);

		expect(launchLSPMock).toHaveBeenCalledTimes(1);
		expect(launchLSPMock).toHaveBeenCalledWith(nearTsc, ["--lsp", "--stdio"], {
			cwd: pkgRoot,
			env: {},
		});
		expect(spawned?.launchVariant).toBe("native-ts7");
	});

	it("does not fall through to an ancestor's valid @effect/tsgo when the nearer install is malformed", async () => {
		const workspace = makeRoot("malformed-near");
		addTypeScript(workspace, "7.0.2");
		const ancestorEffect = addEffectTsgo(workspace);
		const pkgRoot = path.join(workspace, "packages", "app");
		fs.mkdirSync(pkgRoot, { recursive: true });
		fs.writeFileSync(path.join(pkgRoot, "package.json"), "{}\n");
		const nearTsc = addTypeScript(pkgRoot, "7.0.2");
		addEffectTsgo(pkgRoot, { manifest: "{" });

		const spawned = await trustedSpawn(pkgRoot);

		expect(launchLSPMock).toHaveBeenCalledTimes(1);
		expect(launchLSPMock.mock.calls[0]?.[0]).toBe(nearTsc);
		expect(launchLSPMock.mock.calls[0]?.[0]).not.toBe(ancestorEffect);
		expect(spawned?.launchVariant).toBe("native-ts7");
	});
});

describe("effect-tsgo trust gate (#4914)", () => {
	it.for(["unknown", "untrusted"] as const)(
		"refuses the project's effect-tsgo under %s trust and records the refusal",
		async (trust) => {
			const root = makeRoot(`trust-${trust}`);
			addTypeScript(root, "7.0.2");
			addEffectTsgo(root);
			const ledger = await import("../../../clients/degradation-ledger.js");
			ledger.resetDegradationLedger();
			const { setProjectTrustState } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState(trust);
			const { TypeScriptServer } =
				await import("../../../clients/lsp/server.js");
			const { withLspProjectCodePermission } =
				await import("../../../clients/lsp/launch.js");

			const spawned = await withLspProjectCodePermission(true, () =>
				TypeScriptServer.spawn(root, { allowInstall: false }),
			);

			// Same outcome as the native path under a refusal: nothing launches.
			expect(launchLSPMock).not.toHaveBeenCalled();
			expect(spawned).toBeUndefined();
			const refused = ledger
				.getDegradationSummary()
				.filter((entry) => entry.kind === "lsp-registry-decision")
				.flatMap((group) => group.latestReasons.map((row) => row.subject));
			expect(refused).toEqual(
				expect.arrayContaining([
					expect.stringMatching(/^project-local-binary:g\d+:effect-tsgo/),
				]),
			);
		},
	);

	it("refuses the project's effect-tsgo under trusted trust when the spawn scope denies project code", async () => {
		const root = makeRoot("scope-denied");
		addTypeScript(root, "7.0.2");
		addEffectTsgo(root);
		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		setProjectTrustState("trusted");
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");

		const spawned = await TypeScriptServer.spawn(root, {
			allowInstall: false,
			projectCodeAllowed: false,
		});

		expect(launchLSPMock).not.toHaveBeenCalled();
		expect(spawned).toBeUndefined();
	});
});
