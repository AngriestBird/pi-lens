/**
 * #4596: the silent-catch detector's own state table, one named case per row.
 *
 * The ratchet (`tests/config/silent-catch-sweep.test.ts`) trusts this scan to
 * tell a published failure from a swallowed one. A row of that table that no
 * case here exercises is a claim with no witness, so every form the header
 * names appears below, including the two the detector must NOT be fooled by: a
 * record seam named inside a comment, and a `none:` marker inside a string
 * (AGENTS.md shape 69 — a detector that only knows the spellings it was shown
 * passes every spelling it was not).
 */
import { describe, expect, it } from "vitest";

import { type CatchSite, scanSilentCatches } from "./silent-catch-scan.js";

function only(source: string): CatchSite {
	const sites = scanSilentCatches(source);
	expect(sites).toHaveLength(1);
	return sites[0] as CatchSite;
}

describe("catch-clause verdicts", () => {
	it("calls `catch { continue; }` silent", () => {
		expect(
			only("for (const d of dirs) { try { go(d); } catch { continue; } }")
				.verdict,
		).toBe("silent");
	});

	it("calls a benign-looking fallback value silent", () => {
		expect(
			only(
				'function role(p) { try { return read(p); } catch { return "unknown"; } }',
			).verdict,
		).toBe("silent");
	});

	it("calls an empty handler silent", () => {
		expect(only("try { go(); } catch {}").verdict).toBe("silent");
	});

	it("calls a handler that records with a ledger seam recorded", () => {
		const site = only(
			"try { go(); } catch (error) { recordDegradationOnce({ kind: 'x', subject: 'y', reason: 'z' }); }",
		);
		expect(site.verdict).toBe("recorded");
		expect(site.records).toEqual(["recordDegradationOnce"]);
	});

	it("calls a handler that records with a counted seam recorded", () => {
		expect(
			only(
				"try { go(); } catch { incrementDegradationCount({ kind: 'x', subject: 'y', reason: 'z' }); }",
			).records,
		).toEqual(["incrementDegradationCount"]);
	});

	it("calls a handler that logs recorded, through a plain or a member call", () => {
		expect(
			only("try { go(); } catch { logLatency({ type: 'phase' }); }").verdict,
		).toBe("recorded");
		expect(
			only("try { go(); } catch { this.logger.logCascade({}); }").verdict,
		).toBe("recorded");
	});

	it("calls a handler that rethrows on every path rethrows", () => {
		expect(only("try { go(); } catch (error) { throw error; }").verdict).toBe(
			"rethrows",
		);
	});

	it("calls a handler that rethrows on ONE path silent", () => {
		// The other branch swallows, so the handler is not judged by its throw.
		expect(
			only(
				"try { go(); } catch (error) { if (busy) throw error; return undefined; }",
			).verdict,
		).toBe("silent");
	});

	it("accepts a stated reason in a line comment", () => {
		expect(
			only(
				"try { go(); } catch {\n\t// none: idempotent teardown, a second release is a no-op\n}",
			).verdict,
		).toBe("declared-none");
	});

	it("accepts a stated reason in a block comment", () => {
		expect(
			only("try { go(); } catch { /* none: the probe answers absent */ }")
				.verdict,
		).toBe("declared-none");
	});

	it("refuses a `none:` marker that is only in a string", () => {
		expect(
			only('try { go(); } catch { void "// none: not a comment"; }').verdict,
		).toBe("silent");
	});

	it("refuses a record seam that is only in a comment", () => {
		expect(
			only("try { go(); } catch { /* logLatency({}) would go here */ }")
				.verdict,
		).toBe("silent");
	});

	it("does not credit a record seam that runs in a nested function", () => {
		// The nested arrow runs later, on its own invocation (and maybe never),
		// so it is not this handler's record of this failure.
		expect(
			only(
				"try { go(); } catch { queue.push(() => logLatency({ type: 'phase' })); }",
			).verdict,
		).toBe("silent");
	});

	it("reports the catch keyword's own line", () => {
		const site = only("try {\n\tgo();\n} catch {\n\tskip();\n}\n");
		expect(site.line).toBe(3);
	});
});

