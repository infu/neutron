import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import type { AppRegistryEntry } from "neutron-compiler/src/install.js";
import {
  assertExternalCanisterCallTarget,
  assertSelfCallJavaScriptTypeSafety,
  assertSelfCallRawRequestBytes,
  CANISTER_RESULT_ERROR_NAME,
  classifyNullaryCanisterResultError,
  encodeSelfCallResult,
  inspectBoundSelfCallBlobs,
  isCanisterResultError,
  materializeSelfCallArguments,
  normalizeCanisterCallResult,
  normalizeSelfCallResult,
  parseSelfCallWireBlobs,
  preflightSelfCallReply,
  preflightSelfCallRequest,
  requireConsentedSelfCall,
  requirePhysicalSelfCallMethod,
  requirePreapprovedSelfCall,
  requireSelfCallCandidMethod,
  selfCallBlobStats,
  selfCallReservationBytes,
  SELF_CALL_BINARY_MAX_COUNT,
  SELF_CALL_BINARY_MAX_BYTES,
  SELF_CALL_CANDID_DECODER_ALLOCATION_MAX_BYTES,
  SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS,
  SELF_CALL_NON_BINARY_CANDID_MAX_BYTES,
  type SelfCallBlobPathSegment,
  type SelfCallWireBlob,
} from "../src/self_calls.ts";
import { registryApp } from "./app_registry_fixture.ts";

const blobType = IDL.Vec(IDL.Nat8);

function app(): AppRegistryEntry {
  return registryApp({
    id: "demo",
    name: "Demo",
    capabilities: {
      preapproved_self_calls: {
        api: 1,
        methods: ["read", "refresh"],
      },
    },
    func: {
      read: { type: "query" },
      refresh: { type: "update", async: "async*" },
      public_status: { type: "query" },
      private_helper: { type: "internal" },
    },
  });
}

function wireBlob(
  path: SelfCallBlobPathSegment[],
  values: ArrayLike<number>,
): SelfCallWireBlob {
  const data = Uint8Array.from(values).buffer as ArrayBuffer;
  return { path, byteLength: data.byteLength, data };
}

function encode(types: IDL.Type[], values: unknown[]): Uint8Array {
  return new Uint8Array(IDL.encode(types, values));
}

function projectSelfCallResult(
  value: unknown,
  outputType: IDL.Type,
) {
  return encodeSelfCallResult(
    normalizeSelfCallResult(value, outputType),
  ).value;
}

test("top-level absent Candid options become JSON null", () => {
  expect(normalizeCanisterCallResult(undefined)).toBeNull();
  expect(normalizeCanisterCallResult(null)).toBeNull();
  const present = { configured: true };
  expect(normalizeCanisterCallResult(present)).toBe(present);
});

test("nullary Candid Result errors retain a stable rejection code", () => {
  const error = classifyNullaryCanisterResultError({
    permission_required: null,
  });
  expect(error).toMatchObject({
    name: CANISTER_RESULT_ERROR_NAME,
    code: "permission_required",
  });
  expect(error).toBeInstanceOf(Error);
  expect(isCanisterResultError(error)).toBe(true);

  expect(
    classifyNullaryCanisterResultError({
      revision_conflict: { expected: "1", actual: "2" },
    }),
  ).toBeNull();
  expect(
    classifyNullaryCanisterResultError({
      invalid: null,
      busy: null,
    }),
  ).toBeNull();
});

test("API1 preapproval binds an exact logical method and mode", () => {
  expect(requirePreapprovedSelfCall(app(), "read", "query").name).toBe("read");
  expect(requirePreapprovedSelfCall(app(), "refresh", "update").name).toBe(
    "refresh",
  );
  expect(() => requirePreapprovedSelfCall(app(), "read", "update")).toThrow(
    /not an app update/,
  );
  expect(() => requirePreapprovedSelfCall(app(), "public_status", "query"))
    .toThrow(/not preapproved/);
  expect(() => requirePreapprovedSelfCall(app(), "missing", "query")).toThrow(
    /does not belong/,
  );
});

