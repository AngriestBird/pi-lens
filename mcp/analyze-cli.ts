#!/usr/bin/env node
/**
 * pi-lens-analyze — the *push* half of the mirror, in two modes.
 *
 * Per-edit (default): a Claude Code PostToolUse hook (matched to Edit|Write)
 * that fires pi-lens automatically after every edit, the way pi's per-edit
 * pipeline does. Also usable as a plain CLI for testing/debugging. Reuses the
 * Tier 1 `analyzeFile` facade and defaults to `no-lsp` so inline feedback is
 * FAST (cold LSP would cost ~5s per edit and under-report anyway — pull
 * `pilens_analyze` against the warm MCP server for the type-check). The fast
 * runners (tree-sitter structural, ast-grep security, biome/ruff/oxlint lint,
 * complexity) are complete even in a cold process.
 *
 * Per-turn (`--turn-end`, or a Claude Code `Stop` payload on stdin): the
 * analogue of pi's agent_end — incremental knip/madge, cascade-to-dependents,
 * tests, actionable-warnings aggregation. WARM-ONLY: it drives the real
 * `handleTurnEnd` inside the running MCP server over the workspace IPC socket
 * and never falls back to a cold pass, because only the warm process owns the
 * session state and pending turn work. No warm server → one stderr line and
 * silent stdout.
 *
 * Input: `--file=<path>` (+ optional `--cwd=`), or a Claude Code hook JSON
 * payload on stdin (`tool_input.path`/`file_path`, `cwd`, `hook_event_name`).
 * Output: a concise report on stdout; with `--hook`, a PostToolUse JSON
 * envelope that injects the report as context. Exit 0 always (advisory — never
 * blocks the edit, never blocks the stop).
 */

import * as path from "node:path";
import type { McpAnalyzeResult } from "../clients/mcp/analyze.js";
import {
	requestWarmAnalyze,
	requestWarmTurnEnd,
	type WarmTurnEndResponse,
} from "../clients/mcp/ipc.js";
// Type-only deps at runtime — safe for the bin's light no-edit path.
import { AUTOMATION_FRAMING } from "../clients/runtime-context.js";

console.log = (...args: unknown[]) => console.error(...args);

