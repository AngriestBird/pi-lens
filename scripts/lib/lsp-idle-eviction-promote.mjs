// The nightly's idle-eviction PROMOTION rule (#3989): which servers the
// measurement has shown safe and worth evicting, and the minimal source edit
// that declares them `transparent`. Pure: summary rows, the refresh-state map
// and source text in, text and decisions out, so every guard is testable
// without a language server or a git checkout. The driver is
// scripts/promote-lsp-idle-eviction.mjs; the measurement is
// scripts/measure-lsp-idle-eviction.mjs, whose `proposal` findings this acts on.
//
// Nothing here demotes: a `transparent` server the measurement vetoes is the
// drift issue's job (#3645), never this PR's.

const MB = 1024 * 1024;

/** Consecutive qualifying nightly runs before a server is promoted. */
export const PROMOTE_NIGHTS = 2;

/**
 * Idle resident memory (of the server's process tree) below which a server is
 * never promoted: eviction frees little and every eviction still costs a cold
 * start on the next request. User-confirmed default (#3989).
 */
export const IDLE_EVICTION_MIN_RSS_BYTES = 50 * MB;

/**
 * Cold start (first request after the idle window, ms) above which a server is
 * never promoted. The cost of eviction is a one-off delay on that request,
 * acceptable up to about 3 s. User-confirmed (#3989). The worse of the two
 * qualifying nights is judged, because CI-runner timing is noisy.
 */
export const COLD_START_MAX_MS = 3000;

/**
 * Servers the promotion never touches, with the reason. Each is held until PR
 * #3966 (the shared server-selection seam) merges: it changes which of these
 * servers a language resolves to, so promoting one now would declare the policy
 * on a server whose selection is about to move. Remove an entry in the PR that
 * lifts its hold, never here by hand.
 */
export const IDLE_EVICTION_HOLD = new Map([
	["docker", "held until #3966 (shared server-selection seam) merges"],
	["docker-official", "held until #3966 (shared server-selection seam) merges"],
	["expert", "held until #3966 (shared server-selection seam) merges"],
	["python-jedi", "held until #3966 (shared server-selection seam) merges"],
]);

/**
 * @typedef {{ day: string, rssMb: number | null, coldMs: number }} Night
 * @typedef {Record<string, { nights: Night[] }>} NightState
 */

/** A row that counts as one qualifying night for a still-`unmeasured` server. */
function qualifies(row) {
	return (
		row.declared === "unmeasured" &&
		row.result === "eligible" &&
		row.respawn === "ok" &&
		row.coverage === "preserved" &&
		// A night with cold start `n/a` does not count, and one over the cap breaks
		// the run of nights: the pair must both be acceptable.
		typeof row.coldStartMs === "number" &&
		Number.isFinite(row.coldStartMs) &&
		row.coldStartMs <= COLD_START_MAX_MS
	);
}

/**
 * Advance the per-server night memory by one run. A server keeps (or gains) a
 * night only when this run's row qualifies; every other outcome (vetoed,
 * inconclusive, unavailable, budget-exhausted, no row, over the cold-start cap,
 * no longer `unmeasured`) drops its entry, so the nights held are consecutive.
 * Two runs on one UTC day count once (a manual dispatch must not satisfy the
 * rule), and an entry that already holds `PROMOTE_NIGHTS` nights is left
 * untouched, so a settled server writes a byte-identical block and the refresh
 * PR does not open on timing noise.
 *
 * @param {NightState | undefined} prior
 * @param {readonly object[]} rows  this run's summary rows
 * @param {string} today  UTC `YYYY-MM-DD`
 * @returns {NightState}
 */
export function advanceNights(prior, rows, today) {
	/** @type {NightState} */
	const next = {};
	for (const row of rows) {
		if (!qualifies(row)) continue;
		const held = prior?.[row.serverId]?.nights ?? [];
		if (held.length >= PROMOTE_NIGHTS) {
			next[row.serverId] = { nights: held.slice(-PROMOTE_NIGHTS) };
			continue;
		}
		/** @type {Night} */
		const night = {
			day: today,
			rssMb:
				typeof row.rssBytes === "number" ? Math.round(row.rssBytes / MB) : null,
			coldMs: Math.round(row.coldStartMs),
		};
		const kept = held.at(-1)?.day === today ? held.slice(0, -1) : held;
		next[row.serverId] = { nights: [...kept, night] };
	}
	return next;
}