test("consented and physical self-call lookup remains source-app scoped", () => {
  const entry = requireConsentedSelfCall(app(), "read");
  expect(requirePhysicalSelfCallMethod("demo", entry)).toBe("app_demo__read");
  expect(() => requireConsentedSelfCall(app(), "private_helper")).toThrow(
    /does not belong/,
  );
  expect(() =>
    requirePhysicalSelfCallMethod("demo", {
      ...entry,
      candid_name: "app_demo__other",
    }),
  ).toThrow(/invalid physical Candid name/);

  const internal = app().functions.find(
    (candidate) => candidate.name === "private_helper",
  );
  expect(internal).toBeDefined();
  expect(() => requirePhysicalSelfCallMethod("demo", internal!)).toThrow(
    /no Candid wrapper/,
  );
});

test("generic signed calls cannot bypass the source-bound self-call service", () => {
  const self = "efadq-gl777-77774-aaaba-cai";
  expect(() => assertExternalCanisterCallTarget(self, self)).toThrow(
    /dedicated source-bound kernel service/,
  );
  expect(() => assertExternalCanisterCallTarget("aaaaa-aa", self)).toThrow(
    /dedicated source-bound kernel service/,
  );
  expect(() =>
    assertExternalCanisterCallTarget("ryjl3-tyaaa-aaaaa-aaaba-cai", self),
  ).not.toThrow();
});

test("live Candid is authoritative for self-call existence, mode, and shape", () => {
  const input = IDL.Record({ body: blobType, caption: IDL.Text });
  const output = IDL.Record({ id: IDL.Nat64, body: blobType });
  const service = IDL.Service({
    fetch: IDL.Func([input], [output], ["query"]),
    store: IDL.Func([input], [output], []),
    notify: IDL.Func([], [], []),
  });

  const fetch = requireSelfCallCandidMethod(service, "fetch", "query");
  expect(fetch.argTypes).toEqual([input]);
  expect(fetch.retTypes).toEqual([output]);
  expect(requireSelfCallCandidMethod(service, "store", "update").argTypes)
    .toEqual([input]);
  expect(() => requireSelfCallCandidMethod(service, "fetch", "update")).toThrow(
    /mode does not match/,
  );
  expect(() =>
    requireSelfCallCandidMethod(service, "missing", "query"),
  ).toThrow();
  expect(() => requireSelfCallCandidMethod(service, "notify", "update")).toThrow(
    /exactly one/,
  );
});

test("nested and repeated binary fields bind only at live Candid blob leaves", () => {
  const requestType = IDL.Record({
    title: IDL.Text,
    primary: blobType,
    nested: IDL.Record({
      items: IDL.Vec(
        IDL.Record({
          label: IDL.Text,
          body: blobType,
        }),
      ),
    }),
    optional: IDL.Opt(IDL.Record({ data: blobType })),
    choice: IDL.Variant({ raw: blobType, none: IDL.Null }),
    omitted: IDL.Opt(IDL.Text),
    explicitlyAbsent: IDL.Opt(IDL.Text),
  });
  const blobs = [
    wireBlob([0, "choice", "raw"], [9]),
    wireBlob([0, "nested", "items", 0, "body"], [4, 5, 6]),
    wireBlob([0, "primary"], [1, 2, 3]),
    wireBlob([0, "optional", "data"], [7, 8]),
  ];
  const bound = materializeSelfCallArguments(
    [
      {
        title: "hello",
        primary: null,
        nested: { items: [{ label: "one", body: null }] },
        optional: { data: null },
        choice: { raw: null },
        explicitlyAbsent: null,
      },
    ],
    blobs,
    [requestType],
  );

  expect(bound.binary).toEqual({ count: 4, bytes: 9 });
  expect(bound.boundBlobs).toHaveLength(4);
  expect(bound.args[0]).toEqual({
    title: "hello",
    primary: Uint8Array.from([1, 2, 3]),
    nested: {
      items: [{ label: "one", body: Uint8Array.from([4, 5, 6]) }],
    },
    optional: { data: Uint8Array.from([7, 8]) },
    choice: { raw: Uint8Array.from([9]) },
    omitted: null,
    explicitlyAbsent: null,
  });
  expect(bound.metadata).toEqual([
    {
      title: "hello",
      primary: null,
      nested: { items: [{ label: "one", body: null }] },
      optional: { data: null },
      choice: { raw: null },
      omitted: null,
      explicitlyAbsent: null,
    },
  ]);
});

