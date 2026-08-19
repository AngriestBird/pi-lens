# Language Coverage

pi-lens supports **36+ languages** through dispatch runners and LSP integration.

Formatting uses a single selected formatter per file: explicit project config wins, otherwise pi-lens uses a smart default where supported, and config-first ecosystems do not autoformat without config.

Dispatch is diagnostics-oriented: automatic formatting and safe autofix happen in the post-write pipeline rather than through dispatch format-check runners.

| Language              | LSP | Dispatch Runners                                                                                               | Formatter               |
| --------------------- | --- | -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| JavaScript/TypeScript | ✓   | lsp, ts-lsp, biome-check-json, tree-sitter, ast-grep-napi, type-safety, similarity, fact-rules, eslint, oxlint | biome, prettier         |
| Python                | ✓   | lsp, pyright, mypy (config-first), ruff-lint, tree-sitter                                                      | ruff, black             |
| Go                    | ✓   | lsp, go-vet, golangci-lint, tree-sitter                                                                        | gofmt                   |
| Rust                  | ✓   | lsp, rust-clippy, tree-sitter                                                                                  | rustfmt                 |
| Ruby                  | ✓   | lsp, rubocop, tree-sitter                                                                                      | rubocop, standardrb     |
| C/C++                 | ✓   | lsp, cpp-check, tree-sitter                                                                                    | clang-format            |
| Shell                 | ✓   | lsp, shellcheck                                                                                                | shfmt                   |
| Fish                  | ✓ (fish-lsp) | lsp, fish-indent                                                                                      | fish_indent             |
| CSS/SCSS/Less         | ✓   | lsp, stylelint                                                                                                 | biome, prettier         |
| HTML                  | ✓   | lsp, htmlhint                                                                                                  | prettier                |
| YAML                  | ✓   | lsp, yamllint, actionlint (GitHub workflows)                                                                   | prettier                |
| JSON                  | ✓   | lsp                                                                                                            | biome, prettier         |
| Svelte                | ✓   | lsp                                                                                                            | oxfmt (needs `svelte` pkg installed + config `svelte: true`) |
| Vue                   | ✓   | lsp                                                                                                            | prettier, oxfmt         |
| SQL                   | —   | sqlfluff                                                                                                       | sqlfluff                |
| Markdown              | —   | spellcheck, markdownlint, vale                                                                                 | prettier                |
| Docker                | ✓   | lsp, hadolint                                                                                                  | —                       |
| PHP                   | ✓   | lsp, php-lint, phpstan                                                                                         | php-cs-fixer            |
| PowerShell            | ✓   | lsp, psscriptanalyzer                                                                                          | psscriptanalyzer-format |
| Prisma                | ✓   | lsp, prisma-validate                                                                                           | —                       |
| C#                    | ✓   | lsp, dotnet-build                                                                                              | csharpier               |
| F#                    | ✓   | lsp                                                                                                            | fantomas                |
| Java                  | ✓   | lsp, javac                                                                                                     | google-java-format      |
| Java + Lombok         | ✓   | JDT LS launched with `-javaagent:<lombok.jar>` when Lombok is detected and a jar is found (`PI_LENS_LOMBOK_JAR` / `LOMBOK_JAR`, project `.lombok/lombok.jar`, or Maven/Gradle cache) | google-java-format      |
| Kotlin                | ✓   | lsp, ktlint, detekt                                                                                            | ktlint                  |
| Swift                 | ✓   | lsp, swiftlint                                                                                                 | swiftformat             |
| Dart                  | ✓   | lsp, dart-analyze                                                                                              | dart format             |
| Lua                   | ✓   | lsp                                                                                                            | stylua                  |
| Zig                   | ✓   | lsp, zig-check                                                                                                 | zig fmt                 |
| Haskell               | ✓   | lsp                                                                                                            | ormolu                  |
| Elixir                | ✓ (ElixirLS default, Expert alternate) | lsp, elixir-check, credo                                                                   | mix format              |
| Gleam                 | ✓   | lsp, gleam-check                                                                                               | gleam format            |
| OCaml                 | ✓   | lsp                                                                                                            | ocamlformat             |
| Clojure               | ✓   | lsp                                                                                                            | cljfmt                  |
| Terraform             | ✓   | lsp, tflint, trivy-config (opt-in)                                                                             | terraform fmt           |
| Terragrunt            | —   | terragrunt                                                                                                     | terragrunt hcl fmt      |
| Nix                   | ✓   | lsp                                                                                                            | nixfmt                  |
| TOML                  | ✓   | lsp, taplo                                                                                                     | taplo                   |
| CMake                 | ✓ (cmake-language-server) | lsp                                                                                      | cmake-format            |
| CUE                   | ✓ (syntax via cue lsp, evaluation via cue vet) | lsp, cue-vet                                                              | cue fmt                 |

`cue lsp` reports load and parse errors as you type but leaves conflicting
values and failed constraints to `cue vet` — the `cue-vet` auxiliary runner
(#1522) covers that gap, so together they give full coverage: syntax/parse
diagnostics, hover, definition, completion, code actions, and formatting from
the language server, plus evaluation-error validation from `cue vet` on every
edit (vetted at the PACKAGE level — the touched file's directory — with the
result filtered back to that file, since CUE packages are directory-scoped).
`.cue` files parse under tree-sitter with symbol (`#Definition`s, fields,
`let` bindings) and import queries (#1522), giving CUE the same structural
symbol search and import extraction as any other language, with two known
rough edges inherited from the young `tree-sitter-cue` grammar itself (not
this repo's queries):

- **Multi-hash raw strings** (`` ##"..."## ``, two or more `#` delimiters)
  mis-parse regardless of content — the field's value becomes a bare
  `identifier` node instead of a `string`, and the parser emits stray
  top-level nodes outside the field entirely. Because the broken value node
  can carry `#`-prefixed text, this can surface as a spurious symbol
  reference in the extracted refs. Single-hash raw strings (`` #"..."# ``)
  are unaffected.
- **Aliased field labels** (`X=name: value`) emit the alias identifier (`X`)
  as its own spurious `property` symbol alongside the real field's correct
  symbol, because the grammar exposes both identifiers as untagged siblings
  under the same `label` node with no way to tell them apart structurally.

Both are upstream grammar limitations (tracked among
[eonpatapon/tree-sitter-cue](https://github.com/eonpatapon/tree-sitter-cue)'s
open issues), not something a query change here can fix.

## Considered and skipped (2026-08-20 survey)

Recorded so these are not re-litigated. Each was evaluated for adoption and rejected as a duplicate of an existing lane:

- **bandit** (Python SAST): ruff's `S` ruleset implements Bandit's checks, but pi-lens's bundled ruff config does not enable `S` today — a project opting into `S` gets the coverage; a default project does not. Tracked as a real gap, not a duplicate (see the ruff-S/IaC lane issue).
- **checkov** (IaC security): originally skipped on the belief that `trivy config` was wired; verification shows pi-lens runs `trivy fs --scanners vuln,secret,license` only, and tflint checks Terraform correctness, not misconfiguration. pi-lens has no IaC-misconfiguration lane today — tracked as a real gap.
- **radon / lizard** (complexity): ruff's `C90` (mccabe) covers the capability but is not enabled in the bundled config either; treated as a config decision, not a new runner.

Known coverage holes with no tool currently clearing the adoption bar: Rust and Java dead-code detection, Ruby type checking (sorbet judged too heavy and idiosyncratic for a default lane).
