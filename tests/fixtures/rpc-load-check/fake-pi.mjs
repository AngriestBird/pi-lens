#!/usr/bin/env node
// Stand-in for `pi --mode rpc` at the process boundary of
// scripts/rpc-load-check.mjs (#4401). It speaks only the JSONL the script
// reads: a get_commands response, a prompt that reaches the provider named in
// models.json, agent_end, and the logs pi-lens would have written under
// PI_LENS_HOME. FAKE_PI_MODE injects exactly one failure signal.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const mode = process.env.FAKE_PI_MODE ?? "clean";
const lensHome = process.env.PI_LENS_HOME;
const append = (file, record) =>
	fs.appendFileSync(path.join(lensHome, file), `${JSON.stringify(record)}\n`);
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

setTimeout(() => {
	if (mode === "log-warn") {
		append("extension.log", {
			level: "warn",
			subsystem: "lsp",
			message: "LSP warm failed: Error [ERR_MODULE_NOT_FOUND]",
		});
	}
	if (mode === "warning-notice") {
		emit({
			type: "extension_ui_request",
			id: "n1",
			method: "notify",
			message: "something degraded",
			notifyType: "warning",
		});
	}
	if (mode === "extension-error") {
		emit({
			type: "extension_error",
			extensionPath: "/x/pi-lens/dist/index.js",
			event: "session_start",
			error: "boom",
		});
	}
	if (mode !== "no-warmup") {
		append("latency.log", { type: "phase", phase: "warmup_total" });
	}
	if (process.env.PI_LENS_TEST_SNAPSHOT_WORKER_FAIL && mode !== "no-fallback") {
		append("latency.log", {
			type: "phase",
			phase: "project_snapshot_worker_fallback",
			metadata: {
				reason: "forced snapshot worker failure (PI_LENS_TEST_SNAPSHOT_WORKER_FAIL)",
				degraded: true,
			},
		});
	}
	if (mode === "host-exit") process.exit(1);
}, 300);

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
	const message = JSON.parse(line);
	if (message.type === "get_commands") {
		emit({
			id: message.id,
			type: "response",
			command: "get_commands",
			success: true,
			data: {
				commands: mode === "no-commands" ? [] : [{ name: "lens-toggle" }],
			},
		});
	}
	if (message.type === "prompt") {
		if (mode === "no-agent-end") return;
		const models = JSON.parse(
			fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"),
		);
		if (mode !== "no-provider") {
			await fetch(`${models.providers.fake.baseUrl}/chat/completions`, {
				method: "POST",
				body: "{}",
			}).then((res) => res.text());
		}
		emit({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					stopReason: mode === "turn-error" ? "error" : "stop",
				},
			],
		});
	}
});
