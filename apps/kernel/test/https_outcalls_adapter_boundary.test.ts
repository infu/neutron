import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../backend/https_outcalls/Adapter.mo", import.meta.url),
  "utf8",
);

test("app HTTPS outcalls always use one non-replicated request", () => {
  expect(source.match(/\bIC\.management\.http_request\s*\(/gu)).toHaveLength(1);
  expect(source.match(/\bis_replicated\s*=/gu)).toHaveLength(1);
  expect(source).toMatch(
    /IC\.management\.http_request\s*\(\s*\{[\s\S]*?\bis_replicated\s*=\s*\?false\s*;/u,
  );
  expect(source).not.toMatch(/\bis_replicated\s*=\s*\?true\b/u);
});
