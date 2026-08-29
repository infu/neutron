import { expect, test } from "bun:test";
import {
  contentAddressedMotokoImports,
  parseMotokoImports,
} from "../src/motoko_imports.ts";

test("parses packaged imports without allowing prototype aliases to disappear", () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const imports = parseMotokoImports(`
import __proto__ "${first}";
import constructor "${second}";
`);

  expect(Object.getPrototypeOf(imports)).toBe(Object.prototype);
  expect(Object.hasOwn(imports, "__proto__")).toBe(true);
  expect(Object.hasOwn(imports, "constructor")).toBe(true);
  expect(imports.__proto__).toBe(first);
  expect(Object.getOwnPropertyDescriptor(imports, "constructor")?.value).toBe(
    second,
  );
  expect(Object.values(imports)).toEqual([first, second]);
  expect(
    contentAddressedMotokoImports(`
import __proto__ "${first}";
import constructor "${second}";
`),
  ).toEqual([first, second]);
});

test("returns sorted unique content-addressed imports and skips compiler imports", () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  expect(
    contentAddressedMotokoImports(`
import Prim "mo:prim";
import Second "${second}";
import Duplicate "${second}";
import First "${first}";
import Blocked "mo:⛔";
`),
  ).toEqual([first, second]);
});

test("does not copy an oversized unsupported import into its error", () => {
  const unsupported = `mo:package/${"x".repeat(128 * 1024)}`;
  let thrown: unknown;
  try {
    contentAddressedMotokoImports(`import Huge "${unsupported}";`);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toBe(
    "Installed Motoko module has an unsupported non-content-addressed import",
  );
  expect(message.length).toBeLessThan(128);
  expect(message).not.toContain(unsupported);
});

test("bounds distinct content-addressed imports while allowing duplicates", () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  expect(
    contentAddressedMotokoImports(
      `import A "${first}";\nimport Again "${first}";`,
      1,
    ),
  ).toEqual([first]);
  expect(() =>
    contentAddressedMotokoImports(
      `import A "${first}";\nimport B "${second}";`,
      1,
    ),
  ).toThrow("too many imports");
});

test("parses imports one line at a time", () => {
  const hash = "a".repeat(64);
  expect(
    contentAddressedMotokoImports(
      `${"\n".repeat(10_000)}import Split\n "${hash}";`,
      1,
    ),
  ).toEqual([]);
  expect(
    contentAddressedMotokoImports(`\n\n  import SameLine "${hash}";`, 1),
  ).toEqual([hash]);
});
