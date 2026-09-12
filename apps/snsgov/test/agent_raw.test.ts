import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { callRaw, QueryMethodUnavailableError, resetAgent } from "../src/data/agent";
import { buildAndValidate, validatePayload } from "../src/data/custom_proposal";

const target = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const methodName = "validate_payload";
const arg = new Uint8Array(IDL.encode([IDL.Nat], [9_007_199_254_740_999n]));
const replyType = IDL.Variant({ Ok: IDL.Text, Err: IDL.Text });
const reply = new Uint8Array(IDL.encode([replyType], [{ Ok: "valid" }]));
const options = { host: "https://example.invalid", local: false };

function setup() {
  const query = mock(async () => ({ status: "replied", reply: { arg: reply } }));
  const call = mock(async () => { throw new Error("Read preview must never send an update"); });
  spyOn(HttpAgent, "create").mockResolvedValue({ query, call } as unknown as HttpAgent);
  return { query, call };
}

beforeEach(resetAgent);
afterEach(() => { mock.restore(); resetAgent(); });

test("a query validator returns its exact raw Candid reply without an update", async () => {
  const { query, call } = setup();
  expect(await callRaw(target, methodName, arg, options)).toEqual(reply);
  expect(query).toHaveBeenCalledWith(target, { methodName, arg });
  expect(call).not.toHaveBeenCalled();
});

test("an existing custom function without a topic can receive a read-only validator preview", async () => {
  const { query, call } = setup();
  const result = await buildAndValidate({
    functionId: 1000n,
    targetCanisterId: target.toText(),
    targetMethodName: "execute",
    validatorCanisterId: target.toText(),
    validatorMethodName: methodName,
    candidInterface: "service : { execute : (nat) -> (); }",
  }, "9007199254740999", options);

  expect(result.payload).toEqual(arg);
  expect(result.validation).toMatchObject({ ok: true, status: "accepted", rendering: "valid" });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(target, { methodName, arg: result.payload });
  expect(call).not.toHaveBeenCalled();
});

test("a missing query method reports update required without submitting one", async () => {
  const { query, call } = setup();
  query.mockResolvedValue({ status: "rejected", reject_code: 3, reject_message: "Canister has no query method 'validate_payload'" } as never);
  await expect(callRaw(target, methodName, arg, options)).rejects.toBeInstanceOf(QueryMethodUnavailableError);
  const result = await validatePayload({ validatorCanisterId: target.toText(), validatorMethodName: methodName, payload: arg }, options);
  expect(result).toMatchObject({ ok: false, status: "update_required", updateRequired: true });
  expect(call).not.toHaveBeenCalled();
});

test("query rejection and network failure never trigger a write fallback", async () => {
  const { query, call } = setup();
  query.mockResolvedValueOnce({ status: "rejected", reject_code: 4, reject_message: "Only Governance may validate" } as never);
  const result = await validatePayload({ validatorCanisterId: target.toText(), validatorMethodName: methodName, payload: arg }, options);
  expect(result).toMatchObject({ ok: false, status: "unavailable" });
  expect(result.updateRequired).toBeUndefined();
  query.mockRejectedValueOnce(new Error("network connection interrupted"));
  await expect(callRaw(target, methodName, arg, options)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  expect(call).not.toHaveBeenCalled();
});

test("validator acceptance and rejection export the exact response evidence", async () => {
  const { query, call } = setup();
  const params = { validatorCanisterId: target.toText(), validatorMethodName: methodName, payload: arg };
  expect(await validatePayload(params, options)).toMatchObject({ ok: true, status: "accepted", rendering: "valid", rawReplyHex: Buffer.from(reply).toString("hex") });
  const rejected = new Uint8Array(IDL.encode([replyType], [{ Err: "wrong destination" }]));
  query.mockResolvedValueOnce({ status: "replied", reply: { arg: rejected } });
  expect(await validatePayload(params, options)).toMatchObject({ ok: false, status: "rejected", error: "wrong destination", rawReplyHex: Buffer.from(rejected).toString("hex") });
  query.mockResolvedValueOnce({ status: "replied", reply: { arg: new Uint8Array([1, 2, 3]) } });
  expect(await validatePayload(params, options)).toMatchObject({ ok: false, status: "invalid_reply", rawReplyHex: "010203" });
  expect(call).not.toHaveBeenCalled();
});