test("live blobs require their exact transferable sidecars", () => {
  const requestType = IDL.Record({
    name: IDL.Text,
    body: blobType,
    nested: IDL.Opt(blobType),
  });
  const markerFree = {
    name: "unsupported",
    body: [1, 2, 255],
    nested: [7, 8],
  };
  expect(() =>
    materializeSelfCallArguments([markerFree], [], [requestType]),
  ).toThrow(/missing its binary sidecar/);
  expect(() =>
    materializeSelfCallArguments(
      [{ name: "unsupported", body: "", nested: null }],
      [],
      [requestType],
    ),
  ).toThrow(/missing its binary sidecar/);
});

test("structural nested records bind absent and present optional blobs", () => {
  const referenceType = IDL.Record({
    source: IDL.Principal,
    digest: IDL.Opt(blobType),
  });
  const requestType = IDL.Record({
    entries: IDL.Vec(
      IDL.Record({
        reference: IDL.Variant({ remote: referenceType }),
        active: IDL.Bool,
      }),
    ),
  });
  const source = "aaaaa-aa";
  const request = {
    entries: [
      {
        reference: {
          remote: { source, digest: null },
        },
        active: false,
      },
    ],
  };

  const absent = materializeSelfCallArguments([request], [], [requestType]);
  expect(absent.args).toEqual([request]);
  expect(absent.metadata).toEqual([request]);
  expect(absent.binary).toEqual({ count: 0, bytes: 0 });
  expect(absent.boundBlobs).toEqual([]);

  const digest = Uint8Array.from([...new Array(31).fill(0), 255]);
  const present = materializeSelfCallArguments(
    [request],
    [
      wireBlob(
        [0, "entries", 0, "reference", "remote", "digest"],
        digest,
      ),
    ],
    [requestType],
  );
  expect(present.args).toEqual([
    {
      entries: [
        {
          reference: {
            remote: { source, digest },
          },
          active: false,
        },
      ],
    },
  ]);
  expect(present.metadata).toEqual([request]);
  expect(present.binary).toEqual({ count: 1, bytes: 32 });
  expect(present.boundBlobs).toHaveLength(1);
});

test("released icblast string record shorthands stay opaque and sidecar-free", () => {
  const referenceType = IDL.Record({
    subject: IDL.Principal,
    digest: IDL.Opt(blobType),
  });
  const shorthand = "opaque-record-shorthand";
  const materialized = materializeSelfCallArguments(
    [shorthand],
    [],
    [referenceType],
  );

  expect(materialized.args).toEqual([shorthand]);
  expect(materialized.metadata).toEqual([shorthand]);
  expect(materialized.binary).toEqual({ count: 0, bytes: 0 });
  expect(materialized).not.toHaveProperty("validationArgs");
  expect(() =>
    materializeSelfCallArguments(
      [shorthand],
      [wireBlob([0, "digest"], [1])],
      [referenceType],
    ),
  ).toThrow(/record has an invalid shape/);
  expect(
    materializeSelfCallArguments(
      [shorthand],
      [],
      [IDL.Record({ value: IDL.Text })],
    ).args,
  ).toEqual([shorthand]);
  expect(() =>
    materializeSelfCallArguments([false], [], [referenceType]),
  ).toThrow(/record has an invalid shape/);
});

