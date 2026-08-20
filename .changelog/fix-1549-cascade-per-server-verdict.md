---
section: Fixed
---

- **A workspace sweep no longer speaks for a scanner that missed its deadline (refs [#1549](https://github.com/apmantza/pi-lens/issues/1549))** —
  when an auxiliary scanner misses the sweep deadline, the result now names the
  uncovered lanes instead of reporting the file as fully answered. A partially
  covered snapshot is never cached and never reconciled into the widget, so a
  later read re-asks the scanner that stayed silent.
