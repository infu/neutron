import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { HttpAgent, polling } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { callRaw, resetAgent } from "../src/data/agent";

const target = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const methodName = "validate_payload";
const arg = new Uint8Array(IDL.encode([IDL.Nat], [9_007_199_254_740_999n]));
const reply = new Uint8Array(IDL.encode([IDL.Variant({ Ok: IDL.Text, Err: IDL.Text })], [{ Ok: "valid" }]));
const requestId = new Uint8Array(32).fill(7);
const options = { host: "https://example.invalid", local: false };

function setup() {
  const query = mock(async () => ({
    status: "rejected",
    reject_code: 3,
    reject_message: "Canister has no query method 'validate_payload'",
  }));
  const call = mock(async () => ({
    requestId,
    response: { ok: true, status: 202, statusText: "Accepted", headers: [], body: null },
  }));
  const agent = { query, call } as unknown as HttpAgent;
  spyOn(HttpAgent, "create").mockResolvedValue(agent);
  const poll = spyOn(polling, "pollForResponse").mockResolvedValue({
    reply,
    certificate: {} as Awaited<ReturnType<typeof polling.pollForResponse>>["certificate"],
  });
  return { agent, query, call, poll };
}

beforeEach(resetAgent);
afterEach(() => {
  mock.restore();
  resetAgent();
});

test("a query validator returns its exact raw Candid reply without an update", async () => {
  const { query, call, poll } = setup();
  query.mockResolvedValueOnce({ status: "replied", reply: { arg: reply } } as never);

  expect(await callRaw(target, methodName, arg, options)).toEqual(reply);
  expect(query).toHaveBeenCalledWith(target, { methodName, arg });
  expect(call).not.toHaveBeenCalled();
  expect(poll).not.toHaveBeenCalled();
});

test("an update validator polls its accepted request once without resubmitting the payload", async () => {
  const { agent, query, call, poll } = setup();

  expect(await callRaw(target.toText(), methodName, arg, options)).toEqual(reply);
  expect(query).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith(target, { methodName, arg, callSync: false });
  expect(poll).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledWith(agent, target, requestId);
});

test("an update submission rejection reports its own reason and does not poll", async () => {
  const { call, poll } = setup();
  call.mockResolvedValueOnce({
    requestId,
    response: {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: [],
      body: { reject_code: 4, reject_message: "Validator cannot accept this payload" },
    },
  } as never);

  await expect(callRaw(target, methodName, arg, options)).rejects.toMatchObject({
    message: "update rejected (4): Validator cannot accept this payload",
  });
  expect(poll).not.toHaveBeenCalled();
});

test("an interrupted update reports the submission error instead of the missing query method", async () => {
  const { call, poll } = setup();
  call.mockRejectedValueOnce(new Error("network connection interrupted"));

  await expect(callRaw(target, methodName, arg, options)).rejects.toMatchObject({
    code: "UPSTREAM_UNAVAILABLE",
    message: "network connection interrupted",
  });
  expect(call).toHaveBeenCalledTimes(1);
  expect(poll).not.toHaveBeenCalled();
});

test("a certified update rejection is surfaced without repeating the validator call", async () => {
  const { call, poll } = setup();
  poll.mockRejectedValueOnce(new Error("Validator rejected: invalid destination"));

  await expect(callRaw(target, methodName, arg, options)).rejects.toMatchObject({
    message: "Validator rejected: invalid destination",
  });
  expect(call).toHaveBeenCalledTimes(1);
});

test("an unexpected submission status cannot be mistaken for a validator reply", async () => {
  const { call, poll } = setup();
  call.mockResolvedValueOnce({
    requestId,
    response: { ok: false, status: 503, statusText: "Service Unavailable", headers: [], body: null },
  });

  await expect(callRaw(target, methodName, arg, options)).rejects.toMatchObject({
    code: "UPSTREAM_UNAVAILABLE",
    message: "update submission failed: 503 Service Unavailable",
  });
  expect(poll).not.toHaveBeenCalled();
});