test("non-binary containers are recursively bounded against live Candid", () => {
  const values = Array.from(
    { length: SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS },
    () => null,
  );
  const vector = IDL.Vec(IDL.Null);
  const accepted = materializeSelfCallArguments([values], [], [vector]);
  expect(accepted.args[0]).toEqual(values);
  expect(() =>
    materializeSelfCallArguments([[...values, null]], [], [vector]),
  ).toThrow(/container element limit/);

  const fields = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [
      `field_${String(index).padStart(3, "0")}`,
      IDL.Opt(IDL.Null),
    ]),
  );
  const wideRecords = Array.from({ length: 16 }, () => ({}));
  expect(() =>
    materializeSelfCallArguments(
      [wideRecords],
      [],
      [IDL.Vec(IDL.Record(fields))],
    ),
  ).toThrow(/container element limit/);

  const recursive = IDL.Rec();
  recursive.fill(IDL.Opt(IDL.Record({ next: recursive })));
  let deep: unknown = null;
  for (let index = 0; index < 40; index += 1) deep = { next: deep };
  expect(() =>
    materializeSelfCallArguments([deep], [], [recursive]),
  ).toThrow(/depth limit/);
});

test("non-binary siblings cannot bypass bounds beside a bound blob", () => {
  const requestType = IDL.Record({
    body: blobType,
    values: IDL.Vec(IDL.Null),
  });
  expect(() =>
    materializeSelfCallArguments(
      [
        {
          body: null,
          values: Array.from(
            { length: SELF_CALL_CANDID_MAX_CONTAINER_ELEMENTS + 1 },
            () => null,
          ),
        },
      ],
      [wireBlob([0, "body"], [1])],
      [requestType],
    ),
  ).toThrow(/container element limit/);
});

test("strings and number arrays are never reinterpreted as blobs", () => {
  for (const value of ["", "00ff", [], [0, 255]]) {
    expect(() =>
      materializeSelfCallArguments([value], [], [blobType]),
    ).toThrow(/missing its binary sidecar/);
  }
  expect(() =>
    materializeSelfCallArguments(
      [[0, 255]],
      [wireBlob([0], [0, 255])],
      [blobType],
    ),
  ).toThrow(/placeholder must be null/);
  expect(
    materializeSelfCallArguments(
      ["00ff", [0, 255]],
      [],
      [IDL.Text, IDL.Vec(IDL.Nat16)],
    ).args,
  ).toEqual(["00ff", [0, 255]]);
});

test("binary markers materialize through optional Candid fields", () => {
  const requestType = IDL.Record({
    client_token: IDL.Opt(blobType),
    title: IDL.Text,
  });
  const token = [1, 2, 3, 4];
  const materialized = materializeSelfCallArguments(
    [{ client_token: null, title: "shared file" }],
    [wireBlob([0, "client_token"], token)],
    [requestType],
  );

  expect(materialized.args).toEqual([
    {
      client_token: new Uint8Array(token),
      title: "shared file",
    },
  ]);
  expect(materialized.boundBlobs).toHaveLength(1);
});

test("self-call JavaScript conversion fails closed on metaproperty labels", () => {
  const hazardous = IDL.Record(
    Object.fromEntries([
      ["__proto__", IDL.Text],
      ["constructor", IDL.Text],
    ]),
  );
  expect(() => assertSelfCallJavaScriptTypeSafety([hazardous])).toThrow(
    /metaproperty record labels/,
  );
  const service = IDL.Service({
    hazardous: IDL.Func([], [hazardous], ["query"]),
  });
  expect(() =>
    requireSelfCallCandidMethod(service, "hazardous", "query"),
  ).toThrow(/metaproperty record labels/);
});

test("marker-bearing branches reject unknown fields and misplaced markers", () => {
  const requestType = IDL.Record({
    body: blobType,
    metadata: IDL.Record({ title: IDL.Text }),
  });

  expect(() =>
    materializeSelfCallArguments(
      [{ body: null, metadata: { title: "ok" }, surprise: true }],
      [wireBlob([0, "body"], [1])],
      [requestType],
    ),
  ).toThrow(/unknown field/);

  expect(() =>
    materializeSelfCallArguments(
      [{ body: [1], metadata: { title: null } }],
      [wireBlob([0, "metadata", "title"], [1])],
      [requestType],
    ),
  ).toThrow(/non-blob Candid position/);

  expect(() =>
    materializeSelfCallArguments(
      [{ body: null, metadata: { title: "ok" } }],
      [
        wireBlob([0, "body"], [1]),
        wireBlob([0, "body"], [2]),
      ],
      [requestType],
    ),
  ).toThrow(/paths must be unique/);
});

