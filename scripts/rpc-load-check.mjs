#!/usr/bin/env node
/**
 * RPC session smoke — drive pi-lens the way an RPC child runs it, headless and
 * model-free, and red on ANY failure signal from start to the end of the first
 * turn.
 *
 * Recurrence this guard names: #4400 (pi exited at session start under
 * `pi --mode rpc` when the snapshot persist worker failed; nobody had run pi as
 * an RPC child with a failing worker) and #4314 (the 4.4.2 tarball failed the
 * LSP warm in every session; this check passed because a failed warm is a log
 * line, not an `extension_error`). Both shipped past a check that only waited
 * for `get_commands`. The issue is #4401.
 *
 * What one run does (about 5 s, measured):
 *   1. spawn `pi --mode rpc` with a PRIVATE agent dir and PI_LENS_HOME, and a
 *      fake OpenAI-compatible provider on 127.0.0.1 (no credentials, no network);
 *   2. `get_commands`, and assert pi-lens's `lens-*` commands registered;
 *   3. wait for the session-start warm-up (`warmup_total` in latency.log);
 *   4. send a real `prompt`, wait for `agent_end` and a clean `stop`;
 *   5. read pi-lens's own logs under the pinned PI_LENS_HOME.
 * It FAILS (exit 1) on any of: the pi process exiting, an `extension_error`
 * event, a pi-lens notice at `warning` or `error` severity
 * (`extension_ui_request` / `notify`), an `extension.log` line at `error` or
 * `warn` (bar the one designed untrusted-project refusal), a latency.log
 * phase named `*_failed` / `*_error`, or a degraded snapshot-worker fallback.
 * Exit 2 = a stage timed out.
 *
 * `--fail-worker` forces the project-snapshot persist worker to answer its
 * first request with `{ id, generation, error }` and no `stagePath` (the #4400
 * wire shape; the seam is PI_LENS_TEST_SNAPSHOT_WORKER_FAIL in
 * clients/project-snapshot-persist-worker.ts). Pi must survive, finish the turn
 * and log the main-thread fallback for that exact reason; that one degraded
 * fallback is the only failure signal the variant tolerates.
 *
 * Used by .github/workflows/install-smoke.yml (pi-load: the installed package;
 * host-range-smoke: the packed tarball, plus the failing-worker variant).
 *
 * Usage: node scripts/rpc-load-check.mjs [path-to-pi-bin]
 *          [--extension <path-to-pi-lens>] [--fail-worker]
 *   no --extension: pi-lens comes from the ambient agent dir's `packages`
 *   (`pi install`), which this script links into its private agent dir.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	parseNdjsonEntries,
	phaseWasLogged,
} from "./lib/latency-log-phases.mjs";

/** The env var the failing-worker variant sets; the worker echoes it back. */
export const FORCE_WORKER_FAIL_ENV = "PI_LENS_TEST_SNAPSHOT_WORKER_FAIL";
/** The worker's forced error starts with this; the smoke keys its tolerance on it. */
export const FORCED_ERROR_MARKER = "forced snapshot worker failure";
/** Notice severities (`notifyType`) that are failures; `info` is not. */
const FAILING_NOTIFY_TYPES = new Set(["warning", "error"]);
/** A latency.log phase named like a failure. */
const FAILING_PHASE = /_(failed|error)$/;

/**
 * Failure carried by one RPC stdout message, or undefined. Shapes (pi docs
 * json.md / rpc-extension-ui.md): `{type:"extension_error",...}` (older hosts
 * wrap it as `{type:"event",event:"extension_error"}`), and a notice is
 * `{type:"extension_ui_request",method:"notify",message,notifyType}` with
 * `notifyType` defaulting to `info`.
 */
export function rpcMessageFailure(message) {
	if (!message || typeof message !== "object") return undefined;
	if (
		message.type === "extension_error" ||
		(message.type === "event" && message.event === "extension_error")
	) {
		return `extension_error: ${String(message.error ?? "").slice(0, 300)} (${String(message.event ?? "")})`;
	}
	if (message.type === "extension_ui_request" && message.method === "notify") {
		const severity = message.notifyType ?? "info";
		if (FAILING_NOTIFY_TYPES.has(severity)) {
			return `${severity} notice: ${String(message.message ?? "").slice(0, 300)}`;
		}
	}
	return undefined;
}

/**
 * Failure carried by one record of pi-lens's own logs, or undefined.
 * `file` is `extension.log` (NDJSON, `level`) or `latency.log` (NDJSON,
 * `type:"phase"`). `allowFallbackReason` is the one degraded worker fallback
 * the failing-worker variant expects.
 */
