import {
  Actor,
  type ActorSubclass,
  type HttpAgent,
} from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";

type HttpRequest = {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
  certificate_version: [] | [number];
};

export type CanisterHttpQueryResponse = {
  body: Uint8Array;
  headers: Array<[string, string]>;
  streaming_strategy: [] | [unknown];
  status_code: number;
  upgrade: [] | [boolean];
};

type CertifiedHttpActor = ActorSubclass<{
  http_request(request: HttpRequest): Promise<CanisterHttpQueryResponse>;
}>;

const MAX_QUERY_BODY_BYTES = 1_048_576;
const MAX_QUERY_HEADER_FIELDS = 64;
const MAX_QUERY_HEADER_BYTES = 32_768;
const UTF8 = new TextEncoder();

const headerField = IDL.Tuple(IDL.Text, IDL.Text);
const streamingToken = IDL.Record({
  key: IDL.Text,
  sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
  index: IDL.Nat,
  content_encoding: IDL.Text,
});
const streamingCallback = IDL.Record({
  token: IDL.Opt(streamingToken),
  body: IDL.Vec(IDL.Nat8),
});
const streamingStrategy = IDL.Variant({
  Callback: IDL.Record({
    token: streamingToken,
    callback: IDL.Func([streamingToken], [streamingCallback], ["query"]),
  }),
});
const httpRequest = IDL.Record({
  method: IDL.Text,
  url: IDL.Text,
  headers: IDL.Vec(headerField),
  body: IDL.Vec(IDL.Nat8),
  certificate_version: IDL.Opt(IDL.Nat16),
});
const httpResponse = IDL.Record({
  body: IDL.Vec(IDL.Nat8),
  headers: IDL.Vec(headerField),
  streaming_strategy: IDL.Opt(streamingStrategy),
  status_code: IDL.Nat16,
  upgrade: IDL.Opt(IDL.Bool),
});
const certifiedHttpIdl: IDL.InterfaceFactory = ({ IDL: candid }) =>
  candid.Service({
    http_request: candid.Func([httpRequest], [httpResponse], ["query"]),
  });

/**
 * PocketIC's gateway replaces Access-Control-Expose-Headers on cross-origin
 * responses. A sandboxed app would therefore lose the proof headers even
 * though the canister returned and certified them. Querying the standard
 * canister HTTP interface returns those exact headers inside Candid, after
 * which the ordinary Wagyu verifier still checks the body, fixed header
 * policy, witness, certificate, path, and semantic binding.
 */
export function createCanisterHttpQueryFetch(
  agent: HttpAgent,
): typeof globalThis.fetch {
  const actors = new Map<string, CertifiedHttpActor>();
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = exactGetUrl(input, init);
    const canisterId = localCanisterId(url);
    if (init?.signal?.aborted) {
      throw new DOMException("The certified fetch was aborted", "AbortError");
    }
    let actor = actors.get(canisterId);
    if (!actor) {
      actor = Actor.createActor(certifiedHttpIdl, {
        agent,
        canisterId,
      }) as CertifiedHttpActor;
      actors.set(canisterId, actor);
    }
    const result = await actor.http_request({
      method: "GET",
      url: `${url.pathname}${url.search}`,
      headers: [["host", url.host]],
      body: new Uint8Array(),
      certificate_version: [2],
    });
    return responseFromCanisterHttpQuery(url, result);
  }) as typeof globalThis.fetch;
}

/**
 * Converts the standard canister-HTTP query reply without coercing binary
 * values through strings or admitting an unbounded response before the
 * certified verifier runs.
 */
export function responseFromCanisterHttpQuery(
  url: URL,
  result: CanisterHttpQueryResponse,
): Response {
  if (
    !Array.isArray(result.streaming_strategy) ||
    result.streaming_strategy.length !== 0
  ) {
    throw new Error("Certified Wagyu responses must not stream");
  }
  if (
    !Array.isArray(result.upgrade) ||
    result.upgrade.length > 1 ||
    (result.upgrade.length === 1 &&
      typeof result.upgrade[0] !== "boolean")
  ) {
    throw new Error("Certified Wagyu response has an invalid upgrade flag");
  }
  if (result.upgrade[0] === true) {
    throw new Error("Certified Wagyu responses must not upgrade");
  }
  if (!(result.body instanceof Uint8Array)) {
    throw new Error("Certified Wagyu response body must be a Uint8Array");
  }
  if (result.body.byteLength > MAX_QUERY_BODY_BYTES) {
    throw new Error(
      `Certified Wagyu response exceeds ${MAX_QUERY_BODY_BYTES} bytes`,
    );
  }
  if (
    !Number.isSafeInteger(result.status_code) ||
    result.status_code < 200 ||
    result.status_code > 599
  ) {
    throw new Error("Certified Wagyu response status is invalid");
  }
  if (
    !Array.isArray(result.headers) ||
    result.headers.length > MAX_QUERY_HEADER_FIELDS
  ) {
    throw new Error("Certified Wagyu response has too many headers");
  }

  const headers = new Headers();
  let headerBytes = 0;
  for (const field of result.headers) {
    if (
      !Array.isArray(field) ||
      field.length !== 2 ||
      typeof field[0] !== "string" ||
      typeof field[1] !== "string"
    ) {
      throw new Error("Certified Wagyu response has a malformed header");
    }
    headerBytes +=
      UTF8.encode(field[0]).byteLength + UTF8.encode(field[1]).byteLength;
    if (headerBytes > MAX_QUERY_HEADER_BYTES) {
      throw new Error(
        `Certified Wagyu response headers exceed ${MAX_QUERY_HEADER_BYTES} bytes`,
      );
    }
    headers.append(field[0], field[1]);
  }

  const exactBody = new Uint8Array(result.body.byteLength);
  exactBody.set(result.body);
  const response = new Response(exactBody.buffer, {
    status: result.status_code,
    headers,
  });
  Object.defineProperty(response, "url", {
    configurable: false,
    enumerable: true,
    value: url.href,
  });
  return response;
}

function exactGetUrl(
  input: RequestInfo | URL,
  init?: RequestInit,
): URL {
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  if (
    method !== "GET" ||
    init?.body != null ||
    request?.body != null ||
    (init?.credentials !== undefined && init.credentials !== "omit") ||
    (init?.redirect !== undefined && init.redirect !== "error")
  ) {
    throw new Error("Certified query fetch accepts exact anonymous GETs only");
  }
  return new URL(
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input,
  );
}

function localCanisterId(url: URL): string {
  if (url.protocol !== "http:" || !url.hostname.endsWith(".localhost")) {
    throw new Error("Certified query fetch is limited to local PocketIC");
  }
  const label = url.hostname.slice(0, -".localhost".length);
  if (label.includes(".")) {
    throw new Error("Certified query fetch requires a canonical canister host");
  }
  let principal: Principal;
  try {
    principal = Principal.fromText(label);
  } catch {
    throw new Error("Certified query fetch target is not a canister");
  }
  if (
    principal.toText() !== label ||
    principal.toUint8Array().at(-1) !== 0x01
  ) {
    throw new Error("Certified query fetch target is not a canonical canister");
  }
  return label;
}