test("wire binary parsing rejects ambiguous objects and reports aggregates", () => {
  const parsed = parseSelfCallWireBlobs([
    wireBlob([0, "first"], [1, 2]),
    wireBlob([0, "second"], [3]),
  ]);
  expect(selfCallBlobStats(parsed)).toEqual({ count: 2, bytes: 3 });

  const extra = {
    ...wireBlob([0, "body"], [1]),
    unexpected: true,
  };
  expect(() => parseSelfCallWireBlobs([extra])).toThrow(
    /Invalid self-call binary field/,
  );

  const sparsePath = new Array(2);
  sparsePath[1] = "body";
  expect(() =>
    parseSelfCallWireBlobs([
      {
        path: sparsePath,
        byteLength: 0,
        data: new ArrayBuffer(0),
      },
    ]),
  ).toThrow(/Invalid self-call binary field/);
});

test("raw request and reply preflight meters all nested blob leaves", () => {
  const nestedType = IDL.Record({
    primary: blobType,
    records: IDL.Vec(IDL.Record({ data: blobType })),
    maybe: IDL.Opt(blobType),
  });
  const value = {
    primary: Uint8Array.from([1, 2]),
    records: [
      { data: Uint8Array.from([3]) },
      { data: Uint8Array.from([4, 5, 6]) },
    ],
    maybe: [Uint8Array.from([7, 8, 9, 10])],
  };
  const bytes = encode([nestedType], [value]);

  expect(preflightSelfCallRequest(bytes, [nestedType])).toMatchObject({
    blobCount: 4,
    blobBytes: 10,
  });
  expect(preflightSelfCallReply(bytes, nestedType)).toMatchObject({
    blobCount: 4,
    blobBytes: 10,
  });

  const trailing = new Uint8Array(bytes.byteLength + 1);
  trailing.set(bytes);
  expect(() => preflightSelfCallReply(trailing, nestedType)).toThrow(
    /trailing data/,
  );
});

test("raw preflight enforces binary field-count and aggregate-byte limits", () => {
  const repeatedType = IDL.Vec(IDL.Record({ data: blobType }));
  const tooMany = Array.from({ length: SELF_CALL_BINARY_MAX_COUNT + 1 }, () => ({
    data: new Uint8Array(0),
  }));
  const countBomb = encode([repeatedType], [tooMany]);
  expect(() => preflightSelfCallRequest(countBomb, [repeatedType])).toThrow(
    /binary field count limit/,
  );
  expect(() => preflightSelfCallReply(countBomb, repeatedType)).toThrow(
    /binary field count limit/,
  );

  const oversized = encode(
    [blobType],
    [new Uint8Array(SELF_CALL_BINARY_MAX_BYTES + 1)],
  );
  expect(() => preflightSelfCallRequest(oversized, [blobType])).toThrow(
    /binary field length|aggregate binary byte limit/,
  );
  expect(() => preflightSelfCallReply(oversized, blobType)).toThrow(
    /binary field length|aggregate binary byte limit/,
  );
});

test("raw request byte accounting excludes bounded binary payload bytes", () => {
  expect(() =>
    assertSelfCallRawRequestBytes(
      SELF_CALL_BINARY_MAX_BYTES + SELF_CALL_NON_BINARY_CANDID_MAX_BYTES,
      SELF_CALL_BINARY_MAX_BYTES,
    ),
  ).not.toThrow();
  expect(() =>
    assertSelfCallRawRequestBytes(
      SELF_CALL_BINARY_MAX_BYTES +
        SELF_CALL_NON_BINARY_CANDID_MAX_BYTES +
        1,
      SELF_CALL_BINARY_MAX_BYTES,
    ),
  ).toThrow(/raw metadata limit/);
  expect(() => assertSelfCallRawRequestBytes(1, 2)).toThrow(
    /raw metadata limit/,
  );
});

