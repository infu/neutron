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
  });
  expect("rawExp" in inspection).toBe(false);
  expect("ast" in inspection).toBe(false);
});
