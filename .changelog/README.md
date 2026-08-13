# Per-entry changelog files

Each user-facing change gets one Markdown file in this directory. The file name
must be `<branch-or-slug>-<short-desc>.md`, for example
`feat-1321-changelog-entries.md`.

Use YAML front matter to select one Keep a Changelog section, followed by one
entry in the repository's existing style:

```markdown
---
section: Fixed
---

- **Short title (closes #1321)** — Explain the user-visible change.
```

`section` must be `Added`, `Changed`, `Removed`, or `Fixed`. Each file must
contain exactly one `- ` entry line and must describe one Unreleased change.
The release workflow rolls these files into `CHANGELOG.md` under the version
being released, then removes the entry files while retaining this README.
