import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHANGELOG_SECTIONS = ["Added", "Changed", "Removed", "Fixed"];

function fail(file, message) {
  throw new Error(`Invalid changelog entry ${file}: ${message}`);
}

export function parseEntry(text, file = "entry") {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") fail(file, "expected YAML front matter");
  const end = lines.indexOf("---", 1);
  if (end < 0) fail(file, "front matter is not closed");
  const marker = lines.slice(1, end).find((line) => /^section:\s*\S+\s*$/.test(line));
  if (!marker) fail(file, "missing section marker");
  const section = marker.replace(/^section:\s*/, "");
  if (!CHANGELOG_SECTIONS.includes(section)) {
    fail(file, `section must be one of ${CHANGELOG_SECTIONS.join(", ")}`);
  }
  const bullets = lines.slice(end + 1).filter((line) => /^-\s+/.test(line));
  if (bullets.length !== 1) fail(file, `expected exactly one '- ' entry line, found ${bullets.length}`);
  if (!/^[-*]\s+\*\*.+\*\*\s+—\s+.+/.test(bullets[0])) {
    fail(file, "entry must use '- **Title** — body' house style");
  }
  const body = lines.slice(end + 1).join("\n").trim();
  if ((body.match(/```/g) ?? []).length % 2 !== 0) fail(file, "unclosed Markdown code fence");
  return { section, entry: bullets[0] };
}

function readEntries(entriesDir) {
  if (!fs.existsSync(entriesDir)) return [];
  return fs.readdirSync(entriesDir, { withFileTypes: true })
    .filter(({ isFile, name }) => isFile() && name.endsWith(".md") && name !== "README.md")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name }) => {
      const file = path.join(entriesDir, name);
      return { file, ...parseEntry(fs.readFileSync(file, "utf8"), name) };
    });
}

export function rollupChangelog(version, { rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version "${version}"; expected X.Y.Z`);
  const changelogPath = path.join(rootDir, "CHANGELOG.md");
  const entriesDir = path.join(rootDir, ".changelog");
  const entries = readEntries(entriesDir);
  if (entries.length === 0) return { version, files: [], changelogPath };
  const changelog = fs.readFileSync(changelogPath, "utf8");
  const heading = `## [${version}]`;
  if (changelog.includes(heading)) throw new Error(`CHANGELOG already has a section for ${version}`);
  const unreleased = changelog.match(/^## \[Unreleased\].*$/m);
  if (!unreleased) throw new Error("CHANGELOG is missing the [Unreleased] heading");
  const grouped = CHANGELOG_SECTIONS.map((section) => {
    const lines = entries.filter((entry) => entry.section === section).map((entry) => entry.entry);
    return lines.length ? `### ${section}\n\n${lines.join("\n\n")}` : "";
  }).filter(Boolean).join("\n\n");
  const date = new Date().toISOString().slice(0, 10);
  const start = unreleased.index;
  const next = `${changelog.slice(0, start)}## [${version}] - ${date}\n\n${grouped}\n\n${changelog.slice(start)}`;
  fs.writeFileSync(changelogPath, next, "utf8");
  for (const entry of entries) fs.unlinkSync(entry.file);
  return { version, files: entries.map(({ file }) => file), changelogPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: node scripts/rollup-changelog.mjs <version>");
    process.exitCode = 1;
  } else {
    try {
      const result = rollupChangelog(version);
      console.log(`Rolled up ${result.files.length} changelog entr${result.files.length === 1 ? "y" : "ies"} for ${version}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
