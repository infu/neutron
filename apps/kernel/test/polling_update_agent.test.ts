import { expect, test } from "bun:test";
import type { Agent, RequestId, SubmitResponse } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import {
  type PollingUpdateFetch,
  usePollingUpdateFetch,
  submitPollingUpdate,
} from "../src/polling_update_agent.ts";

test("the polling-update adapter submits one asynchronous update", async () => {
  const requestId = Object.assign(new Uint8Array(32).fill(1), {
    __requestId__: undefined,
  }) as RequestId;
  const canister = Principal.fromText("efadq-gl777-77774-aaaba-cai");
  let submissions = 0;
  let observedCallSync: boolean | undefined;
  const agent = {
    async call(
      _canisterId: Parameters<Agent["call"]>[0],
      fields: Parameters<Agent["call"]>[1],
    ) {
      submissions += 1;
      observedCallSync = (
        fields as typeof fields & { callSync?: boolean }
      ).callSync;
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

  const result = await submitPollingUpdate(agent, canister, {
    methodName: "kernel_install_wasm_chunks_clear",
    arg: new Uint8Array(),
    effectiveCanisterId: canister,
  });

  expect(submissions).toBe(1);
  expect(observedCallSync).toBe(false);
  expect(result.response.status).toBe(202);
});

test("the ICBlast fetch adapter changes only v3 update calls", async () => {
  const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
  const body = new Uint8Array([1, 2, 3]);
  const underlying = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      input:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      init,
    });
    return new Response(null, { status: 202 });
  }) as PollingUpdateFetch;
  const adapted = usePollingUpdateFetch(underlying);

  await adapted("https://icp-api.io/api/v3/canister/aaaaa-aa/call", {
    method: "POST",
    body,
  });
  await adapted("https://icp-api.io/api/v3/canister/aaaaa-aa/query");

  expect(requests).toHaveLength(2);
  expect(requests[0]?.input).toBe(
    "https://icp-api.io/api/v2/canister/aaaaa-aa/call",
  );
  expect(requests[0]?.init?.body).toBe(body);
  expect(requests[1]?.input).toBe(
    "https://icp-api.io/api/v3/canister/aaaaa-aa/query",
  );
});