export function logRecordFailure(file, record, allowFallbackReason) {
	if (!record || typeof record !== "object") return undefined;
	if (file === "extension.log") {
		if (record.level !== "error" && record.level !== "warn") return undefined;
		// The designed refusal in an untrusted project (LSP/tool installs are
		// blocked by design, and the smoke project is untrusted).
		if (
			record.subsystem === "project-trust" &&
			record.level === "warn" &&
			String(record.message ?? "").startsWith(
				"install/materialization blocked:",
			) &&
			record.metadata?.trustState === "untrusted"
		) {
			return undefined;
		}
		return `extension.log ${record.level} [${record.subsystem}]: ${String(record.message ?? "").slice(0, 300)}`;
	}
	if (file === "latency.log" && record.type === "phase") {
		const phase = String(record.phase ?? "");
		if (phase === "project_snapshot_worker_fallback") {
			if (record.metadata?.degraded !== true) return undefined;
			const reason = String(record.metadata?.reason ?? "");
			if (allowFallbackReason && reason.includes(allowFallbackReason)) {
				return undefined;
			}
			return `latency.log degraded snapshot worker fallback: ${reason.slice(0, 300)}`;
		}
		if (FAILING_PHASE.test(phase)) {
			return `latency.log phase ${phase}: ${JSON.stringify(record.metadata ?? {}).slice(0, 300)}`;
		}
	}
	return undefined;
}

function readNdjson(file) {
	try {
		return parseNdjsonEntries(fs.readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

/** A minimal OpenAI-compatible streaming completion: one `ok` reply, no tools. */
function startFakeProvider() {
	const state = { requests: 0 };
	const server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			state.requests++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta, finish) =>
				`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
			res.write(chunk({ role: "assistant", content: "ok" }));
			res.write(chunk({}, "stop"));
			res.write(
				`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () =>
			resolve({ server, state, port: server.address().port }),
		);
	});
}

/** Private agent dir: the fake provider, plus the ambient packages when no --extension. */
function writeAgentDir(agentDir, port, linkAmbientPackages) {
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "fake",
					models: [{ id: "fake-model" }],
				},
			},
		}),
	);
	const settings = { defaultProvider: "fake", defaultModel: "fake-model" };
	if (linkAmbientPackages) {
		const ambient =
			process.env.PI_CODING_AGENT_DIR ||
			path.join(os.homedir(), ".pi", "agent");
		try {
			const ambientSettings = JSON.parse(
				fs.readFileSync(path.join(ambient, "settings.json"), "utf8"),
			);
			for (const key of ["packages", "npmCommand"]) {
				if (ambientSettings[key] !== undefined)
					settings[key] = ambientSettings[key];
			}
		} catch {
			// no ambient settings: the command assertion below reports "did it load?"
		}
		for (const dir of ["npm", "git"]) {
			try {
				fs.symlinkSync(
					path.join(ambient, dir),
					path.join(agentDir, dir),
					"dir",
				);
			} catch {
				// no such ambient dir
			}
		}
	}
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify(settings),
	);
}

class StageTimeout extends Error {}

