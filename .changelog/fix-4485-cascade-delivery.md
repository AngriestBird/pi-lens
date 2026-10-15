---
section: Fixed
audience: user
---

- **Cascade checks report broken importers on every turn, not once or never (refs #4485, #4486, #4487)** — After an edit, the impact cascade often said nothing about the files that import the edited one. Classic TypeScript neighbours were sent to a background check that usually never finished, so the run read as clean. A snapshot published before the edit could stand in for the neighbour after it. An error shown once was hidden on later runs. Now classic TypeScript neighbours are answered in the same turn. Other servers that only publish when something changes get a 1 s wait. A neighbour that gets no answer is listed as unconfirmed instead of clean. Only diagnostics published after the edit are used. A persistent neighbour error is listed every turn and marked "still present since turn N". An error shown in an earlier turn and not checked since stays on a short "still unresolved" line until a check or an edit shows it gone. Neighbour errors stay advisory and never block a commit.
