---
section: Fixed
audience: user
---

- **Python docstrings now show in the module outline and `read_symbol` (#4948)** — a Python def or class documented by a docstring carried no description, because only a `#` comment above it was read. The first sentence of the docstring (`"""`, `'''`, `r"""`, `u"""` or a one-line string) is now its description, capped at 120 characters. A `#` comment above the def still works, and the docstring wins when both exist. `read_symbol` still starts at the `def` line.
