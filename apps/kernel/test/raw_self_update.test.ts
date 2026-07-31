import { expect, test } from "bun:test";
import type {
  Agent,
  RequestId,
  SubmitResponse,
} from "@dfinity/agent";
import { LookupPathStatus } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { submitRawSelfUpdate } from "../src/raw_self_update.ts";

const canister = Principal.fromText("efadq-gl777-77774-aaaba-cai");

function acceptedAgent(
  requestId: RequestId,
  observe: (fields: {
    methodName: string;
    arg: Uint8Array;
    effectiveCanisterId: Principal | string;
  }) => void,
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

test("raw attachment updates submit encoded Candid and return certified poll bytes", async () => {
  const requestId = Object.assign(new Uint8Array(32).fill(7), {
    __requestId__: undefined,
  }) as RequestId;
  const argument = new Uint8Array([68, 73, 68, 76, 0, 0]);
  const reply = new Uint8Array([68, 73, 68, 76, 0, 1, 127]);
  let submitted = false;
  let polled = false;
  const agent = acceptedAgent(requestId, (fields) => {
    submitted = true;
    expect(fields.methodName).toBe("app_binary_demo__put");
    expect(fields.arg).toBe(argument);
    expect(Principal.from(fields.effectiveCanisterId)).toEqual(canister);
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
  expect(submitted).toBe(true);
  expect(polled).toBe(true);
  expect(result).toBe(reply);
});

test("raw attachment updates reject uncertified synchronous V2 failures", async () => {
  const requestId = Object.assign(new Uint8Array(32).fill(8), {
    __requestId__: undefined,
  }) as RequestId;
  const agent = {
    rootKey: new Uint8Array(96),
    async call() {
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

test("raw attachment updates extract immediate V3 certified reply bytes", async () => {
  const requestId = Object.assign(new Uint8Array(32).fill(9), {
    __requestId__: undefined,
  }) as RequestId;
  const reply = new Uint8Array([68, 73, 68, 76, 0, 1, 127]);
  const agent = {
    rootKey: new Uint8Array(96),
    async call() {
      return {
        requestId,
        response: {
          ok: true,
          status: 200,
          statusText: "OK",
          body: { certificate: new Uint8Array([1, 2, 3]) },
          headers: [],
        },
      } satisfies SubmitResponse;
    },
  } as unknown as Agent;
  let polled = false;

  const result = await submitRawSelfUpdate(
    agent,
    canister,
    "app_binary_demo__put",
    new Uint8Array(),
    {
      poll: async () => {
        polled = true;
        throw new Error("immediate V3 reply must not poll");
      },
      createCertificate: async () => ({
        lookup_path(path) {
          const field = path[path.length - 1];
          if (field === "status") {
            return {
              status: LookupPathStatus.Found,
              value: new TextEncoder().encode("replied"),
            };
          }
          if (field === "reply") {
            return { status: LookupPathStatus.Found, value: reply };
          }
          return { status: LookupPathStatus.Absent };
        },
      }),
    },
  );
  expect(polled).toBe(false);
  expect(result).toBe(reply);
});

test("raw attachment updates surface immediate V3 certified rejections", async () => {
  const requestId = Object.assign(new Uint8Array(32).fill(10), {
    __requestId__: undefined,
  }) as RequestId;
  const agent = {
    rootKey: new Uint8Array(96),
    async call() {
      return {
        requestId,
        response: {
          ok: false,
          status: 200,
          statusText: "Rejected",
          body: { certificate: new Uint8Array([4, 5, 6]) },
          headers: [],
        },
      } satisfies SubmitResponse;
    },
  } as unknown as Agent;
  const text = new TextEncoder();

  await expect(
    submitRawSelfUpdate(
      agent,
      canister,
      "app_binary_demo__put",
      new Uint8Array(),
      {
        createCertificate: async () => ({
          lookup_path(path) {
            const field = path[path.length - 1];
            const value =
              field === "status"
                ? text.encode("rejected")
                : field === "reject_code"
                  ? new Uint8Array([4])
                  : field === "reject_message"
                    ? text.encode("certified reject")
                    : field === "error_code"
                      ? text.encode("IC0503")
                      : undefined;
            return value === undefined
              ? { status: LookupPathStatus.Absent }
              : { status: LookupPathStatus.Found, value };
          },
        }),
      },
    ),
  ).rejects.toMatchObject({
    name: "RejectError",
    isCertified: true,
    message: expect.stringContaining("certified reject"),
  });
});
