import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import { whitelist as compilerWhitelist } from "../whitelist.ts";

const forbiddenFacade =
  /(?:ExperimentalCycles|ExperimentalInternetComputer|ExperimentalStableMemory|CertifiedData|Cycles|InternetComputer|Region|StableMemory|Timer)\.mo$/;

test("compiler and packager use the same reviewed facade whitelist", async () => {
  const [compilerSource, packagerSource] = await Promise.all([
    fs.readFile(new URL("../whitelist.ts", import.meta.url), "utf8"),
    fs.readFile(
      new URL("../../neutron-scripts/whitelist.ts", import.meta.url),
      "utf8",
    ),
  ]);
  expect(compilerSource).toBe(packagerSource);
});

test("whitelist contains only the pinned Core Principal and Runtime facades", () => {
  expect(Object.keys(compilerWhitelist)).toHaveLength(2);
  for (const [hash, entry] of Object.entries(compilerWhitelist)) {
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.path).toMatch(
      /^\.mops\/_github\/core#v2\.6\.0\/src\/(?:Principal|Runtime)\.mo$/,
    );
    expect(entry.path).not.toMatch(forbiddenFacade);
    expect(entry.path).not.toContain("/base@");
    expect(entry.path).not.toMatch(/\/Random\.mo$/);

    const basename = entry.path.split("/").at(-1);
    const codes = new Set(entry.text.map(({ code }) => code));
    expect(codes).toEqual(new Set(entry.ast));
    if (basename === "Runtime.mo") {
      expect(entry.ast).toEqual(["systemCapability", "systemEnvironment"]);
    } else {
      expect(entry.ast).toContain("actor");
      expect(
        entry.ast.every((finding) =>
          ["actor", "actorOfPrincipal", "toActor"].includes(finding),
        ),
      ).toBe(true);
    }
  }
});

test("the current core Principal exception records its actor conversion surface", () => {
  const currentCorePrincipal = Object.values(compilerWhitelist).find((entry) =>
    entry.path.includes("core#v2.6.0/src/Principal.mo"),
  );
  expect(currentCorePrincipal?.ast).toEqual([
    "actor",
    "actorOfPrincipal",
  ]);
});
