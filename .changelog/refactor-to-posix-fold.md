---
section: Changed
audience: internal
---

- 37 production sites that hand-rolled the backslash-to-slash fold (`.replace(/\\/g, "/")`) now call `toPosix` from `clients/path-utils.ts`, and one fold that was a no-op (`detectFileRole`'s second fold) is deleted. Behaviour is unchanged; `tests/clients/to-posix-fold-sites.test.ts` drives 12 of the former sites through their exported callers. (refs #4907)
