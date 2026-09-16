---
section: Fixed
---

- **Retry the mem-watch write-failure note through the same channel that retries every other line, with a bound of its own (closes #3110, closes #3115)** — `noteWriteFailureOnce` used to write its once-only stderr note with a raw, un-retried `fs.writeSync` in a bare catch, so a stdout that had died (EPIPE) alongside a stderr that was merely full (EAGAIN, a slow reader) dropped the note for good; it now goes through the wrapper's own retrying `emit()`, capped at 400ms for the note only (the verdict line keeps its unbounded retry) so a stderr that never drains at all degrades the note instead of hanging the wrapper and losing the wrapped command's exit code entirely. `tests/scripts/with-memory-watch.test.ts`'s `runWrapper` helper also pins `PI_LENS_MEM_WATCH_SAMPLE_FILE` to a scratch path by default, so the file's cases stop leaking the wrapper's shared `pi-lens-mem-watch-samples.log` fallback into TMPDIR and redding `tmp-fixture-hygiene` in a shared batch.
