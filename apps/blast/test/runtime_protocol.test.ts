import { describe, expect, test } from "bun:test";
import { SCRIPT_GUEST_BOOTSTRAP, scriptEvaluationSource } from "../src/script_guest.ts";
import {
  SCRIPT_PROTOCOL_VERSION,
  isScriptHostResponseMessage,
  isScriptWorkerMessage,
} from "../src/script_protocol.ts";
import {
  QUERY_PROTOCOL_VERSION,
  isQueryRequest,
  isQueryResponse,
} from "../src/query_protocol.ts";

describe("script protocol", () => {
  test("accepts only exact host responses", () => {
    expect(
      isScriptHostResponseMessage({
        type: "blast:script:host-response",
        version: SCRIPT_PROTOCOL_VERSION,
        requestId: 1,
        ok: true,
        value: { nested: [1, null, "two"] },
      }),
    ).toBe(true);
    expect(
      isScriptHostResponseMessage({
        type: "blast:script:host-response",
        version: SCRIPT_PROTOCOL_VERSION,
        requestId: 1,
        ok: true,
        value: null,
        error: "ambiguous",
      }),
    ).toBe(false);
    expect(
      isScriptHostResponseMessage({
        type: "blast:script:host-response",
        version: SCRIPT_PROTOCOL_VERSION,
        requestId: 0,
        ok: false,
        error: "bad id",
      }),
    ).toBe(false);
  });

  test("rejects malformed worker envelopes", () => {
    expect(
      isScriptWorkerMessage({
        type: "blast:script:ready",
        version: SCRIPT_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      isScriptWorkerMessage({
        type: "blast:script:host-request",
        version: SCRIPT_PROTOCOL_VERSION,
        requestId: 1,
        observedResponseIds: [],
        operation: "blast.query",
        arguments: {},
      }),
    ).toBe(true);
    expect(
      isScriptWorkerMessage({
        type: "blast:script:host-request",
        version: SCRIPT_PROTOCOL_VERSION,
        requestId: 2,
        observedResponseIds: [2],
        operation: "blast.query",
        arguments: {},
      }),
    ).toBe(false);
    expect(
      isScriptWorkerMessage({
        type: "blast:script:result",
        version: SCRIPT_PROTOCOL_VERSION + 1,
        ok: true,
        value: null,
      }),
    ).toBe(false);
  });
});

describe("guest API", () => {
  test("installs only frozen JSON host façades", () => {
    expect(SCRIPT_GUEST_BOOTSTRAP).toContain("Object.freeze");
    expect(SCRIPT_GUEST_BOOTSTRAP).toContain("delete globalThis.__blastHost");
    expect(SCRIPT_GUEST_BOOTSTRAP).not.toMatch(/\bfetch\s*\(/u);
    expect(SCRIPT_GUEST_BOOTSTRAP).not.toContain("indexedDB");
    expect(SCRIPT_GUEST_BOOTSTRAP).not.toContain("localStorage");
  });

  test("serializes input as inert data", () => {
    const source = scriptEvaluationSource("return input;", {
      payload: "'); globalThis.escaped = true; ('",
    });
    expect(source).toContain("JSON.parse");
    expect(source).toContain("\\\"");
    expect(source).not.toContain(
      "JSON.parse(\"{\"payload\":\"'); globalThis.escaped = true; ('\"}\")",
    );
  });
});

describe("query protocol", () => {
  test("requires a versioned bounded-shape request and unambiguous result", () => {
    expect(
      isQueryRequest({
        type: "blast:query:run",
        version: QUERY_PROTOCOL_VERSION,
        expression: "$",
        input: { value: 1 },
        timeoutMs: 1,
      }),
    ).toBe(true);
    expect(
      isQueryRequest({
        type: "blast:query:run",
        version: QUERY_PROTOCOL_VERSION,
        expression: "$",
        timeoutMs: 0,
      }),
    ).toBe(false);
    expect(
      isQueryResponse({
        type: "blast:query:result",
        version: QUERY_PROTOCOL_VERSION,
        ok: false,
        error: "bounded",
      }),
    ).toBe(true);
    expect(
      isQueryResponse({
        type: "blast:query:result",
        version: QUERY_PROTOCOL_VERSION,
        ok: false,
        value: null,
        error: "ambiguous",
      }),
    ).toBe(false);
  });
});