describe("promise-catch verdicts", () => {
	it("calls `.catch(() => {})` silent", () => {
		expect(only("go().catch(() => {});").verdict).toBe("silent");
	});

	it("calls `.catch(() => undefined)` silent", () => {
		expect(only("go().catch(() => undefined);").verdict).toBe("silent");
	});

	it("calls `.catch((e) => logCascade({…}))` recorded", () => {
		expect(
			only("go().catch((error) => logCascade({ reason: String(error) }));")
				.verdict,
		).toBe("recorded");
	});

	it("follows a same-file handler function to its own body", () => {
		expect(
			only("const swallow = () => {};\ngo().catch(swallow);").verdict,
		).toBe("silent");
		expect(
			only(
				"function recordIt(error) { logLatency({ type: 'phase', error }); }\ngo().catch(recordIt);",
			).verdict,
		).toBe("recorded");
	});

	it("calls a delegation to an import silent, so the author states why", () => {
		expect(only("go().catch(handleImported);").verdict).toBe("silent");
	});

	it("refuses a handler it cannot follow, instead of passing it", () => {
		const site = only("go().catch(new Handler());");
		expect(site.verdict).toBe("unclassified");
		expect(site.problem).toContain("new Handler()");
	});

	it("refuses a `.catch()` with no handler at all", () => {
		const site = only("go().catch();");
		expect(site.verdict).toBe("unclassified");
		expect(site.problem).toContain("no handler");
	});

	it("reports the `.catch` property's line, not the chain's start", () => {
		const site = only("go()\n\t.then(use)\n\t.catch(() => {});");
		expect(site.line).toBe(3);
	});
});

/**
 * Three spellings the detector was not designed for (AGENTS.md shape 69).
 * Each reaches a real record seam without calling it by name, and each is
 * REFUSED — the site stays `silent` and asks for a direct seam call or a
 * `none:` line. That is the fail-closed direction: a detector that guessed
 * "this identifier must be the seam" would pass every one of them.
 */
describe("spellings the detector was not designed for", () => {
	it("refuses a seam reached through an alias", () => {
		expect(
			only(
				"const rec = recordDegradationOnce;\ntry { go(); } catch { rec({ kind: 'x' }); }",
			).verdict,
		).toBe("silent");
	});

	it("refuses a seam reached through Reflect.apply", () => {
		expect(
			only(
				"try { go(); } catch { Reflect.apply(logLatency, null, [{ type: 'phase' }]); }",
			).verdict,
		).toBe("silent");
	});

	it("refuses a seam reached through a member binding", () => {
		expect(
			only(
				"const seam = sinks.logLatency;\ntry { go(); } catch { seam({ type: 'phase' }); }",
			).verdict,
		).toBe("silent");
	});
});

/**
 * #4603 review F1: a verdict is "every path through the handler", never "some
 * path". Each case below is a handler that swallows on the path the failure
 * actually takes while carrying a record seam or a `throw` on another path.
 */
describe("a handler is judged on every path, not on one", () => {
	it("refuses a record seam behind a condition", () => {
		expect(
			only(
				"try { go(); } catch (error) { if (DEBUG) logLatency({ type: 'phase', error }); }",
			).verdict,
		).toBe("silent");
	});

	it("refuses a record seam behind a short circuit", () => {
		expect(
			only(
				"try { go(); } catch (error) { DEBUG && logLatency({ type: 'phase', error }); }",
			).verdict,
		).toBe("silent");
	});

	it("refuses a record seam inside a nested try", () => {
		expect(
			only("try { go(); } catch (error) { try { logLatency({}); } finally {} }")
				.verdict,
		).toBe("silent");
	});

	it("refuses a record seam after the handler already returned", () => {
		expect(
			only(
				"try { go(); } catch (error) { if (done) return; logLatency({ type: 'phase' }); }",
			).verdict,
		).toBe("silent");
	});

	it("accepts a record seam that runs before a conditional return", () => {
		expect(
			only(
				"try { go(); } catch (error) { logLatency({ type: 'phase' }); if (done) return; }",
			).verdict,
		).toBe("recorded");
	});

	it("refuses a throw behind a condition", () => {
		expect(
			only("try { go(); } catch (error) { if (fatal) throw error; }").verdict,
		).toBe("silent");
	});

	it("refuses a throw in one branch of if/else", () => {
		expect(
			only(
				"try { go(); } catch (error) { if (fatal) { throw error; } else { return; } }",
			).verdict,
		).toBe("silent");
	});

	it("refuses a throw inside a nested try that can swallow it", () => {
		expect(
			only("try { go(); } catch (error) { try { throw error; } finally {} }")
				.verdict,
		).toBe("silent");
	});

	it("accepts a throw that runs on every path", () => {
		expect(
			only("try { go(); } catch (error) { cleanup(); throw error; }").verdict,
		).toBe("rethrows");
	});
});

