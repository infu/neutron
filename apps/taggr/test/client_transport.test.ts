import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { AnonymousIdentity, HttpAgent, polling, type SubmitResponse } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createTaggrClient, encodeAddPostArgs, TaggrCallError } from "../src/taggr_client.ts";

const canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const identity = new AnonymousIdentity();
const requestId = new Uint8Array(32).fill(7) as SubmitResponse["requestId"];

async function setup() {
  const call = mock(async (): Promise<SubmitResponse> => ({
    requestId,
    response: { ok: true, status: 202, statusText: "Accepted", headers: [], body: null },
  }));
  const agent = { call } as unknown as HttpAgent;
  spyOn(HttpAgent, "create").mockResolvedValue(agent);
  const poll = spyOn(polling, "pollForResponse").mockResolvedValue({
    reply: new TextEncoder().encode('{"Ok":"héllo 🏴‍☠️"}'),
    certificate: {} as Awaited<ReturnType<typeof polling.pollForResponse>>["certificate"],
  });
  const client = await createTaggrClient({
    canisterId: canister.toText(),
    identity,
    host: "https://example.invalid",
    local: false,
  });
  return { client, agent, call, poll };
}

afterEach(() => mock.restore());

test("accepted JSON updates preserve UTF-8 argument bytes and poll the submitted request once", async () => {
  const { client, agent, call, poll } = await setup();
  const payload = '[42,"héllo 🏴‍☠️"]';

  expect(await client.update("react", payload)).toBe('{"Ok":"héllo 🏴‍☠️"}');
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith(canister, {
    methodName: "react",
    arg: new TextEncoder().encode(payload),
    callSync: false,
  });
  expect(poll).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledWith(agent, canister, requestId);
});

test("accepted add_post preserves Candid argument and reply bytes through the same transport", async () => {
  const { client, call, poll } = await setup();
  const input = { body: "héllo 🏴‍☠️", parent: 42, realm: "NEUTRON" };
  poll.mockResolvedValueOnce({
    reply: IDL.encode([IDL.Variant({ Ok: IDL.Nat64, Err: IDL.Text })], [{ Ok: 123n }]),
    certificate: {} as Awaited<ReturnType<typeof polling.pollForResponse>>["certificate"],
  });

  expect(await client.addPost(input)).toBe(123);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith(canister, {
    methodName: "add_post",
    arg: encodeAddPostArgs(input),
    callSync: false,
  });
  expect(poll).toHaveBeenCalledTimes(1);
});

for (const operation of ["update", "addPost"] as const) {
  test(`${operation} reports an HTTP 200 submission rejection without polling or resubmitting`, async () => {
    const { client, call, poll } = await setup();
    call.mockResolvedValueOnce({
      requestId,
      response: {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: [],
        body: {
          reject_code: 4,
          reject_message: "Taggr cannot accept this request",
          error_code: "IC0406",
        },
      },
    });

    const result = operation === "update"
      ? client.update("react", "[42,1]")
      : client.addPost({ body: "hello" });
    await expect(result).rejects.toBeInstanceOf(TaggrCallError);
    await expect(result).rejects.toMatchObject({ message: "Taggr cannot accept this request" });
    expect(call).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
  });
}

test("submission failures propagate without polling or resubmitting an uncertain update", async () => {
  const { client, call, poll } = await setup();
  const failure = new Error("network connection interrupted");
  call.mockRejectedValueOnce(failure);

  await expect(client.update("react", "[42,1]")).rejects.toBe(failure);
  expect(call).toHaveBeenCalledTimes(1);
  expect(poll).not.toHaveBeenCalled();
});

test("certified polling failures propagate without resubmitting the accepted update", async () => {
  const { client, call, poll } = await setup();
  const failure = new Error("certified rejection");
  poll.mockRejectedValueOnce(failure);

  await expect(client.update("react", "[42,1]")).rejects.toBe(failure);
  expect(call).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledTimes(1);
});
