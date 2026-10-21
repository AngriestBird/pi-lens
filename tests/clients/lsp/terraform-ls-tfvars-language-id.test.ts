/**
 * terraform-ls opens `.tfvars` as `terraform-vars`, not `terraform`.
 *
 * terraform-ls validates a variables file only when its didOpen/didChange
 * `languageId` is `terraform-vars`; announced as `terraform` the same bytes
 * decode as module code and (with enhanced validation, terraform-ls's default
 * since 0.32) every assignment is reported as "Unexpected attribute"
 * (hashicorp/vscode-terraform#1672). The registry now carries the split
 * (clients/language-registry.ts): `.tf` -> `terraform`, `.tfvars` ->
 * `terraform-vars`, both kind `terraform`.
 *
 * Spawns a real terraform-ls child only when the binary is present (skipped
 * otherwise, like its clangd sibling). Measured server behavior (0.39.0):
 *  - the WRONG id reports "Unexpected attribute" for a declared variable in a
 *    .tfvars after open + didChange (negative control: fails pre-fix);
 *  - the RIGHT id reports nothing for the same edits, for ANY .tfvars
 *    basename (variables.tfvars and test.tfvars behave identically);
 *  - under the right id terraform-ls publishes tfvars/module results on the
 *    module DIRECTORY uri, and still validates .tf modules ("No declaration
 *    found for var.x" on an outputs.tf), so validation is not suppressed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { launchLSP, stopLSP } from "../../../clients/lsp/launch.js";
import { findCommandAsync } from "../../../clients/safe-spawn.js";
import { setupTestEnvironment } from "../test-utils.js";

// Detect terraform-ls availability at module load time via `findCommandAsync`
// (cached PATH+PATHEXT resolution, same reasoning as clangd-lazy-indexing).
const TERRAFORM_LS: string | null = await findCommandAsync("terraform-ls");

const VARIABLES_TF = ['variable "env" {', "  type    = string", "}", ""].join(
	"\n",
);
const OUTPUTS_TF = [
	'output "o" {',
	"  value = var.does_not_exist",
	"}",
	"",
].join("\n");
const TEST_TFVARS = 'env = "x"\n';

describe.skipIf(!TERRAFORM_LS)("terraform-ls .tfvars language id", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let projectDir: string;
	let moduleDir: string;
	let tfvarsPath: string;

	beforeEach(async () => {
		env = setupTestEnvironment("pi-lens-terraform-ls-");
		projectDir = env.tmpDir;
		moduleDir = path.join(projectDir, "env");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(path.join(moduleDir, "variables.tf"), VARIABLES_TF);
		tfvarsPath = path.join(moduleDir, "test.tfvars");

		if (TERRAFORM_LS === null) throw new Error("terraform-ls unavailable");

		// Same argv shape the production TerraformServer.spawn uses.
		proc = await launchLSP(TERRAFORM_LS, ["serve"], { cwd: projectDir });
		client = await createLSPClient({
			serverId: "terraform",
			process: proc,
			root: projectDir,
		});
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				// ignore
			}
			client = undefined;
		}
		if (proc) {
			try {
				await stopLSP(proc);
			} catch {
				// ignore
			}
			proc = undefined;
		}
		env.cleanup();
	});

	function unexpectedAttribute(): boolean {
		return client!
			.getDiagnostics(tfvarsPath)
			.some((d) => d.message.includes("Unexpected attribute"));
	}

	/** The wrong pre-fix id: module-code decoding of a variables file. */
	async function openAsTerraform(text: string): Promise<void> {
		if (client === undefined) throw new Error("LSP client not initialized");
		await client.notify.open(
			tfvarsPath,
			text,
			"terraform",
			undefined,
			undefined,
			undefined,
			Date.now(),
		);
		// terraform-ls reports after the change reaches the server (measured on
		// 0.39.0; a first didOpen alone can stay silent).
		await client.notify.change(tfvarsPath, `${text}# touched\n`);
		await client!.waitForDiagnostics(tfvarsPath, 15_000).catch(() => {});
	}

	it("reports `Unexpected attribute` when a .tfvars is announced as terraform", async () => {
		if (client === undefined) throw new Error("LSP client not initialized");
		await openAsTerraform(TEST_TFVARS);
		expect(
			unexpectedAttribute(),
			JSON.stringify(client!.getDiagnostics(tfvarsPath)),
		).toBe(true);
	}, 60_000);

	it("reports nothing unexpected when a .tfvars is announced as terraform-vars", async () => {
		if (client === undefined) throw new Error("LSP client not initialized");
		// Same scenario as the negative control above, with the languageId the
		// registry now sends. Under the right id terraform-ls publishes its
		// (empty) tfvars/module answer on the module DIRECTORY uri — wait there
		// so the assertion runs after the server actually processed the change,
		// not on timeout-on-a-silent-file.
		await client!.notify.open(
			tfvarsPath,
			TEST_TFVARS,
			"terraform-vars",
			undefined,
			undefined,
			undefined,
			Date.now(),
		);
		await client!.notify.change(tfvarsPath, 'env = "y"\n');
		await client!.waitForDiagnostics(moduleDir, 15_000).catch(() => {});
		expect(
			unexpectedAttribute(),
			JSON.stringify(client!.getDiagnostics(tfvarsPath)),
		).toBe(false);
	}, 60_000);

	it("still validates a .tf module under the terraform id", async () => {
		// The correct id must not be a suppression mechanism: an output
		// referencing var.does_not_exist is reported by terraform-ls itself
		// (measured 0.39.0, no terraform CLI needed), so validation demonstrably
		// still runs in the same session shape.
		if (client === undefined) throw new Error("LSP client not initialized");
		const outputsPath = path.join(moduleDir, "outputs.tf");
		fs.writeFileSync(outputsPath, OUTPUTS_TF);
		await client!.notify.open(
			outputsPath,
			OUTPUTS_TF,
			"terraform",
			undefined,
			undefined,
			undefined,
			Date.now(),
		);
		await client!.notify.change(outputsPath, `${OUTPUTS_TF}# touched\n`);
		await client!.waitForDiagnostics(outputsPath, 15_000).catch(() => {});
		const diags = client!.getDiagnostics(outputsPath);
		expect(
			diags.filter((d) => d.message.includes("var.does_not_exist")),
			JSON.stringify(diags),
		).not.toHaveLength(0);
	}, 60_000);
});
