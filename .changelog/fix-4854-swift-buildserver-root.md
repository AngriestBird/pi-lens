---
section: Fixed
audience: user
---

- **Swift roots at buildServer.json for Xcode projects (closes #4854)** — An Xcode project with no `Package.swift`, set up for sourcekit-lsp by xcode-build-server, now roots SourceKit-LSP at the `buildServer.json` directory. Before, the server started in each file's own directory, never read the build settings, and reported `Cannot find 'X' in scope` for every type from a sibling file.