function argVal(name: string): string | undefined {
	const prefix = `--${name}=`;
	const found = process.argv.find((value) => value.startsWith(prefix));
	return found ? found.slice(prefix.length) : undefined;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function formatReport(result: McpAnalyzeResult, cwd: string): string {
	const rel = path.relative(cwd, result.filePath) || result.filePath;
	const lines = [
		`🔎 pi-lens: ${rel} — ${result.counts.blockers} blocking, ${result.counts.warnings} warning(s)`,
	];
	for (const d of result.diagnostics.slice(0, 30)) {
		const marker = d.semantic === "blocking" ? "🔴" : "⚠";
		const label = d.rule ?? d.tool;
		lines.push(`  ${marker} L${d.line ?? "?"} ${label}: ${d.message}`);
	}
	if (result.diagnostics.length > 30) {
		lines.push(`  … ${result.diagnostics.length - 30} more`);
	}
	if (result.lsp && result.lsp.status === "skipped") {
		lines.push(
			"  (LSP type-check skipped — run pilens_analyze on the warm MCP server for type errors)",
		);
	}
	return lines.join("\n");
}

interface HookPayload {
	cwd?: string;
	hook_event_name?: string;
	tool_input?: { file_path?: string; path?: string };
}

async function readHookPayload(): Promise<HookPayload | undefined> {
	if (process.stdin.isTTY) return undefined;
	try {
		return (JSON.parse(await readStdin()) as HookPayload | null) ?? undefined;
	} catch {
		// not a JSON payload — plain CLI invocation
		return undefined;
	}
}

// The framing token is for pi's user-role injection; the rest of the first
// line reads fine in a transcript, so only the token goes.
const TURN_END_MAX_LINES = 40;
const TURN_END_MAX_CHARS = 2000;

function formatTurnEnd(response: WarmTurnEndResponse): string | undefined {
	const sections = [response.turnEnd, response.tests]
		.filter((section): section is string => Boolean(section))
		.map((section) =>
			section.startsWith(AUTOMATION_FRAMING)
				? section.slice(AUTOMATION_FRAMING.length)
				: section,
		);
	if (sections.length === 0) return undefined;

	// `turnEnd` is server-capped, `tests` is not (a vitest failure dump can run long).
	let out = `🔎 pi-lens turn-end\n${sections.join("\n\n")}`;
	const lines = out.split("\n");
	if (lines.length > TURN_END_MAX_LINES) {
		out = `${lines.slice(0, TURN_END_MAX_LINES).join("\n")}\n  … (truncated)`;
	}
	if (out.length > TURN_END_MAX_CHARS) {
		out = `${out.slice(0, TURN_END_MAX_CHARS)}\n  … (truncated)`;
	}
	return out;
}

async function runTurnEndMode(
	cwd: string,
	payload: HookPayload | undefined,
): Promise<void> {
	// Subagent edits already fire PostToolUse into the shared workspace turn
	// state, and the consume bridges are one-shot — a subagent pass would eat the
	// main agent's findings into a transcript nobody reads, and multiply the
	// heavy pass by the fan-out. Only the main agent's Stop runs it.
	if (payload?.hook_event_name === "SubagentStop") {
		process.stderr.write(
			"pi-lens turn-end skipped: SubagentStop (the main agent's Stop runs the pass)\n",
		);
		process.exitCode = 0;
		return;
	}

	// Warm-only by design: only the server process owns the session state and
	// pending turn work, so a cold pass would report a false clean (#533/#1023).
	const outcome = await requestWarmTurnEnd(cwd);
	if (!outcome.available) {
		process.stderr.write(
			`pi-lens turn-end skipped (${outcome.reason}) — no warm pi-lens MCP server for ${cwd}\n`,
		);
		process.exitCode = 0;
		return;
	}

	const report = formatTurnEnd(outcome.response);
	if (report) {
		await new Promise<void>((done) => {
			process.stdout.write(`${report}\n`, () => done());
		});
	}
	process.exitCode = 0;
}

async function main(): Promise<void> {
	const hookMode = process.argv.includes("--hook");
	const withLsp = process.argv.includes("--lsp");
	const fileArg = argVal("file");
	const payload = await readHookPayload();
	const cwd = argVal("cwd") ?? payload?.cwd ?? process.cwd();

	const event = payload?.hook_event_name;
	if (
		process.argv.includes("--turn-end") ||
		event === "Stop" ||
		event === "SubagentStop"
	) {
		return runTurnEndMode(cwd, payload);
	}

	const file =
		fileArg ?? payload?.tool_input?.file_path ?? payload?.tool_input?.path;
	if (!file) process.exit(0); // nothing to analyze — stay silent

	// Warm path first: if the MCP server is up for this workspace, it analyzes in
	// its warm process (LSP-COMPLETE) and we never load the dispatch graph here.
	// Falls back to a cold, no-LSP local run when no server is reachable.
	let result = await requestWarmAnalyze(cwd, file);
	if (!result) {
		const { analyzeFile } = await import("../clients/mcp/analyze.js");
		result = await analyzeFile(file, cwd, {
			flags: withLsp ? {} : { "no-lsp": true },
			record: false,
			// Edit-detection path (PostToolUse) — mark the file for pilens_turn_end.
			registerTurnState: true,
		});
	}
	// One-shot consumers cannot rely on the installer's unref'd debounce.
	const { flushProbeCache } = await import("../clients/installer/index.js");
	await flushProbeCache();

	if (result.counts.diagnostics === 0) process.exit(0); // clean → no noise

	const report = formatReport(result, cwd);
	if (hookMode) {
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					additionalContext: report,
				},
			}),
		);
	} else {
		process.stdout.write(`${report}\n`);
	}
	process.exit(0);
}

main().catch((err) => {
	process.stderr.write(`pi-lens-analyze failed: ${(err as Error).message}\n`);
	process.exit(0); // advisory — never break the edit flow
});