test("self-call result normalization preserves blobs and Candid boundary shape", () => {
  const payloadType = IDL.Record({
    body: blobType,
    optional: IDL.Opt(blobType),
    count: IDL.Nat64,
  });
  const resultType = IDL.Variant({
    ok: payloadType,
    err: IDL.Variant({ denied: IDL.Null }),
  });
  const body = Uint8Array.from([1, 2, 3]);
  const optional = Uint8Array.from([4, 5]);
  expect(
    normalizeSelfCallResult(
      { ok: { body, optional: [optional], count: 42n } },
      resultType,
    ),
  ).toEqual({
    body,
    optional,
    count: "42",
  });
  expect(normalizeSelfCallResult(body.buffer, blobType)).toEqual(body);
  expect(() => normalizeSelfCallResult([1, 2, 3], blobType)).toThrow(
    /Invalid decoded Candid blob/,
  );
  expect(() => normalizeSelfCallResult("010203", blobType)).toThrow(
    /Invalid decoded Candid blob/,
  );
});

{
  const optionalText = IDL.Opt(IDL.Text);
  const recordType = IDL.Record({
    label: IDL.Text,
    omitted: optionalText,
  });
  const vectorType = IDL.Vec(optionalText);
  const tupleType = IDL.Tuple(optionalText, IDL.Nat64);
  const variantType = IDL.Variant({
    omitted: optionalText,
    ready: IDL.Null,
  });
  const resultType = IDL.Variant({
    Ok: optionalText,
    Err: IDL.Text,
  });
  const cases: Array<{
    name: string;
    value: unknown;
    type: IDL.Type;
    expected: unknown;
  }> = [
    {
      name: "top-level absent option",
      value: [],
      type: optionalText,
      expected: null,
    },
    {
      name: "absent option in a record",
      value: { label: "kept", omitted: [] },
      type: recordType,
      expected: { label: "kept" },
    },
    {
      name: "absent option in a vector",
      value: [[], ["kept"]],
      type: vectorType,
      expected: [null, "kept"],
    },
    {
      name: "absent option in a tuple",
      value: [[], 7n],
      type: tupleType,
      expected: [null, "7"],
    },
    {
      name: "absent option selected as a variant payload",
      value: { omitted: [] },
      type: variantType,
      expected: {},
    },
    {
      name: "absent option selected as Result Ok",
      value: { Ok: [] },
      type: resultType,
      expected: null,
    },
  ];

  for (const fixture of cases) {
    test(`API-1 projection preserves ${fixture.name}`, () => {
      expect(projectSelfCallResult(fixture.value, fixture.type)).toEqual(
        fixture.expected as never,
      );
    });
  }
}

test("API-1 projection renders principals and bigints as text", () => {
  const outputType = IDL.Record({
    owner: IDL.Principal,
    balance: IDL.Nat,
    delta: IDL.Int,
  });
  const value = {
    owner: Principal.fromText("aaaaa-aa"),
    balance: 12_345_678_901_234_567_890n,
    delta: -42n,
  };
  const expected = {
    owner: "aaaaa-aa",
    balance: "12345678901234567890",
    delta: "-42",
  };

  expect(projectSelfCallResult(value, outputType)).toEqual(expected);
});

test("generic projection never reinterprets a record with an optional blob", () => {
  const referenceType = IDL.Record({
    source: IDL.Principal,
    digest: IDL.Opt(blobType),
  });
  const source = Principal.fromText("aaaaa-aa");
  const arbitraryBytes = new Uint8Array(31);

  expect(projectSelfCallResult({ source, digest: [] }, referenceType)).toEqual(
    { source: "aaaaa-aa" },
  );
  const projected = normalizeSelfCallResult(
    { source, digest: [arbitraryBytes] },
    referenceType,
  );
  expect(projected).toEqual({
    source: "aaaaa-aa",
    digest: arbitraryBytes,
  });
  const encoded = encodeSelfCallResult(projected);
  expect(encoded.value).toEqual({
    source: "aaaaa-aa",
    digest: null,
  });
  expect(encoded.blobs).toHaveLength(1);
  expect(encoded.blobs[0]).toMatchObject({
    path: ["digest"],
    byteLength: 31,
  });
});

