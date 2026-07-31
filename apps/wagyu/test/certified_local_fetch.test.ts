import { describe, expect, test } from "bun:test";
import type { HttpAgent } from "@dfinity/agent";
import {
  selectCertifiedFetchForRuntime,
} from "../src/app/certified_runtime.ts";
import {
  responseFromCanisterHttpQuery,
} from "../src/verifier/canister_http_query_fetch.ts";

const CERTIFIED_URL =
  "http://ryjl3-tyaaa-aaaaa-aaaba-cai.localhost:8000/app/wagyu/_route/protocol/v1/profile";

describe("PocketIC certified-query fetch boundary", () => {
  test("selects the canister HTTP query path only for trusted local runtimes", () => {
    const browserFetch = (async () =>
      new Response()) as unknown as typeof globalThis.fetch;
    const localFetch = (async () =>
      new Response()) as unknown as typeof globalThis.fetch;
    const queryAgent = {} as HttpAgent;
    let selectedAgent: HttpAgent | null = null;
    const factory = (agent: HttpAgent) => {
      selectedAgent = agent;
      return localFetch;
    };

    expect(selectCertifiedFetchForRuntime(
      { allowInsecureLocalhost: false, queryAgent },
      browserFetch,
      factory,
    )).not.toBe(browserFetch);
    expect(selectedAgent).toBeNull();
    expect(selectCertifiedFetchForRuntime(
      { allowInsecureLocalhost: true, queryAgent },
      browserFetch,
      factory,
    )).toBe(localFetch);
    expect(selectedAgent === queryAgent).toBeTrue();
  });

  test("binds the production fetch to the browser global", async () => {
    let receiver: unknown;
    const browserFetch = (async function (this: unknown) {
      receiver = this;
      return new Response();
    }) as unknown as typeof globalThis.fetch;
    const selected = selectCertifiedFetchForRuntime(
      {
        allowInsecureLocalhost: false,
        queryAgent: {} as HttpAgent,
      },
      browserFetch,
    );

    await selected.call({ wrong: "receiver" }, CERTIFIED_URL);
    expect(receiver).toBe(globalThis);
  });

  test("preserves an exact Uint8Array subview and the returned proof headers", async () => {
    const backing = new Uint8Array(32).fill(0xcc);
    const body = backing.subarray(7, 12);
    body.set([1, 2, 3, 4, 5]);
    const response = responseFromCanisterHttpQuery(
      new URL(CERTIFIED_URL),
      {
        body,
        headers: [
          ["Content-Length", "5"],
          ["Content-Digest", "sha-256=:fixture:"],
          ["IC-Certificate", "certificate=:AQ==:"],
        ],
        streaming_strategy: [],
        status_code: 200,
        upgrade: [],
      },
    );

    backing.fill(0);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.of(1, 2, 3, 4, 5),
    );
    expect(response.headers.get("Content-Digest")).toBe(
      "sha-256=:fixture:",
    );
    expect(response.url).toBe(CERTIFIED_URL);
  });

  test("rejects upgrade, streaming, oversized, and non-canonical byte replies", () => {
    const valid = {
      body: Uint8Array.of(1),
      headers: [["Content-Length", "1"]] as Array<[string, string]>,
      streaming_strategy: [] as [] | [unknown],
      status_code: 200,
      upgrade: [] as [] | [boolean],
    };
    expect(() =>
      responseFromCanisterHttpQuery(new URL(CERTIFIED_URL), {
        ...valid,
        upgrade: [true],
      })
    ).toThrow("upgrade");
    expect(() =>
      responseFromCanisterHttpQuery(new URL(CERTIFIED_URL), {
        ...valid,
        streaming_strategy: [{}],
      })
    ).toThrow("stream");
    expect(() =>
      responseFromCanisterHttpQuery(new URL(CERTIFIED_URL), {
        ...valid,
        body: new Uint8Array(1_048_577),
      })
    ).toThrow("1048576");
    expect(() =>
      responseFromCanisterHttpQuery(new URL(CERTIFIED_URL), {
        ...valid,
        body: Uint8Array.of(1).buffer as unknown as Uint8Array,
      })
    ).toThrow("Uint8Array");
  });
});
