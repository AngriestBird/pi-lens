# Tool-smoke fixture for #3405 — the seeded compile error Expert must publish.
# It sits under lib/ (Mix's default elixirc_paths): a file outside lib/ is never
# compiled, so Expert has nothing to report for it.
defmodule Smoke do
  def greet do
    undefined_function()
  end
end
