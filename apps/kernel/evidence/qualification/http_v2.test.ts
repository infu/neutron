import { describe, expect, test } from "bun:test";
import {
  Cbor,
  reconstruct,
  type HashTree,
  type HttpAgent,
} from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { bls12_381 } from "@noble/curves/bls12-381";
import { createHash } from "node:crypto";
import {
  HOST_BOUND_CERTIFICATION_EXPRESSION,
  assertHostileRangeRejected,
  exactBytes,
  exactExpressionPath,
  fetchAndVerifyCertifiedHttp,
  portableAbsenceHeaders,
  portableHeaders,
  publicationHeaders,
  verifyCertifiedHttpQueryResponse,
  wildcardExpressionPath,
  type CertifiedHttpQueryRequest,
  type CertifiedHttpQueryResponse,
  type ExpectedCertifiedHttpResponse,
} from "./http_v2.ts";

const CANISTER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const URL_TEXT =
  `http://${CANISTER_ID}.localhost:8000/app/fixture/_route/publication/post`;
const BODY = Uint8Array.of(1, 2, 3);
const CONTENT_TAG = new Uint8Array(32).fill(0x44);
const BLS_DER_PREFIX = new Uint8Array(Buffer.from(
  "308182301d060d2b0601040182dc7c0503010201060c2b0601040182dc7c05030201036100",
  "hex",
));

type DelegationFixture = Readonly<{
  format: "flat" | "tree";
  authorizeCanister?: boolean;
}>;

function expected(
  patch: Partial<ExpectedCertifiedHttpResponse> = {},
): ExpectedCertifiedHttpResponse {
  return {
    canisterId: CANISTER_ID,
    url: URL_TEXT,
    method: "GET",
    status: 200,
    authority: "host_bound",
    expressionPath: exactExpressionPath(new URL(URL_TEXT).pathname),
    headers: publicationHeaders({
      contentTag: CONTENT_TAG,
      contentLength: BODY.byteLength,
    }),
    body: BODY,
    ...patch,
  };
}

function raw(
  patch: Partial<CertifiedHttpQueryResponse> = {},
): CertifiedHttpQueryResponse {
  return {
    body: BODY,
    headers: [
      ...publicationHeaders({
        contentTag: CONTENT_TAG,
        contentLength: BODY.byteLength,
      }),
      [
        "IC-Certificate",
        "certificate=:AQ==:, tree=:AQ==:, expr_path=:AQ==:, version=2",
      ],
    ],
    streaming_strategy: [],
    status_code: 200,
    upgrade: [],
    ...patch,
  };
}

function rawRequest(
  patch: Partial<CertifiedHttpQueryRequest> = {},
): CertifiedHttpQueryRequest {
  return {
    method: "GET",
    url: new URL(URL_TEXT).pathname,
    headers: [["Host", new URL(URL_TEXT).host]],
    body: new Uint8Array(),
    certificate_version: [2],
    ...patch,
  };
}