/**
 * Decide which servers to promote from the night memory.
 *
 * @param {NightState} state  after `advanceNights`
 * @returns {{ promote: { serverId: string, nights: Night[], minRssMb: number, worstColdMs: number }[], skipped: { serverId: string, reason: string }[] }}
 */
export function selectPromotions(state) {
	const promote = [];
	const skipped = [];
	for (const serverId of Object.keys(state).sort()) {
		const nights = state[serverId].nights;
		if (nights.length < PROMOTE_NIGHTS) {
			skipped.push({
				serverId,
				reason: `pending: ${nights.length}/${PROMOTE_NIGHTS} consecutive eligible nights`,
			});
			continue;
		}
		const hold = IDLE_EVICTION_HOLD.get(serverId);
		if (hold) {
			skipped.push({ serverId, reason: hold });
			continue;
		}
		if (nights.some((n) => n.rssMb === null)) {
			skipped.push({ serverId, reason: "idle RSS not measured on a night" });
			continue;
		}
		const minRssMb = Math.min(...nights.map((n) => n.rssMb));
		if (minRssMb * MB < IDLE_EVICTION_MIN_RSS_BYTES) {
			skipped.push({
				serverId,
				reason: `idle RSS ${minRssMb} MB is below the ${IDLE_EVICTION_MIN_RSS_BYTES / MB} MB floor`,
			});
			continue;
		}
		const worstColdMs = Math.max(...nights.map((n) => n.coldMs));
		if (worstColdMs > COLD_START_MAX_MS) {
			skipped.push({
				serverId,
				reason: `cold start ${worstColdMs} ms exceeds the ${COLD_START_MAX_MS} ms cap`,
			});
			continue;
		}
		promote.push({ serverId, nights, minRssMb, worstColdMs });
	}
	return { promote, skipped };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Flip ONE server's `idleEviction: "unmeasured"` line to `"transparent"` in
 * `clients/lsp/server.ts`, fail closed. The line is located structurally: the
 * server's `id: "<id>",` property (one tab deep, exactly one in the file) must
 * be IMMEDIATELY followed by an `idleEviction:` property at the same depth, so
 * the line edited is provably that server's own. A server built by a shared
 * factory (`createInteractiveServer({ id: "java", ... })`) has no such line of
 * its own; the factory's single line serves many servers and is never edited.
 *
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function promoteDeclaration(source, serverId) {
	const lines = source.split("\n");
	const idLine = new RegExp(`^\\tid: "${escapeRe(serverId)}",$`);
	const at = lines.flatMap((l, i) => (idLine.test(l) ? [i] : []));
	if (at.length === 0)
		return { ok: false, reason: `no \`id: "${serverId}",\` definition found` };
	if (at.length > 1)
		return {
			ok: false,
			reason: `\`id: "${serverId}",\` is ambiguous (${at.length} definitions)`,
		};
	const next = lines[at[0] + 1] ?? "";
	const decl = /^\tidleEviction: "(transparent|resident|unmeasured)",$/.exec(
		next,
	);
	if (!decl)
		return {
			ok: false,
			reason: `no \`idleEviction:\` line directly after its \`id:\` (shared factory or reordered definition)`,
		};
	if (decl[1] !== "unmeasured")
		return { ok: false, reason: `already declared ${decl[1]}` };
	const out = [...lines];
	out[at[0] + 1] = '\tidleEviction: "transparent",';
	return { ok: true, text: out.join("\n") };
}

/**
 * Add the reason row `tests/config/lsp-idle-eviction-registry.test.ts` demands
 * for every non-`unmeasured` policy. Fail closed on a file that is not the
 * canonical tab-indented JSON the writer would produce, so an edit never
 * reformats a hand-maintained file.
 *
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function addReasons(text, reasons) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, reason: "reasons file is not valid JSON" };
	}
	const render = (value) => `${JSON.stringify(value, null, "\t")}\n`;
	if (render(parsed) !== text)
		return { ok: false, reason: "reasons file is not canonically formatted" };
	return { ok: true, text: render({ ...parsed, ...reasons }) };
}

/**
 * Apply one run: advance the night memory, select, and edit. Everything a
 * caller must write comes back; nothing is written here.
 *
 * @param {{ rows: readonly object[], prior: NightState | undefined, today: string, serverSource: string, reasonsText: string, runUrl?: string | null }} input
 */
export function planPromotions({
	rows,
	prior,
	today,
	serverSource,
	reasonsText,
	runUrl,
}) {
	const state = advanceNights(prior, rows, today);
	const { promote, skipped } = selectPromotions(state);
	let source = serverSource;
	const promoted = [];
	const reasons = {};
	for (const p of promote) {
		const edit = promoteDeclaration(source, p.serverId);
		if (!edit.ok) {
			skipped.push({ serverId: p.serverId, reason: edit.reason });
			continue;
		}
		source = edit.text;
		promoted.push(p);
		reasons[p.serverId] =
			`Nightly measurement (#3989): eligible, respawn ok and findings preserved on ${PROMOTE_NIGHTS} consecutive runs, idle RSS ${p.minRssMb} MB, cold start ${p.worstColdMs} ms.`;
	}
	let reasonsOut = reasonsText;
	if (promoted.length > 0) {
		const added = addReasons(reasonsText, reasons);
		if (!added.ok) {
			// Without the reason rows the registry test would red: promote nothing.
			for (const p of promoted)
				skipped.push({ serverId: p.serverId, reason: added.reason });
			return {
				state,
				promoted: [],
				skipped,
				serverSource,
				reasonsText,
				body: null,
			};
		}
		reasonsOut = added.text;
	}
	return {
		state,
		promoted,
		skipped,
		serverSource: source,
		reasonsText: reasonsOut,
		body: promoted.length
			? renderPromotionBody(promoted, skipped, runUrl)
			: null,
	};
}

/** The bot PR's body: the measured table per promoted server, and how to re-run. */
export function renderPromotionBody(promoted, skipped, runUrl) {
	const lines = [
		"Automated promotion from the nightly `tool-smoke` idle-eviction measurement (#3989). This PR is a draft and is never auto-merged.",
		"",
		`Each server below was measured \`eligible\` (eviction and respawn preserved every finding) on ${PROMOTE_NIGHTS} consecutive nightly runs, held idle RSS of at least ${IDLE_EVICTION_MIN_RSS_BYTES / MB} MB, and cold-started in at most ${COLD_START_MAX_MS} ms on both nights (the worse night is judged). It flips that server's \`idleEviction: "unmeasured"\` to \`"transparent"\` in \`clients/lsp/server.ts\` and adds its reason row to \`tests/config/lsp-idle-eviction-reasons.json\`. Nothing is ever demoted here: a declared-transparent server the measurement vetoes is the drift issue's job (#3645).`,
		"",
		"| server | night 1 (day, rss MB, cold start ms) | night 2 (day, rss MB, cold start ms) | nights eligible |",
		"|---|---|---|---|",
		...promoted.map((p) => {
			const cell = (n) => `${n.day}, ${n.rssMb}, ${n.coldMs}`;
			return `| ${p.serverId} | ${cell(p.nights[0])} | ${cell(p.nights[1])} | ${p.nights.length} |`;
		}),
	];
	if (skipped.length) {
		lines.push("", "Not promoted this run:", "");
		for (const s of skipped) lines.push(`- ${s.serverId}: ${s.reason}`);
	}
	if (runUrl) lines.push("", `Measured by workflow run: ${runUrl}`);
	lines.push(
		"",
		"To trigger it: the nightly `tool-smoke` run on master, or `workflow_dispatch` of `tool-smoke` on master. Two runs on one UTC day count as one night.",
		"",
		"This PR is created with the repository `GITHUB_TOKEN`, which cannot trigger workflow runs. A maintainer must close and reopen it to arm CI.",
		"",
		"Refs #3989, #3645, #3622, #1332.",
	);
	return `${lines.join("\n")}\n`;
}
