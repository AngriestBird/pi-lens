// The one reading of an `LSPService.touchFile` result for the LSP scripts
// (smoke-tools, bench-lsp, the clean-signal probe, the idle-eviction probe).

/**
 * The diagnostics a touch collected, or `undefined` when no language server
 * answered ("no client ready").
 *
 * `touchFile` returns a `{ diags, inconclusive?, ... }` wrapper since #1179;
 * a script that still tested `Array.isArray(result)` read every touch as
 * unanswered (bench-lsp reported each server unavailable) or counted none of
 * its diagnostics (the clean-signal probe's `dirtyDiags`).
 *
 * #4403 (PR #4411): a touch that acquires no language server returns
 * `undefined` only while nothing is disabled. With a primary off in
 * `lsp.disabledServers`, which every smoke alternate row writes for its
 * default, it returns the `primary-unavailable` verdict with no diagnostics
 * instead. Read as an answer, that turned the official Docker smoke row on a
 * runner without the binary from "unavailable" into "no warm client". A touch
 * that asked for auxiliaries (`auxiliary: true`) keeps its findings: an
 * auxiliary answers without a primary, and its row asserts its own source.
 */
export function touchAnsweredDiagnostics(touched, { auxiliary = false } = {}) {
	if (touched === undefined || Array.isArray(touched)) return touched;
	if (!auxiliary && touched.inconclusiveReason === "primary-unavailable")
		return undefined;
	return touched.diags;
}
