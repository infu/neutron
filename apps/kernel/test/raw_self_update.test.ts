import { expect, test } from "bun:test";
import type { Agent, RequestId, SubmitResponse } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { submitRawSelfUpdate } from "../src/raw_self_update.ts";

const canister = Principal.fromText("efadq-gl777-77774-aaaba-cai");

function acceptedAgent(
  requestId: RequestId,
  observe: (fields: Parameters<Agent["call"]>[1]) => void,
): Agent {
  return {
    rootKey: new Uint8Array(96),
    async call(
      _canisterId: Parameters<Agent["call"]>[0],
      fields: Parameters<Agent["call"]>[1],
    ) {
      observe(fields);
      return {
        requestId,
        response: {
          ok: true,
          status: 202,
          statusText: "Accepted",
          body: null,
          headers: [],
        },
      } satisfies SubmitResponse;
    },
  } as unknown as Agent;
}

test("raw attachment updates submit once and return certified poll bytes", async () => {
  const requestId = Object.assign(new Uint8Array(32).fill(7), {
    __requestId__: undefined,
  }) as RequestId;
  const argument = new Uint8Array([68, 73, 68, 76, 0, 0]);
  const reply = new Uint8Array([68, 73, 68, 76, 0, 1, 127]);
  let submissions = 0;
  let polled = false;
  const agent = acceptedAgent(requestId, (fields) => {
    submissions += 1;
    expect(fields.methodName).toBe("app_binary_demo__put");
    expect(fields.arg).toBe(argument);
    expect(Principal.from(fields.effectiveCanisterId!)).toEqual(canister);
    expect((fields as typeof fields & { callSync?: boolean }).callSync).toBe(
      false,
    );
  });

  const result = await submitRawSelfUpdate(
    agent,
    canister,
    "app_binary_demo__put",
    argument,
    {
      poll: async (polledAgent, polledCanister, polledRequestId) => {
        polled = true;
        expect(polledAgent).toBe(agent);
        expect(polledCanister).toEqual(canister);
        expect(polledRequestId).toBe(requestId);
        return { reply };
      },
    },
  );
  expect(submissions).toBe(1);
  expect(polled).toBe(true);
  expect(result).toBe(reply);
});

test("raw attachment updates reject V2 submission failures", async () => {
  const requestId = Object.assign(new Uint8Array(32).fill(8), {
    __requestId__: undefined,
  }) as RequestId;
  const agent = {
    rootKey: new Uint8Array(96),
    async call(
      _canisterId: Parameters<Agent["call"]>[0],
      fields: Parameters<Agent["call"]>[1],
    ) {
      expect((fields as typeof fields & { callSync?: boolean }).callSync).toBe(
        false,
      );
      return {
        requestId,
        response: {
          ok: false,
          status: 200,
          statusText: "Rejected",
          body: {
            reject_code: 4,
            reject_message: "method rejected",
            error_code: "IC0503",
          },
          headers: [],
        },
      } satisfies SubmitResponse;
    },
  } as unknown as Agent;

  await expect(
    submitRawSelfUpdate(
      agent,
      canister,
      "app_binary_demo__put",
      new Uint8Array(),
    ),
  ).rejects.toMatchObject({
    name: "RejectError",
    message: expect.stringContaining("method rejected"),
  });
});

test("raw attachment updates reject an impossible async response shape", async () => {
  const requestId = Object.assign(new Uint8Array(32).fill(9), {
    __requestId__: undefined,
  }) as RequestId;
  const agent = {
    rootKey: new Uint8Array(96),
    async call() {
      return {
        requestId,
        response: {
          ok: true,
          status: 200,
          statusText: "OK",
          body: null,
          headers: [],
        },
      } satisfies SubmitResponse;
    },
  } as unknown as Agent;

  await expect(
    submitRawSelfUpdate(
      agent,
      canister,
      "app_binary_demo__put",
      new Uint8Array(),
    ),
  ).rejects.toMatchObject({
    name: "UnknownError",
    message: expect.stringContaining("unexpected HTTP status 200"),
  });
});