test("empty blobs preserve the one native sidecar convention", () => {
  const empty = new Uint8Array(0);
  const rematerialized = materializeSelfCallArguments(
    [null],
    [wireBlob([0], empty)],
    [blobType],
  ).args[0];
  expect(rematerialized).toBeInstanceOf(Uint8Array);
  expect(rematerialized).toEqual(empty);

  const normalized = normalizeSelfCallResult(empty, blobType);
  expect(normalized).toBeInstanceOf(Uint8Array);
  expect(normalized).toEqual(empty);
  const encoded = encodeSelfCallResult(normalized);
  expect(encoded.value).toBeNull();
  expect(encoded.blobs).toHaveLength(1);
  expect(encoded.blobs[0]).toMatchObject({
    path: [],
    byteLength: 0,
  });
  expect(new Uint8Array(encoded.blobs[0]!.data)).toEqual(empty);
});

test("native result projection owns binary leaves and is prototype-safe", () => {
  const recordType = IDL.Record(
    Object.fromEntries([
      ["__proto__", IDL.Text],
      ["constructor", IDL.Text],
      ["body", blobType],
    ]),
  );
  const recordValue = Object.fromEntries([
    ["__proto__", "safe-prototype-field"],
    ["constructor", "safe-constructor-field"],
    ["body", Uint8Array.from([0, 255, 7])],
  ]);
  const projected = normalizeSelfCallResult(recordValue, recordType);
  expect(Object.hasOwn(projected as object, "__proto__")).toBe(true);
  expect(Object.hasOwn(projected as object, "constructor")).toBe(true);
  expect(projected).toEqual(
    Object.fromEntries([
      ["__proto__", "safe-prototype-field"],
      ["constructor", "safe-constructor-field"],
      ["body", Uint8Array.from([0, 255, 7])],
    ]),
  );
});

test("self-call result encoding extracts multiple immutable binary leaves", () => {
  const source = Uint8Array.from([1, 2, 3]);
  const encoded = encodeSelfCallResult({
    body: source,
    nested: [{ preview: Uint8Array.from([4, 5]) }],
    status: "ready",
  });

  expect(encoded.value).toEqual({
    body: null,
    nested: [{ preview: null }],
    status: "ready",
  });
  expect(
    encoded.blobs.map(({ path, byteLength }) => ({ path, byteLength })),
  ).toEqual([
    { path: ["body"], byteLength: 3 },
    { path: ["nested", 0, "preview"], byteLength: 2 },
  ]);
  source[0] = 99;
  expect(new Uint8Array(encoded.blobs[0]!.data)).toEqual(
    Uint8Array.from([1, 2, 3]),
  );
});

test("trusted binary inspection exposes exact path, size, and SHA-256 transiently", async () => {
  const [inspection] = await inspectBoundSelfCallBlobs([
    wireBlob([0, "nested", "not simple", 2], [1, 2, 3]),
  ]);
  expect(inspection).toEqual({
    path: 'args[0].nested["not simple"][2]',
    pathSegments: [0, "nested", "not simple", 2],
    byteLength: 3,
    sha256:
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
  });
});

test("self-call reservations cover request, raw reply, and decoder allocation", () => {
  expect(selfCallReservationBytes(123)).toBe(
    123 +
      SELF_CALL_BINARY_MAX_BYTES +
      SELF_CALL_NON_BINARY_CANDID_MAX_BYTES +
      SELF_CALL_CANDID_DECODER_ALLOCATION_MAX_BYTES,
  );
  expect(() => selfCallReservationBytes(-1)).toThrow(
    /Invalid self-call binary reservation/,
  );
  expect(() =>
    selfCallReservationBytes(SELF_CALL_BINARY_MAX_BYTES + 1),
  ).toThrow(/Invalid self-call binary reservation/);
});