describe("a handler name resolves in the scope that declares it", () => {
	it("judges the inner declaration, not an outer name it shadows", () => {
		// The outer handler records; the inner one swallows. A name-only index
		// read the outer function and called this site recorded.
		const sites = scanSilentCatches(
			[
				"function handler(error) { logLatency({ type: 'phase', error }); }",
				"function outer() {",
				"\tfunction handler() {}",
				"\tgo().catch(handler);",
				"}",
			].join("\n"),
		);
		expect(sites).toHaveLength(1);
		expect(sites[0]?.verdict).toBe("silent");
	});

	it("judges the inner declaration carried by a var declarator", () => {
		const sites = scanSilentCatches(
			[
				"function outer() {",
				"\tconst handler = () => {};",
				"\tgo().catch(handler);",
				"}",
				"const handler = (error) => logLatency({ error });",
			].join("\n"),
		);
		expect(sites.map((site) => site.verdict)).toEqual(["silent"]);
	});

	it("refuses a name declared twice in one scope", () => {
		const site = only(
			"var handler = () => {};\nvar handler = () => { throw new Error('x'); };\ngo().catch(handler);",
		);
		expect(site.verdict).toBe("unclassified");
		expect(site.problem).toContain("more than once");
	});
});

describe("every spelling of a rejection handler is a site", () => {
	it("reads a quoted subscript as a catch handler", () => {
		expect(only('go()["catch"](() => {});').verdict).toBe("silent");
	});

	it("reads a literal template subscript as a catch handler", () => {
		expect(only("go()[`catch`](() => {});").verdict).toBe("silent");
	});

	it("resolves a subscript key bound to a string constant", () => {
		expect(
			only("const method = 'catch';\ngo()[method](() => {});").verdict,
		).toBe("silent");
	});

	it("refuses a computed subscript key it cannot resolve", () => {
		const site = only("go()[`${prefix}atch`](() => {});");
		expect(site.verdict).toBe("unclassified");
		expect(site.problem).toContain("computed");
	});

	it("refuses a concatenated subscript key", () => {
		const site = only('go()["ca" + "tch"](() => {});');
		expect(site.verdict).toBe("unclassified");
		expect(site.problem).toContain("concatenated");
	});

	it("does not read a variable index as a handler spelling", () => {
		// `arr[i]()` is not evidence of a rejection handler; treating every
		// indexed call as one would fail closed on the whole tree.
		expect(scanSilentCatches("function run(arr, i) { arr[i](); }")).toEqual([]);
	});

	it("reads the second argument of `.then` as the rejection handler", () => {
		const site = only("go().then(use, () => {});");
		expect(site.form).toBe("promise-then");
		expect(site.verdict).toBe("silent");
		expect(
			only("go().then(use, (error) => logCascade({ error }));").verdict,
		).toBe("recorded");
	});

	it("does not read `.then` with one argument as a handler", () => {
		expect(scanSilentCatches("go().then(use);")).toEqual([]);
	});

	it("does not read `.then(ok, undefined)` as a swallowing handler", () => {
		// A rejection passes to the next link, so nothing is swallowed here.
		expect(scanSilentCatches("go().then(use, undefined);")).toEqual([]);
	});

	it("reads the subscript spelling of `.then`", () => {
		expect(only('go()["then"](use, () => {});').form).toBe("promise-then");
	});
});

describe("a site's identity", () => {
	it("distinguishes two different handlers in one file", () => {
		const sites = scanSilentCatches(
			"go().catch(() => {});\ngo().catch((error) => { void error; });",
		);
		expect(new Set(sites.map((site) => site.identity)).size).toBe(2);
	});

	it("gives two identical handlers two identities, never one", () => {
		const sites = scanSilentCatches(
			"go().catch(() => {});\ngo().catch(() => {});",
		);
		expect(sites[0]?.identity).toBe(sites[1]?.identity);
		expect(sites).toHaveLength(2);
	});
});
