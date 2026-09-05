import { expect, test } from "bun:test";
import { loadMotoko } from "../src/index.ts";

test("compact Motoko inspection returns raw imports and security syntax facts", async () => {
  const mo = await loadMotoko();
  const inspection = await mo.inspectMotoko(
    "inspect.mo",
    `import Prim "mo:prim";
     import Used "used";
     module {
       public func inspect(target : Text) : actor {} {
         Prim.cyclesAdd(1);
         actor (target)
       };
     }`,
  );

  expect(inspection).toEqual({
    immediateImports: ["mo:prim", "used"],
    hasActorUrl: true,
    dotMembers: ["cyclesAdd"],
    patternFields: [],
  });
  expect("rawExp" in inspection).toBe(false);
  expect("ast" in inspection).toBe(false);
});

test.each([
  [
    'import { cyclesAdd = renamed; type cyclesBalance } "mo:prim";',
    ["cyclesAdd"],
  ],
  [
    "let { cyclesAdd = renamed; outer = ?(#yes { call_raw = nested }) } = source;",
    ["cyclesAdd", "outer", "call_raw"],
  ],
  ["let ?{ cyclesAdd = renamed } = source else { return };", ["cyclesAdd"]],
  ["func f({ cyclesAdd = renamed }) {};", ["cyclesAdd"]],
  [
    "shared ({ cyclesAdd = renamed }) func f({ call_raw = other }) : async () {};",
    ["cyclesAdd", "call_raw"],
  ],
  [
    "shared query ({ cyclesAdd = renamed }) func f({ call_raw = other }) : async () {};",
    ["cyclesAdd", "call_raw"],
  ],
  [
    "shared composite query ({ cyclesAdd = renamed }) func f({ call_raw = other }) : async () {};",
    ["cyclesAdd", "call_raw"],
  ],
  [
    "shared ({ cyclesAdd = renamed }) actor class C({ call_raw = other }) {};",
    ["cyclesAdd", "call_raw"],
  ],
  ["mixin ({ cyclesAdd = renamed }) {};", ["cyclesAdd"]],
  ["mixin <system> ({ cyclesAdd = renamed }) {};", ["cyclesAdd"]],
  ["for ({ cyclesAdd = renamed } in values) {};", ["cyclesAdd"]],
  [
    "switch value { case (({ cyclesAdd = a } and whole) or ({ call_raw = a } and whole)) {} };",
    ["cyclesAdd", "call_raw"],
  ],
  ["try {} catch ({ cyclesAdd = renamed }) {};", ["cyclesAdd"]],
  ["let { type cyclesAdd } = source;", []],
  [
    "let { type cyclesAdd; cyclesBalance : Nat = renamed } = source;",
    ["cyclesBalance"],
  ],
] as const)("compact inspection preserves pattern fields in %s", async (source, fields) => {
  const mo = await loadMotoko();
  const inspection = await mo.inspectMotoko("patterns.mo", source);
  expect(inspection.patternFields).toEqual([...fields]);
  expect(inspection.dotMembers).toEqual([]);
});

test("compact inspection deduplicates acquisitions without deduplicating raw imports", async () => {
  const mo = await loadMotoko();
  const inspection = await mo.inspectMotoko(
    "imports.mo",
    `import { cyclesAdd = first } "mo:prim";
     import { cyclesAdd = second } "mo:prim";
     import Third "./helper";
     module { let { nested = { call_raw = alias }; cyclesAdd = _ } = first; ignore Third.call_raw };`,
  );
  expect(inspection).toEqual({
    immediateImports: ["mo:prim", "mo:prim", "./helper"],
    hasActorUrl: false,
    dotMembers: ["call_raw"],
    patternFields: ["cyclesAdd", "nested", "call_raw"],
  });
});

test("compact inspection does not export the AST of a deeply nested expression", async () => {
  const mo = await loadMotoko();
  const source = `module { public let cyclesAdd = ${Array(10_000).fill("1").join(" + ")} }`;
  expect(await mo.inspectMotoko("deep.mo", source)).toEqual({
    immediateImports: [],
    hasActorUrl: false,
    dotMembers: [],
    patternFields: [],
  });
});