async function validProofFixture(
  nowNs = BigInt(Date.now()) * 1_000_000n,
  wanted = expected(),
  delegation?: DelegationFixture,
): Promise<Readonly<{
  rootKey: Uint8Array;
  response: CertifiedHttpQueryResponse;
}>> {
  const expression = wanted.headers.find(
    ([name]) => name === "IC-CertificateExpression",
  )?.[1];
  if (expression === undefined) {
    throw new Error("Proof fixture lacks its certification expression");
  }
  const expressionHash = sha256(new TextEncoder().encode(expression));
  const requestHash = requestHashV2("GET", [
    ...(wanted.authority === "host_bound"
      ? [["host", new URL(wanted.url).host] as const]
      : []),
  ]);
  const responseHash = responseHashV2(
    wanted.status,
    wanted.headers,
    sha256(wanted.body),
  );
  const witness = labeledTree([
    ...wanted.expressionPath,
    expressionHash,
    requestHash,
    responseHash,
  ]);
  const certifiedData = await reconstruct(witness);
  const principal = Principal.fromText(CANISTER_ID);
  const certificateTree = [
    1,
    [
      2,
      new TextEncoder().encode("canister"),
      [
        2,
        principal.toUint8Array(),
        [
          2,
          new TextEncoder().encode("certified_data"),
          [3, certifiedData],
        ],
      ],
    ],
    [
      2,
      new TextEncoder().encode("time"),
      [3, unsignedLeb128(nowNs)],
    ],
  ] as unknown as HashTree;
  const rootPrivateKey = blsPrivateKey(7);
  const subnetPrivateKey = blsPrivateKey(9);
  const certificateFields: {
    tree: HashTree;
    signature: Uint8Array;
    delegation?: {
      subnet_id: Uint8Array;
      certificate: Uint8Array;
    };
  } = {
    tree: certificateTree,
    signature: await signCertificateTree(
      certificateTree,
      delegation === undefined ? rootPrivateKey : subnetPrivateKey,
    ),
  };
  if (delegation !== undefined) {
    const subnetId = Principal.fromUint8Array(
      Uint8Array.of(0x51, 0x55, 0x41, 0x4c, 0x01),
    );
    const rangePrincipal = delegation.authorizeCanister === false
      ? Principal.fromUint8Array(Uint8Array.of(0x01))
      : principal;
    const rangePrincipalBytes = rangePrincipal.toUint8Array();
    const encodedRanges = cbor([
      [rangePrincipalBytes, rangePrincipalBytes],
    ]);
    const subnetPublicKey = derPublicKey(subnetPrivateKey);
    const subnetTree = delegation.format === "flat"
      ? treeFork(
        treeLabel(
          "subnet",
          treeLabel(
            subnetId.toUint8Array(),
            treeFork(
              treeLabel("canister_ranges", treeLeaf(encodedRanges)),
              treeLabel("public_key", treeLeaf(subnetPublicKey)),
            ),
          ),
        ),
        treeLabel("time", treeLeaf(unsignedLeb128(nowNs))),
      )
      : treeFork(
        treeLabel(
          "canister_ranges",
          treeLabel(
            subnetId.toUint8Array(),
            treeLabel(
              rangePrincipalBytes,
              treeLeaf(encodedRanges),
            ),
          ),
        ),
        treeFork(
          treeLabel(
            "subnet",
            treeLabel(
              subnetId.toUint8Array(),
              treeLabel("public_key", treeLeaf(subnetPublicKey)),
            ),
          ),
          treeLabel("time", treeLeaf(unsignedLeb128(nowNs))),
        ),
      );
    certificateFields.delegation = {
      subnet_id: subnetId.toUint8Array(),
      certificate: cbor({
        tree: subnetTree,
        signature: await signCertificateTree(subnetTree, rootPrivateKey),
      }),
    };
  }
  const rootKey = derPublicKey(rootPrivateKey);
  const certificate = cbor(certificateFields);
  const witnessCbor = cbor(witness);
  const expressionPathCbor = cbor(wanted.expressionPath);
  const proofHeader = [
    `certificate=:${Buffer.from(certificate).toString("base64")}:`,
    `tree=:${Buffer.from(witnessCbor).toString("base64")}:`,
    `expr_path=:${Buffer.from(expressionPathCbor).toString("base64")}:`,
    "version=2",
  ].join(", ");
  return {
    rootKey,
    response: {
      body: wanted.body,
      headers: [...wanted.headers, ["IC-Certificate", proofHeader]],
      streaming_strategy: [],
      status_code: wanted.status,
      upgrade: [],
    },
  };
}

function blsPrivateKey(lastByte: number): Uint8Array {
  const key = new Uint8Array(32);
  key[31] = lastByte;
  return key;
}

function derPublicKey(privateKey: Uint8Array): Uint8Array {
  return concat(
    BLS_DER_PREFIX,
    bls12_381.getPublicKeyForShortSignatures(privateKey),
  );
}

