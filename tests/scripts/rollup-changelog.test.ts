import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEntry, rollupChangelog } from "../../scripts/rollup-changelog.mjs";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-changelog-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, ".changelog"));
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- old\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- prior\n");
  return root;
}

describe("per-entry changelog rollup", () => {
  it("groups entries, preserves Unreleased, and deletes entry files", () => {
    const root = fixtureRoot();
    fs.writeFileSync(path.join(root, ".changelog", "b.md"), "---\nsection: Fixed\n---\n\n- **B** — fixed\n");
    fs.writeFileSync(path.join(root, ".changelog", "a.md"), "---\nsection: Added\n---\n\n- **A** — added\n");
    rollupChangelog("2.0.0", { rootDir: root });
    const output = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(output).toContain("## [2.0.0] - ");
    expect(output).toContain("### Added\n\n- **A** — added");
    expect(output).toContain("### Fixed\n\n- **B** — fixed");
    expect(output).toContain("## [Unreleased]");
    expect(fs.readdirSync(path.join(root, ".changelog"))).toEqual([]);
  });

  it("reports malformed entries clearly without changing the changelog", () => {
    const root = fixtureRoot();
    fs.writeFileSync(path.join(root, ".changelog", "bad.md"), "---\nsection: Nope\n---\n\n- bad\n");
    expect(() => rollupChangelog("2.0.0", { rootDir: root })).toThrow(/bad\.md: section must be/);
    expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).not.toContain("2.0.0");
  });

  it("parses the selected front-matter section", () => {
    expect(parseEntry("---\nsection: Changed\n---\n\n- **Title** — body")).toEqual({ section: "Changed", entry: "- **Title** — body" });
  });
});