async function run(piBin, { extension, failWorker }) {
	const scratch = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-rpc-session-smoke-"),
	);
	const agentDir = path.join(scratch, "agent");
	const lensHome = path.join(scratch, "lens-home");
	fs.mkdirSync(lensHome, { recursive: true });
	const provider = await startFakeProvider();
	writeAgentDir(agentDir, provider.port, !extension);

	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_LENS_HOME: lensHome,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
	};
	// pi-lens writes no logs under a test runner; this smoke needs them.
	delete env.VITEST;
	if (env.NODE_ENV === "test") delete env.NODE_ENV;
	if (failWorker) env[FORCE_WORKER_FAIL_ENV] = "no-stage-path";
	else delete env[FORCE_WORKER_FAIL_ENV];

	const args = ["--mode", "rpc", "--no-session"];
	if (extension) args.push("-e", path.resolve(extension));
	const pi = spawn(piBin, args, { stdio: ["pipe", "pipe", "pipe"], env });

	const failures = [];
	const stderrTail = [];
	let exited;
	let buf = "";
	let commandsResponse;
	let agentEnd;
	pi.stderr.on("data", (d) => {
		stderrTail.push(d.toString());
		if (stderrTail.length > 40) stderrTail.shift();
	});
	pi.stdin.on("error", () => {
		// a write to an exited pi; `exited` reports it
	});
	pi.on("exit", (code, signal) => {
		exited = { code, signal };
	});
	pi.stdout.on("data", (d) => {
		// Strict JSONL: split on LF only (per pi RPC framing rules).
		buf += d.toString();
		let i = buf.indexOf("\n");
		while (i >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, "");
			buf = buf.slice(i + 1);
			i = buf.indexOf("\n");
			if (!line.trim()) continue;
			let m;
			try {
				m = JSON.parse(line);
			} catch {
				continue;
			}
			const failure = rpcMessageFailure(m);
			if (failure) failures.push(failure);
			if (m.type === "response" && m.command === "get_commands")
				commandsResponse = m;
			if (m.type === "agent_end") agentEnd = m;
		}
	});

	const stage = { name: "start" };
	const waitFor = async (what, ms, probe) => {
		stage.name = what;
		const deadline = Date.now() + ms;
		for (;;) {
			if (exited) return undefined;
			const value = probe();
			if (value) return value;
			if (Date.now() > deadline)
				throw new StageTimeout(`TIMEOUT waiting for ${what} (${ms}ms)`);
			await new Promise((r) => setTimeout(r, 50));
		}
	};
	const send = (message) => {
		try {
			pi.stdin.write(`${JSON.stringify(message)}\n`);
		} catch {
			// an exited pi is reported through `exited`
		}
	};
	const latency = () => readNdjson(path.join(lensHome, "latency.log"));
	const forcedFallback = () =>
		latency().find(
			(r) =>
				r.phase === "project_snapshot_worker_fallback" &&
				String(r.metadata?.reason ?? "").includes(FORCED_ERROR_MARKER),
		);

	let timedOut;
	try {
		// Give pi a moment to open stdin before the first command.
		await new Promise((r) => setTimeout(r, 500));
		send({ id: "cmds", type: "get_commands" });
		await waitFor("get_commands response", 30000, () => commandsResponse);
		if (!exited) {
			const cmds = commandsResponse?.data?.commands || [];
			const lens = cmds.filter(
				(c) =>
					String(c.name || "").startsWith("lens-") ||
					String(c.path || "").includes("pi-lens"),
			);
			console.log(
				`total commands: ${cmds.length}; pi-lens commands: ${lens.map((c) => c.name).join(", ") || "(none)"}`,
			);
			if (!lens.length)
				failures.push("pi-lens registered no commands (did it load?)");
		}
		await waitFor(
			"session-start warm-up (warmup_total in latency.log)",
			30000,
			() => phaseWasLogged(latency(), "warmup_total"),
		);
		send({ id: "turn", type: "prompt", message: "hello" });
		await waitFor("first turn (agent_end)", 30000, () => agentEnd);
		if (agentEnd && !exited) {
			const last = [...(agentEnd.messages || [])]
				.reverse()
				.find((m) => m.role === "assistant");
			if (!last || last.stopReason !== "stop")
				failures.push(
					`first turn did not finish cleanly: stopReason=${last?.stopReason ?? "(no assistant message)"}`,
				);
			if (provider.state.requests < 1)
				failures.push("first turn never reached the fake provider");
		}
		if (failWorker) {
			await waitFor(
				"the forced worker failure's main-thread fallback",
				15000,
				() => forcedFallback(),
			);
		} else {
			// Post-turn work (the snapshot save after the turn) must settle too.
			await new Promise((r) => setTimeout(r, 1000));
		}
	} catch (err) {
		if (err instanceof StageTimeout) timedOut = err.message;
		else throw err;
	}

	if (exited) {
		failures.push(
			`pi exited during "${stage.name}" (code ${exited.code}, signal ${exited.signal})`,
		);
	}
	for (const r of readNdjson(path.join(lensHome, "extension.log"))) {
		const f = logRecordFailure("extension.log", r);
		if (f) failures.push(f);
	}
	for (const r of latency()) {
		const f = logRecordFailure(
			"latency.log",
			r,
			failWorker ? FORCED_ERROR_MARKER : undefined,
		);
		if (f) failures.push(f);
	}

	try {
		pi.kill("SIGKILL");
	} catch {}
	provider.server.close();
	const unique = [...new Set(failures)];
	if (unique.length || timedOut) {
		for (const f of unique) console.log(`FAIL: ${f}`);
		if (timedOut) console.log(timedOut);
		if (stderrTail.length)
			console.log(`pi stderr (tail):\n${stderrTail.join("").slice(-2000)}`);
		console.log(`scratch kept for forensics: ${scratch}`);
		return unique.length ? 1 : 2;
	}
	fs.rmSync(scratch, { recursive: true, force: true });
	console.log(
		`PASS: pi-lens loaded and survived start, warm-up and the first turn${failWorker ? " with the snapshot worker forced to fail" : ""}`,
	);
	return 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const argv = process.argv.slice(2);
	const opts = { extension: undefined, failWorker: false };
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--extension") opts.extension = argv[++i];
		else if (argv[i] === "--fail-worker") opts.failWorker = true;
		else positional.push(argv[i]);
	}
	run(positional[0] || "pi", opts).then(
		(code) => process.exit(code),
		(err) => {
			console.log(`ERROR: ${err?.stack || err}`);
			process.exit(1);
		},
	);
}