async function signCertificateTree(
  tree: HashTree,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  const root = await reconstruct(tree);
  return bls12_381.signShortSignature(
    concat(
      Uint8Array.of("ic-state-root".length),
      new TextEncoder().encode("ic-state-root"),
      root,
    ),
    privateKey,
  );
}

function treeFork(left: HashTree, right: HashTree): HashTree {
  return [1, left, right] as HashTree;
}

function treeLabel(
  label: string | Uint8Array,
  tree: HashTree,
): HashTree {
  return [
    2,
    typeof label === "string" ? new TextEncoder().encode(label) : label,
    tree,
  ] as unknown as HashTree;
}

function treeLeaf(value: Uint8Array): HashTree {
  return [3, value] as unknown as HashTree;
}

function labeledTree(
  path: readonly (string | Uint8Array)[],
): HashTree {
  let tree = [3, new Uint8Array()] as unknown as HashTree;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const label = path[index]!;
    tree = [
      2,
      typeof label === "string"
        ? new TextEncoder().encode(label)
        : label,
      tree,
    ] as unknown as HashTree;
  }
  return tree;
}

function requestHashV2(
  method: string,
  headers: readonly (readonly [string, string])[],
): Uint8Array {
  return sha256(concat(
    independentHash([
      ...headers.map(([name, value]) =>
        [name.toLowerCase(), { string: value }] as const
      ),
      [":ic-cert-method", { string: method }] as const,
    ]),
    sha256(new Uint8Array()),
  ));
}

function responseHashV2(
  status: number,
  headers: readonly (readonly [string, string])[],
  bodyHash: Uint8Array,
): Uint8Array {
  return sha256(concat(
    independentHash([
      ...headers.map(([name, value]) =>
        [name.toLowerCase(), { string: value }] as const
      ),
      [":ic-cert-status", { nat: BigInt(status) }] as const,
    ]),
    bodyHash,
  ));
}

function independentHash(
  entries: readonly (
    readonly [string, { readonly string: string } | { readonly nat: bigint }]
  )[],
): Uint8Array {
  const values = entries.map(([name, value], index) => ({
    key: sha256(new TextEncoder().encode(name)),
    value: "string" in value
      ? sha256(new TextEncoder().encode(value.string))
      : sha256(unsignedLeb128(value.nat)),
    index,
  }));
  values.sort((left, right) =>
    Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)) ||
    left.index - right.index
  );
  return sha256(concat(
    ...values.flatMap(({ key, value }) => [key, value]),
  ));
}

function unsignedLeb128(value: bigint): Uint8Array {
  const result: number[] = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) byte |= 0x80;
    result.push(byte);
  } while (value !== 0n);
  return Uint8Array.from(result);
}

function cbor(value: unknown): Uint8Array {
  return new Uint8Array(Cbor.encode(value));
}

function sha256(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    values.reduce((sum, value) => sum + value.byteLength, 0),
  );
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function replaceProofField(
  response: CertifiedHttpQueryResponse,
  field: "certificate" | "tree" | "expr_path",
  transform: (bytes: Uint8Array) => Uint8Array,
): CertifiedHttpQueryResponse {
  return {
    ...response,
    headers: response.headers.map(([name, value]) => {
      if (name !== "IC-Certificate") return [name, value] as const;
      const pattern = new RegExp(`${field}=:([A-Za-z0-9+/]*={0,2}):`, "u");
      const match = pattern.exec(value);
      if (match === null) throw new Error(`Missing ${field} proof fixture`);
      const changed = Buffer.from(
        transform(new Uint8Array(Buffer.from(match[1]!, "base64"))),
      ).toString("base64");
      return [
        name,
        value.replace(pattern, `${field}=:${changed}:`),
      ] as const;
    }),
  };
}

