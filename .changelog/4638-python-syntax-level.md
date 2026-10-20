---
section: Fixed
audience: user
---

- **Python 3.14 projects no longer see spurious syntax errors, and ruff fixes agree (closes #4638)** — jedi compiles with the interpreter it launched, so a PEP 758 unparenthesized `except` in a project declaring Python 3.14 surfaced a `compile` `SyntaxError` that the rest of the toolchain accepted. pi-lens now reads the declared syntax level from the project — ruff `target-version`, pyright `pythonVersion`, `requires-python`, then `.python-version` — and drops jedi's `compile` findings once that level is 3.14 or newer, recording the drop once per session with the declared level and the file that declared it. jedi and pyright also launch from the project's own interpreter (a uv workspace `.venv`, the project's `.venv`/`venv`, or an ambient `VIRTUAL_ENV`/`CONDA_PREFIX`/`UV_PROJECT_ENVIRONMENT`) before the managed install and `PATH`. ruff's fix pre-check no longer pins `py310`, so it parses exactly like `--fix` and the lint run under the project's own `target-version`.
