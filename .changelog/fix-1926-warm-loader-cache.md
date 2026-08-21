---
section: Fixed
---

- **Updating pi-lens no longer costs a five-second first session (refs #1926)** — pi loads the extension through jiti, which transforms the ~4MB `dist/index.js` bundle and caches the result. Every `git:` install or update produced a new bundle, so the next interactive session paid that transform: 4847ms of `module import`, against a 138ms steady state. The `prepare` chain now runs the transform itself, in `scripts/warm-loader-cache.mjs`, writing the same cache entry pi reads. The first session after an update is warm. The step runs last, is best-effort, and never fails an install; set `PI_LENS_SKIP_WARM_CACHE` to skip it. Each run appends one line to `~/.pi-lens/install.log`.