describe("Certified HTTP V2 qualification verifier", () => {
  test("records bytes as a bounded digest summary, never embedded base64", () => {
    expect(exactBytes(new Uint8Array(8))).toEqual({
      bytes: 8,
      sha256: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
    });
  });

  test("accepts a real signed proof and rejects cryptographic and CBOR tampering", async () => {
    const fixture = await validProofFixture();
    const observation = await verifyCertifiedHttpQueryResponse(
      expected(),
      fixture.rootKey,
      rawRequest(),
      fixture.response,
    );
    expect(observation.boundary).toBe("raw_query");
    expect(observation.body).toEqual(exactBytes(BODY));
    expect(observation.certificate.bytes).toBeGreaterThan(0);
    expect(observation.witness.bytes).toBeGreaterThan(0);

    const wrongRoot = fixture.rootKey.slice();
    wrongRoot[wrongRoot.length - 1] =
      wrongRoot[wrongRoot.length - 1]! ^ 1;
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        wrongRoot,
        rawRequest(),
        fixture.response,
      ),
    ).rejects.toThrow();

    const tamperedCertificate = replaceProofField(
      fixture.response,
      "certificate",
      (bytes) => {
        const decoded = Cbor.decode<{
          tree: HashTree;
          signature: Uint8Array;
        }>(bytes);
        const signature = decoded.signature.slice();
        signature[0] = signature[0]! ^ 1;
        return cbor({ tree: decoded.tree, signature });
      },
    );
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        fixture.rootKey,
        rawRequest(),
        tamperedCertificate,
      ),
    ).rejects.toThrow();

    const trailingWitness = replaceProofField(
      fixture.response,
      "tree",
      (bytes) => concat(bytes, Uint8Array.of(0x80)),
    );
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        fixture.rootKey,
        rawRequest(),
        trailingWitness,
      ),
    ).rejects.toThrow("trailing CBOR bytes");

    const tooDeepExpression = replaceProofField(
      fixture.response,
      "expr_path",
      () => concat(
        Uint8Array.of(0xd9, 0xd9, 0xf7),
        new Uint8Array(130).fill(0x81),
        Uint8Array.of(0x80),
      ),
    );
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        fixture.rootKey,
        rawRequest(),
        tooDeepExpression,
      ),
    ).rejects.toThrow("CBOR depth bound");
  });

  test("accepts delegated Flat and Tree canister-range certificates", async () => {
    for (const format of ["flat", "tree"] as const) {
      const fixture = await validProofFixture(
        BigInt(Date.now()) * 1_000_000n,
        expected(),
        { format },
      );
      await expect(
        verifyCertifiedHttpQueryResponse(
          expected(),
          fixture.rootKey,
          rawRequest(),
          fixture.response,
        ),
      ).resolves.toMatchObject({ boundary: "raw_query" });
    }
  });

  test("rejects a Tree delegation whose shard excludes the canister", async () => {
    const fixture = await validProofFixture(
      BigInt(Date.now()) * 1_000_000n,
      expected(),
      { format: "tree", authorizeCanister: false },
    );
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        fixture.rootKey,
        rawRequest(),
        fixture.response,
      ),
    ).rejects.toThrow(
      "does not include the canister",
    );
  });

  test("uses the synchronized PocketIC agent after replica-time advance", async () => {
    const oneDayMs = 24 * 60 * 60 * 1_000;
    const future = await validProofFixture(
      BigInt(Date.now() + oneDayMs) * 1_000_000n,
    );
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        future.rootKey,
        rawRequest(),
        future.response,
      ),
    ).rejects.toThrow();
    const synchronizedAgent = {
      getTimeDiffMsecs: () => oneDayMs,
      hasSyncedTime: () => true,
      syncTime: async () => undefined,
    } as unknown as HttpAgent;
    const observation = await verifyCertifiedHttpQueryResponse(
      expected(),
      future.rootKey,
      rawRequest(),
      future.response,
      synchronizedAgent,
    );
    expect(observation.boundary).toBe("raw_query");
  });

  test("supports host-bound query aliases and canonical empty terminal segments", async () => {
    expect(exactExpressionPath("/")).toEqual(["http_expr", "", "<$>"]);
    expect(exactExpressionPath("/path/")).toEqual([
      "http_expr",
      "path",
      "",
      "<$>",
    ]);

    const fixture = await validProofFixture();
    const queryUrl = `${URL_TEXT}?download=1`;
    const observation = await verifyCertifiedHttpQueryResponse(
      expected({ url: queryUrl }),
      fixture.rootKey,
      rawRequest({ url: `${new URL(URL_TEXT).pathname}?download=1` }),
      fixture.response,
    );
    expect(observation.url).toBe(queryUrl);

    const portableUrl =
      `http://${CANISTER_ID}.localhost:8000/app/fixture/_route/blob/missing?alias=1`;
    await expect(
      fetchAndVerifyCertifiedHttp(
        {
          canisterId: CANISTER_ID,
          url: portableUrl,
          method: "GET",
          status: 404,
          authority: "portable",
          expressionPath: wildcardExpressionPath(
            "/app/fixture/_route/blob",
          ),
          headers: portableAbsenceHeaders(),
          body: new Uint8Array(),
        },
        fixture.rootKey,
      ),
    ).rejects.toThrow("reject query aliases");
  });

  test("uses the certified install-target path contract", () => {
    const fourteenSegments = `/${Array.from({ length: 14 }, (_, index) =>
      `s${index}`
    ).join("/")}`;
    const fifteenSegments = `${fourteenSegments}/overflow`;

    expect(exactExpressionPath(fourteenSegments)).toHaveLength(16);
    expect(exactExpressionPath(`${fourteenSegments}/`)).toHaveLength(17);
    expect(() => exactExpressionPath(fifteenSegments)).toThrow(
      "Certified HTTP path is not canonical",
    );
    expect(() => exactExpressionPath("/control\u0001path")).toThrow(
      "Certified HTTP path is not canonical",
    );
    expect(() => exactExpressionPath("/delete\u007fpath")).toThrow(
      "Certified HTTP path is not canonical",
    );
  });

  test("bounds gateway materialization and snapshots mutable trust inputs", async () => {
    const fixture = await validProofFixture();
    let release!: (response: Response) => void;
    const responsePromise = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const gatewayFetch = (async () => responsePromise) as unknown as typeof fetch;
    const mutableBody = BODY.slice();
    const mutableHeaders = expected().headers.map(
      ([name, value]) => [name, value] as [string, string],
    );
    const mutableExpected = expected({
      body: mutableBody,
      headers: mutableHeaders,
    });
    const mutableRoot = fixture.rootKey.slice();
    const pending = fetchAndVerifyCertifiedHttp(
      mutableExpected,
      mutableRoot,
      gatewayFetch,
    );

    mutableBody[0] = 0xff;
    mutableHeaders[0]![1] = "application/json";
    mutableRoot[mutableRoot.length - 1] =
      mutableRoot[mutableRoot.length - 1]! ^ 1;
    release(new Response(BODY, {
      status: 200,
      headers: fixture.response.headers as [string, string][],
    }));
    const observation = await pending;
    expect(observation.boundary).toBe("gateway");
    expect(observation.body).toEqual(exactBytes(BODY));

    const oversizedFetch = (async () =>
      new Response(Uint8Array.of(1, 2, 3, 4), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyCertifiedHttp(
        expected(),
        fixture.rootKey,
        oversizedFetch,
      ),
    ).rejects.toThrow("exceeds expected length");
  });

  test("accepts the pinned PocketIC gateway expose-header rewrite after exact raw verification", async () => {
    const portableUrl =
      `http://${CANISTER_ID}.localhost:8000/app/fixture/_route/blob/object`;
    const wanted = expected({
      url: portableUrl,
      authority: "portable",
      expressionPath: exactExpressionPath(new URL(portableUrl).pathname),
      headers: portableHeaders({
        kind: "immutable_blob",
        body: BODY,
      }),
    });
    const fixture = await validProofFixture(
      BigInt(Date.now()) * 1_000_000n,
      wanted,
    );
    const gatewayHeaders = fixture.response.headers.map(([name, value]) =>
      name === "Access-Control-Expose-Headers"
        ? [
          name,
          "accept-ranges,content-length,content-range,x-request-id,x-ic-canister-id",
        ] as const
        : [name, value] as const
    );
    const gatewayFetch = (async () =>
      new Response(BODY, {
        status: 200,
        headers: gatewayHeaders as [string, string][],
      })) as unknown as typeof fetch;

    await expect(
      verifyCertifiedHttpQueryResponse(
        wanted,
        fixture.rootKey,
        {
          method: "GET",
          url: new URL(portableUrl).pathname,
          headers: [["Host", new URL(portableUrl).host]],
          body: new Uint8Array(),
          certificate_version: [2],
        },
        fixture.response,
      ),
    ).resolves.toMatchObject({ boundary: "raw_query" });
    await expect(
      fetchAndVerifyCertifiedHttp(
        wanted,
        fixture.rootKey,
        gatewayFetch,
      ),
    ).resolves.toMatchObject({ boundary: "gateway" });
  });

  test("retries only a bounded PocketIC gateway 503 before exact verification", async () => {
    const fixture = await validProofFixture();
    let attempts = 0;
    const transientGateway = (async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("certified state unavailable", { status: 503 })
        : new Response(BODY, {
            status: 200,
            headers: fixture.response.headers as [string, string][],
          });
    }) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyCertifiedHttp(
        expected(),
        fixture.rootKey,
        transientGateway,
      ),
    ).resolves.toMatchObject({ boundary: "gateway" });
    expect(attempts).toBe(2);

    let non503Attempts = 0;
    const failedGateway = (async () => {
      non503Attempts += 1;
      return new Response("bad gateway", {
        status: 502,
        headers: { "x-ic-error-cause": "upstream rejected" },
      });
    }) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyCertifiedHttp(
        expected(),
        fixture.rootKey,
        failedGateway,
      ),
    ).rejects.toThrow(
      'returned 502, expected 200 (cause="upstream rejected", body="bad gateway")',
    );
    expect(non503Attempts).toBe(1);
  });

  test("rejects raw streaming and upgrade responses before proof parsing", async () => {
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        new Uint8Array(32),
        rawRequest(),
        raw({ streaming_strategy: [{ Callback: {} }] }),
      ),
    ).rejects.toThrow("must not stream");
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        new Uint8Array(32),
        rawRequest(),
        raw({ upgrade: [true] }),
      ),
    ).rejects.toThrow("must not upgrade");
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        new Uint8Array(32),
        rawRequest(),
        raw({ upgrade: [false] }),
      ),
    ).rejects.toThrow("must not upgrade");
  });

  test("binds the raw Candid request to V2, path, and Host", async () => {
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        new Uint8Array(32),
        rawRequest({
          headers: [["Host", "wrong.localhost:8000"]],
        }),
        raw(),
      ),
    ).rejects.toThrow("exact Host");
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        new Uint8Array(32),
        rawRequest({ certificate_version: [] }),
        raw(),
      ),
    ).rejects.toThrow("exact V2 request");
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        new Uint8Array(32),
        rawRequest({ url: "/different" }),
        raw(),
      ),
    ).rejects.toThrow("exact V2 request");
  });

  test("rejects a mismatched or repeated Host before transport", async () => {
    let calls = 0;
    const unreachable = (async () => {
      calls += 1;
      throw new Error("transport must not run");
    }) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyCertifiedHttp(
        expected({ requestHeaders: [["Host", "wrong.localhost:8000"]] }),
        new Uint8Array(32),
        unreachable,
      ),
    ).rejects.toThrow("Host does not match");
    await expect(
      fetchAndVerifyCertifiedHttp(
        expected({
          requestHeaders: [
            ["Host", new URL(URL_TEXT).host],
            ["host", new URL(URL_TEXT).host],
          ],
        }),
        new Uint8Array(32),
        unreachable,
      ),
    ).rejects.toThrow("repeats Host");
    expect(calls).toBe(0);
  });

  test("dials only the isolated loopback transport while retaining certified Host", async () => {
    const marker = new Error("captured isolated transport");
    let seenUrl = "";
    let seenHost: string | null = null;
    const capture = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seenUrl = String(input);
      seenHost = new Headers(init?.headers).get("Host");
      throw marker;
    }) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyCertifiedHttp(
        expected(),
        new Uint8Array(32),
        capture,
        undefined,
        "http://127.0.0.2:8000",
      ),
    ).rejects.toBe(marker);
    expect(seenUrl).toBe(
      "http://127.0.0.2:8000/app/fixture/_route/publication/post",
    );
    expect(String(seenHost)).toBe(new URL(URL_TEXT).host);

    await expect(
      fetchAndVerifyCertifiedHttp(
        expected(),
        new Uint8Array(32),
        capture,
        undefined,
        "http://127.0.0.1:8000",
      ),
    ).rejects.toThrow("isolated loopback");
  });

  test("accepts only the closed hostile-Range rejection", () => {
    const rejection: CertifiedHttpQueryResponse = {
      body: new Uint8Array(),
      headers: [["Cache-Control", "no-store"]],
      streaming_strategy: [],
      status_code: 400,
      upgrade: [],
    };
    expect(() =>
      assertHostileRangeRejected({
        url: URL_TEXT,
        request: rawRequest({
          headers: [
            ["Host", new URL(URL_TEXT).host],
            ["Range", "bytes=0-1,4-5"],
          ],
        }),
        response: rejection,
      })
    ).not.toThrow();
    expect(() =>
      assertHostileRangeRejected({
        url: URL_TEXT,
        request: rawRequest({
          headers: [
            ["Host", new URL(URL_TEXT).host],
            ["Range", "bytes=0-"],
          ],
        }),
        response: rejection,
      })
    ).toThrow("not a hostile");
    expect(() =>
      assertHostileRangeRejected({
        url: URL_TEXT,
        request: rawRequest({
          headers: [
            ["Host", new URL(URL_TEXT).host],
            ["Range", "bytes=-1"],
          ],
        }),
        response: {
          ...rejection,
          streaming_strategy: [{}],
        },
      })
    ).toThrow("must not stream");
    expect(() =>
      assertHostileRangeRejected({
        url: URL_TEXT,
        request: rawRequest({
          headers: [
            ["Host", new URL(URL_TEXT).host],
            ["Range", "bytes=-1"],
          ],
        }),
        response: {
          ...rejection,
          headers: [
            ["Cache-Control", "no-store"],
            ["IC-CertificateExpression", HOST_BOUND_CERTIFICATION_EXPRESSION],
          ],
        },
      })
    ).toThrow("closed 400");
  });

  test("rejects unsupported Range syntax before gateway transport", async () => {
    let called = false;
    const unreachable = (async () => {
      called = true;
      throw new Error("transport must not run");
    }) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyCertifiedHttp(
        expected({ requestHeaders: [["Range", "bytes=8-4"]] }),
        new Uint8Array(32),
        unreachable,
      ),
    ).rejects.toThrow("unsupported Range");
    expect(called).toBeFalse();
  });

  test("preflights range selection and wildcard absence ownership", async () => {
    const transportMarker = new Error("preflight reached transport");
    let calls = 0;
    const markerFetch = (async () => {
      calls += 1;
      throw transportMarker;
    }) as unknown as typeof fetch;
    const rangeBody = Uint8Array.of(7, 8);
    const ranged = expected({
      status: 206,
      body: rangeBody,
      requestHeaders: [["Range", "bytes=4-"]],
      headers: publicationHeaders({
        contentTag: CONTENT_TAG,
        contentLength: rangeBody.byteLength,
        contentRange: "bytes 4-5/8",
      }),
    });
    await expect(
      fetchAndVerifyCertifiedHttp(
        ranged,
        new Uint8Array(32),
        markerFetch,
      ),
    ).rejects.toBe(transportMarker);
    expect(calls).toBe(1);

    const { requestHeaders: _ignoredRange, ...firstBlock } = ranged;
    await expect(
      fetchAndVerifyCertifiedHttp(
        {
          ...firstBlock,
          headers: publicationHeaders({
            contentTag: CONTENT_TAG,
            contentLength: rangeBody.byteLength,
            contentRange: "bytes 0-1/8",
          }),
        },
        new Uint8Array(32),
        markerFetch,
      ),
    ).rejects.toBe(transportMarker);
    expect(calls).toBe(2);

    await expect(
      fetchAndVerifyCertifiedHttp(
        expected({
          method: "HEAD",
          body: new Uint8Array(),
          requestHeaders: [["Range", "bytes=4-"]],
          headers: publicationHeaders({
            contentTag: CONTENT_TAG,
            contentLength: 8,
          }),
        }),
        new Uint8Array(32),
        markerFetch,
      ),
    ).rejects.toBe(transportMarker);
    expect(calls).toBe(3);

    await expect(
      fetchAndVerifyCertifiedHttp(
        {
          ...ranged,
          requestHeaders: [["Range", "bytes=6-"]],
        },
        new Uint8Array(32),
        markerFetch,
      ),
    ).rejects.toThrow("does not bind");
    expect(calls).toBe(3);

    const absentUrl =
      `http://${CANISTER_ID}.localhost:8000/app/fixture/_route/blob/missing`;
    await expect(
      fetchAndVerifyCertifiedHttp(
        {
          canisterId: CANISTER_ID,
          url: absentUrl,
          method: "GET",
          status: 404,
          authority: "portable",
          expressionPath: wildcardExpressionPath(
            "/app/fixture/_route/blob",
          ),
          headers: portableAbsenceHeaders(),
          body: new Uint8Array(),
        },
        new Uint8Array(32),
        markerFetch,
      ),
    ).rejects.toBe(transportMarker);
    expect(calls).toBe(4);

    await expect(
      fetchAndVerifyCertifiedHttp(
        {
          canisterId: CANISTER_ID,
          url: absentUrl,
          method: "GET",
          status: 404,
          authority: "portable",
          expressionPath: wildcardExpressionPath(
            "/app/fixture/_route/blob",
          ),
          headers: portableAbsenceHeaders(),
          body: new Uint8Array(),
          requestHeaders: [["Range", "bytes=0-1,4-5"]],
        },
        new Uint8Array(32),
        markerFetch,
      ),
    ).rejects.toBe(transportMarker);
    expect(calls).toBe(5);

    await expect(
      fetchAndVerifyCertifiedHttp(
        {
          canisterId: CANISTER_ID,
          url: absentUrl,
          method: "GET",
          status: 404,
          authority: "portable",
          expressionPath: wildcardExpressionPath(
            "/app/unrelated/_route/blob",
          ),
          headers: portableAbsenceHeaders(),
          body: new Uint8Array(),
        },
        new Uint8Array(32),
        markerFetch,
      ),
    ).rejects.toThrow("wildcard does not own");
    expect(calls).toBe(5);
  });

  test("rejects duplicate proof fields and uncertified response-policy drift", async () => {
    const duplicatedProof = raw({
      headers: [
        ...publicationHeaders({
          contentTag: CONTENT_TAG,
          contentLength: BODY.byteLength,
        }),
        [
          "IC-Certificate",
          "certificate=:AQ==:, tree=:AQ==:, expr_path=:AQ==:, version=2, tree=:AQ==:",
        ],
      ],
    });
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        new Uint8Array(32),
        rawRequest(),
        duplicatedProof,
      ),
    ).rejects.toThrow("repeats tree");

    const driftedHeaders = raw({
      headers: raw().headers.map(([name, value]) =>
        name === "Cache-Control"
          ? [name, "public, max-age=60"] as const
          : [name, value] as const
      ),
    });
    await expect(
      verifyCertifiedHttpQueryResponse(
        expected(),
        new Uint8Array(32),
        rawRequest(),
        driftedHeaders,
      ),
    ).rejects.toThrow("headers do not match policy");
  });
});
