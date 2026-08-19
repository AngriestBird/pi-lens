---
section: Fixed
---

- **The retained-winner arm no longer re-serves an ast-grep command this same sweep just proved gone** — both the shared `isSgAvailableAsync` sweep and `SgRunner.ensureAvailable()` retain a provisional winner across a stalled sibling tier, but neither checked whether the memoized winner itself was among the candidates that ENOENTed in that same pass. A previous provisional winner (say `npx`) that goes durably missing while an unrelated tier merely stalls used to still answer available with the dead command; the sweep now tracks which candidates it proved durably absent and skips the retained arm when the memoized command is one of them, falling through to the genuine-absence path instead (#1593).
