import { beforeAll, describe, expect, it } from "vitest";
import * as TS from "web-tree-sitter";
import { LANGUAGE_TO_GRAMMAR } from "../../clients/grammar-source.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";

const Parser = TS.Parser ?? TS.default ?? TS;
const Language = TS.Language ?? Parser.Language;
const Query = TS.Query;
const cases = [
  ["infinite-loop-java", "java", "class C { void f() { while (true) {} for (;;) {} } }", "class C { void f(boolean b) { while (b) {} } }"],
  ["no-double-checked-locking", "java", "class C { void f() { if (x == null) { synchronized (x) { if (x == null) {} } } } }", "class C { void f() { if (x == null) { synchronized (x) { work(); } } } }"],
  ["no-field-shadowing", "java", "class Child extends Parent { int value; }", "class Child { int value; }"],
  ["switch-fall-through", "java", "class C { void f(int x) { switch (x) { case 1: work(); case 2: break; } } }", "class C { void f(int x) { switch (x) { case 1: work(); break; } } }"],
  ["switch-non-case-labels", "java", "class C { void f(int x) { switch (x) { case 1: label: work(); } } }", "class C { void f(int x) { switch (x) { case 1: work(); } } }"],
  ["no-scoped-lock-without-args", "cpp", "void f() { std::scoped_lock lock; }", "void f(std::mutex& m) { std::scoped_lock lock(m); }"],
  ["calc-spacing", "css", "a { width: calc(100%-20px); }", "a { width: calc(100% - 20px); }"],
  ["this-in-static-context", "php", "<?php class C { public static function f() { return $this->x; } }", "<?php class C { public function f() { return $this->x; } }"],
] as const;

const loader = new TreeSitterQueryLoader();
const languages = new Map<string, any>();
const queries = new Map<string, any>();

beforeAll(async () => {
  await Parser.init();
  const loaded = await loader.loadQueries(process.cwd());
  for (const [id, language, positive, negative] of cases) {
    if (!languages.has(language)) {
      languages.set(language, await Language.load(`grammars/${LANGUAGE_TO_GRAMMAR[language]}`));
    }
    const rule = loaded.get(language)?.find((q) => q.id === id);
    if (!rule) throw new Error(`Missing query ${id}`);
    queries.set(id, new Query(languages.get(language), rule.query));
  }
});

function matches(id: string, language: string, source: string): number {
  const parser = new Parser();
  parser.setLanguage(languages.get(language));
  return queries.get(id).matches(parser.parse(source).rootNode).length;
}

describe("issue #884 tree-sitter queries", () => {
  for (const [id, language, positive, negative] of cases) {
    it(`${id} compiles and distinguishes representative code`, () => {
      expect(matches(id, language, positive)).toBeGreaterThan(0);
      expect(matches(id, language, negative)).toBe(0);
    });
  }
});
