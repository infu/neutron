import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { buildAndValidate, decodePayloadArguments, encodePayloadArguments, inspectCustomMethod, isIcrcAccountType, methodArgumentTypes } from "../src/data/custom_proposal";
import { functionRow } from "../src/tools/projections";

const did = `service : {
  zero : () -> ();
  multiple : (nat64, text, opt principal) -> (variant {Ok:text; Err:text}) query;
  one : (vec nat8) -> ();
}`;
const draft = { functionId: 1000n, targetCanisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai", targetMethodName: "zero", topic: "ApplicationBusinessLogic", candidInterface: did };

test("a missing topic does not claim a legacy custom function is blocked", () => {
  const row = functionRow({ id: 1000n, name: "Existing function", kind: "generic" });
  expect(row.topic).toBeNull();
  expect(row.proposable).toBeNull();
  expect(row.blockedReason).toBeUndefined();
  expect(row.eligibilityNote).toContain("deployed Governance canister decides");
});

test("custom schema distinguishes missing methods and zero arguments", async () => {
  expect(await methodArgumentTypes(did, "zero")).toEqual([]);
  expect(await methodArgumentTypes(did, "missing")).toBeNull();
  expect(await inspectCustomMethod(did, "multiple")).toMatchObject({ mode: "query" });
  expect((await inspectCustomMethod(did, "multiple"))?.argumentSchemas).toHaveLength(3);
});

test("custom builder encodes zero and multiple arguments without dropping input", async () => {
  const zero = await buildAndValidate(draft, []);
  expect(IDL.decode([], zero.payload)).toEqual([]);
  expect(zero.validation).toMatchObject({ ok: false, status: "not_configured" });
  const multiple = await buildAndValidate({ ...draft, targetMethodName: "multiple" }, ["18446744073709551615", "review", null]);
  expect(decodePayloadArguments([IDL.Nat64, IDL.Text, IDL.Opt(IDL.Principal)], multiple.payload)).toEqual(["18446744073709551615", "review", null]);
  await expect(buildAndValidate({ ...draft, targetMethodName: "multiple" }, ["1"])).rejects.toThrow();
  await expect(buildAndValidate(draft, ["unexpected"])).rejects.toThrow(/no arguments/);
});

test("a single vector parameter remains a vector and exact raw bytes round trip", async () => {
  const one = await buildAndValidate({ ...draft, targetMethodName: "one" }, [0, 127, 255]);
  expect(decodePayloadArguments([IDL.Vec(IDL.Nat8)], one.payload)).toEqual([{ hex: "007fff" }]);
  const original = new Uint8Array([68, 73, 68, 76, 0, 0]);
  expect(encodePayloadArguments([], [])).toEqual(original);
});

test("nested textual ICRC accounts convert only for the exact account shape", async () => {
  const accountDid = "service : { send : (record { destination : record {owner:principal; subaccount:opt vec nat8}; amount:nat64 }) -> (); }";
  const types = (await methodArgumentTypes(accountDid, "send"))!;
  const result = await buildAndValidate({ ...draft, targetMethodName: "send", candidInterface: accountDid }, { destination: "rrkah-fqaaa-aaaaa-aaaaq-cai", amount: "9007199254740993" });
  expect(decodePayloadArguments(types, result.payload)).toEqual([{ destination: { owner: "rrkah-fqaaa-aaaaa-aaaaq-cai", subaccount: null }, amount: "9007199254740993" }]);
  expect(isIcrcAccountType(IDL.Record({owner:IDL.Principal,subaccount:IDL.Text}))).toBe(false);
});
