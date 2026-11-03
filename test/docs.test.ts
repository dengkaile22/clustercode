/**
 * Documentation invariants.
 *
 * The original project has a documented incident where an assertion count was written
 * by hand, drifted from reality, and nobody noticed for weeks. Docs drift fastest when
 * the same number appears in six languages, so: every doc must state a count, and all
 * of them must agree. The authoritative number is the `npm run test` output; this test
 * keeps the translations honest with each other.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

const DOCS = [
  "README.md",
  "CHANGELOG.md",
  "docs/development.md",
  "docs/README.zh-CN.md",
  "docs/README.fr.md",
  "docs/README.ja.md",
  "docs/README.es.md",
  "docs/README.pt-BR.md",
];

/** "170 test assertions", "170 项断言", "170 個のアサーション", "170 aserciones", "170 asserções". */
const COUNT = /(\d+)\s*(?:test assertions|assertions|项断言|個のアサーション|aserciones|asserções)/;

describe("docs", () => {
  it("every doc states the assertion count", () => {
    for (const file of DOCS) {
      assert.match(read(file), COUNT, `${file} must state the assertion count`);
    }
  });

  it("all docs agree on the same count", () => {
    const counts = DOCS.map((file) => {
      const match = read(file).match(COUNT);
      assert.ok(match, `${file} is missing the count`);
      return { file, value: Number(match[1]) };
    });
    const unique = new Set(counts.map((entry) => entry.value));
    assert.equal(
      unique.size,
      1,
      `docs disagree: ${counts.map((entry) => `${entry.file}=${entry.value}`).join(", ")}`,
    );
  });

  it("the language switchers list all six translations", () => {
    const files = ["README.md", ...DOCS.filter((file) => file.startsWith("docs/README."))];
    for (const file of files) {
      const text = read(file);
      for (const target of ["README.zh-CN.md", "README.fr.md", "README.ja.md", "README.es.md", "README.pt-BR.md"]) {
        assert.ok(text.includes(target), `${file} switcher is missing ${target}`);
      }
    }
  });

  it("every relative link in the READMEs points at a real file", () => {
    const files = ["README.md", ...DOCS.filter((file) => file.startsWith("docs/README."))];
    for (const file of files) {
      const text = read(file);
      const links = [...text.matchAll(/\]\(([^)#]+?)\)/g)]
        .map((match) => match[1])
        .filter((href) => !/^(https?:|mailto:)/.test(href));
      for (const href of links) {
        const target = resolve(dirname(resolve(root, file)), href);
        assert.doesNotThrow(() => readFileSync(target), `${file} links to missing ${href}`);
      }
    }
  });
});
