import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
	type InstanceEntry,
	readInstanceRegistry,
} from "./instance-registry.js";
import {
	realIsPidAlive,
	STALE_HEARTBEAT_MS,
} from "./instance-reaper.js";
import { logLatency } from "./latency-logger.js";
import { getLSPService } from "./lsp/index.js";
import {
	contentHash,
	diagnosticsIpcPathForCwd,
	requestWarmDiagnostics,
	type WarmDiagnosticsRequest,
	type WarmDiagnosticsResult,
	WARM_DIAGNOSTICS_SCHEMA_VERSION,
} from "./mcp/ipc.js";
import { normalizeFilePath } from "./path-utils.js";

interface AttachState {
	cwd?: string;
	incumbentPid?: number;
	local: boolean;
	server?: net.Server;
}

const state: AttachState = { local: true };

function record(event: string, cwd: string, reason?: string, pid?: number): void {
	logLatency({
		type: "phase",
		phase: "lsp_warm_attach",
		filePath: cwd,
		durationMs: 0,
		metadata: { event, reason, incumbentPid: pid },
	});
}

export function selectWarmAttachIncumbent(
	entries: readonly InstanceEntry[],
	cwd: string,
	now = Date.now(),
	isPidAlive: (pid: number) => boolean = realIsPidAlive,
): InstanceEntry | undefined {
	const root = normalizeFilePath(cwd);
	return entries
		.filter(
			(entry) =>
				entry.pid !== process.pid &&
				entry.projectRoot === root &&
				isPidAlive(entry.pid) &&
				Number.isFinite(Date.parse(entry.heartbeatAt)) &&
				now - Date.parse(entry.heartbeatAt) <= STALE_HEARTBEAT_MS,
		)
		.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
}

async function serveRequest(
	req: WarmDiagnosticsRequest,
): Promise<{ result?: unknown; error?: string }> {
	if (
		req.route !== "diagnostics" ||
		req.version !== WARM_DIAGNOSTICS_SCHEMA_VERSION
	) {
		return { error: "schema mismatch" };
	}
	if (Date.now() > req.deadlineAt || contentHash(req.content) !== req.contentHash) {
		return { error: "stale request" };
	}
	const touched = await getLSPService().touchFile(req.file, req.content, {
		diagnostics: "document",
		collectDiagnostics: true,
		clientScope: "with-auxiliary",
		maxClientWaitMs: Math.max(1, req.deadlineAt - Date.now()),
		maxDiagnosticsWaitMs: Math.max(1, req.deadlineAt - Date.now()),
		source: "warm-attach-incumbent",
	});
	const servedAt = Date.now();
	return {
		result: {
			route: "diagnostics",
			version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
			diagnostics: touched ?? [],
			contentHash: req.contentHash,
			servedAt,
			fresh: servedAt <= req.deadlineAt && touched !== undefined,
			inconclusive: touched?.inconclusive === true,
		},
	};
}

function startServer(cwd: string): void {
	state.server?.close();
	const endpoint = diagnosticsIpcPathForCwd(cwd, process.pid);
	if (process.platform !== "win32") {
		try {
			fs.unlinkSync(endpoint);
		} catch {
			// No stale socket.
		}
	}
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			void (async () => {
				try {
					const req = JSON.parse(buffer.slice(0, newline)) as WarmDiagnosticsRequest;
					socket.end(`${JSON.stringify(await serveRequest(req))}\n`);
				} catch (error) {
					socket.end(`${JSON.stringify({ error: String(error) })}\n`);
				}
			})();
		});
	});
	server.on("error", (error) => {
		record("listener-error", cwd, String(error));
	});
	server.listen(endpoint);
	server.unref();
	state.server = server;
}

export async function configureWarmAttach(cwd: string): Promise<void> {
	state.cwd = path.resolve(cwd);
	state.incumbentPid = undefined;
	state.local = true;
	if (process.env.PI_LENS_WARM_ATTACH !== "1") {
		record("disabled", state.cwd, "opt-in-not-enabled");
		return;
	}
	startServer(state.cwd);
	const incumbent = selectWarmAttachIncumbent(
		await readInstanceRegistry(),
		state.cwd,
	);
	if (!incumbent) {
		record("local", state.cwd, "no-live-incumbent");
		return;
	}
	state.incumbentPid = incumbent.pid;
	state.local = false;
	record("attached", state.cwd, undefined, incumbent.pid);
}

export async function tryWarmAttachedDiagnostics(
	file: string,
	content: string,
	timeoutMs: number,
): Promise<WarmDiagnosticsResult | undefined> {
	if (state.local || !state.cwd || !state.incumbentPid) return undefined;
	const entries = await readInstanceRegistry();
	const incumbent = selectWarmAttachIncumbent(entries, state.cwd);
	if (incumbent?.pid !== state.incumbentPid) {
		promoteToLocal("incumbent-stale-or-exited");
		return undefined;
	}
	const result = await requestWarmDiagnostics(
		state.cwd,
		state.incumbentPid,
		file,
		content,
		timeoutMs,
	);
	if (!result.available) promoteToLocal(result.reason);
	return result;
}

export function isWarmAttached(): boolean {
	return !state.local && state.incumbentPid !== undefined;
}

function promoteToLocal(reason: string): void {
	if (state.local) return;
	const pid = state.incumbentPid;
	state.local = true;
	state.incumbentPid = undefined;
	record("takeover", state.cwd ?? process.cwd(), reason, pid);
}

export function _resetWarmAttachForTests(): void {
	state.server?.close();
	state.server = undefined;
	state.cwd = undefined;
	state.incumbentPid = undefined;
	state.local = true;
}

export function _setWarmAttachForTests(cwd: string, incumbentPid: number): void {
	state.cwd = path.resolve(cwd);
	state.incumbentPid = incumbentPid;
	state.local = false;
}
