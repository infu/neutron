import { requestIdOf } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { describe, expect, test } from "bun:test";
import {
  DEPLOYMENT_OBSERVATION_SCHEMA_V1,
  DEPLOYMENT_PRICING_PROFILE_V1,
} from "../src/deployment_evidence.ts";
import {
  IC_MAINNET_ROOT_KEY_SHA256,
  IC_REGISTRY_CANISTER_ID_V1,
  IC_REGISTRY_EVIDENCE_SOURCE_V1,
  createIcRegistryCertifiedEvidenceProvider,
  type CertifiedRegistryCallV1,
  type CertifiedRegistryTransportV1,
  type IcRegistryEvidencePolicyV1,
} from "../src/ic_registry_evidence.ts";

const TARGET_SUBNET =
  "brlsh-zidhj-3yy3e-6vqbz-7xnih-xeq2l-as5oc-g32c4-i5pdn-2wwof-oae";
const REGISTRY_VERSION = 7_654_321n;
const RECORD_MUTATION_VERSION = REGISTRY_VERSION - 9n;
const CERTIFIED_TIME_NANOS = 1_774_550_400_123_000_000n;
const INGRESS_EXPIRY_NANOS = CERTIFIED_TIME_NANOS + 300_000_000_000n;
const TEXT_ENCODER = new TextEncoder();

const POLICY: IcRegistryEvidencePolicyV1 = {
  source: IC_REGISTRY_EVIDENCE_SOURCE_V1,
  registry_canister: IC_REGISTRY_CANISTER_ID_V1,
  root_key_sha256: IC_MAINNET_ROOT_KEY_SHA256,
  pricing_profile: DEPLOYMENT_PRICING_PROFILE_V1,
};

type ExecuteRequest = Parameters<CertifiedRegistryTransportV1["execute"]>[0];

type RegistryScenario = {
  latestReply: Uint8Array;
  valueReply: Uint8Array;
};

type TransportHarness = {
  transport: CertifiedRegistryTransportV1;
  calls: ExecuteRequest[];
  creations: { count: number };
  createTransport: () => CertifiedRegistryTransportV1;
};

describe("certified IC Registry deployment evidence", () => {
  test("reads a snapshot and its exact 13-node ordinary application record", async () => {
    const rawSubnetRecord = subnetRecord({
      pricing: 0n,
      sevEnabled: 0n,
    });
    const scenario = validScenario({ record: rawSubnetRecord });
    const harness = transportHarness(scenario);
    const provider = createIcRegistryCertifiedEvidenceProvider(
      { host: "https://icp-api.io", policy: POLICY },
      { createTransport: harness.createTransport },
    );

    const first = await provider.observe({ subnetId: TARGET_SUBNET });
    const second = await provider.observe({ subnetId: TARGET_SUBNET });

    expect(first.observation).toEqual({
      schema: DEPLOYMENT_OBSERVATION_SCHEMA_V1,
      source: IC_REGISTRY_EVIDENCE_SOURCE_V1,
      subnetId: TARGET_SUBNET,
      registryVersion: REGISTRY_VERSION.toString(),
      subnetType: "application",
      nodeCount: 13,
      sevEnabled: false,
      pricingProfile: DEPLOYMENT_PRICING_PROFILE_V1,
      verifiedAt: new Date(
        Number(CERTIFIED_TIME_NANOS / 1_000_000n),
      ).toISOString(),
    });
    expect(first.proofBundle.byteLength).toBeGreaterThan(0);
    expect(first.proofBundle).toEqual(second.proofBundle);
    expect(harness.creations.count).toBe(1);
    expect(harness.calls).toHaveLength(4);
    assertRegistryCalls(harness.calls.slice(0, 2));
    assertRegistryCalls(harness.calls.slice(2, 4));

    const latestRequest: ExecuteRequest = {
      canisterId: IC_REGISTRY_CANISTER_ID_V1,
      methodName: "get_latest_version",
      arg: new Uint8Array(),
    };
    const valueRequest: ExecuteRequest = {
      canisterId: IC_REGISTRY_CANISTER_ID_V1,
      methodName: "get_value",
      arg: registryGetValueRequest(
        `subnet_record_${TARGET_SUBNET}`,
        REGISTRY_VERSION,
      ),
    };
    expect(decodeProofBundle(first.proofBundle)).toEqual({
      schema: 1,
      source: IC_REGISTRY_EVIDENCE_SOURCE_V1,
      policy: POLICY,
      subnet_id: TARGET_SUBNET,
      registry_key: `subnet_record_${TARGET_SUBNET}`,
      snapshot_registry_version: REGISTRY_VERSION.toString(),
      subnet_record_mutation_version: RECORD_MUTATION_VERSION.toString(),
      raw_subnet_record_base64: base64(rawSubnetRecord),
      latest_version_call: expectedProofCall(
        certifiedCall(latestRequest, scenario.latestReply, 0x31),
      ),
      subnet_value_call: expectedProofCall(
        certifiedCall(valueRequest, scenario.valueReply, 0x52),
      ),
    });
  });

  test("accepts the explicit normal pricing schedule", async () => {
    const { result, calls } = await observeScenario(
      validScenario({ pricing: 1n, sevEnabled: 0n }),
    );

    expect(result.observation.pricingProfile).toBe(
      DEPLOYMENT_PRICING_PROFILE_V1,
    );
    expect(result.observation.sevEnabled).toBe(false);
    assertRegistryCalls(calls);
  });

  test("accepts the live ordinary-subnet encoding with omitted false SEV", async () => {
    const { result, calls } = await observeScenario(
      validScenario({
        record: subnetRecord({ includeSev: false }),
      }),
    );

    expect(result.observation.sevEnabled).toBe(false);
    assertRegistryCalls(calls);
  });

  test("validates all pinned policy fields before constructing a transport", async () => {
    const wrongPolicies: Array<[string, unknown]> = [
      [
        "source",
        {
          ...POLICY,
          source: "dashboard_json_v1",
        },
      ],
      [
        "Registry canister",
        {
          ...POLICY,
          registry_canister: "aaaaa-aa",
        },
      ],
      [
        "root key",
        {
          ...POLICY,
          root_key_sha256: `0${IC_MAINNET_ROOT_KEY_SHA256.slice(1)}`,
        },
      ],
      [
        "pricing profile",
        {
          ...POLICY,
          pricing_profile: "free",
        },
      ],
      [
        "extra field",
        {
          ...POLICY,
          fallback: "dashboard",
        },
      ],
    ];

    for (const [label, policy] of wrongPolicies) {
      const scenario = validScenario();
      const harness = transportHarness(scenario);

      await expect(
        (async () => {
          const provider = createIcRegistryCertifiedEvidenceProvider(
            {
              host: "https://icp-api.io",
              policy: policy as IcRegistryEvidencePolicyV1,
            },
            { createTransport: harness.createTransport },
          );
          await provider.observe({ subnetId: TARGET_SUBNET });
        })(),
      ).rejects.toThrow();

      expect(harness.creations.count, label).toBe(0);
      expect(harness.calls, label).toHaveLength(0);
    }
  });

  test.each([
    ["predates the latest-version proof", CERTIFIED_TIME_NANOS - 1n],
    [
      "is more than five minutes newer",
      CERTIFIED_TIME_NANOS + 300_000_000_001n,
    ],
  ])("rejects a subnet-value proof whose time %s", async (_label, time) => {
    const harness = transportHarness(
      validScenario(),
      (call) =>
        call.request.methodName === "get_value"
          ? { ...call, certifiedTimeNanos: time.toString() }
          : call,
    );
    await expect(observeWithHarness(harness)).rejects.toThrow(
      "must be ordered and no more than five minutes apart",
    );
  });

  test.each([
    [
      "request ID",
      (call: CertifiedRegistryCallV1) => {
        const requestId = call.requestId.slice();
        requestId[0] = requestId[0]! ^ 0xff;
        return { ...call, requestId };
      },
    ],
    [
      "method name",
      (call: CertifiedRegistryCallV1) => ({
        ...call,
        request: { ...call.request, methodName: "get_value" },
      }),
    ],
    [
      "argument",
      (call: CertifiedRegistryCallV1) => ({
        ...call,
        request: { ...call.request, arg: Uint8Array.of(0) },
      }),
    ],
    [
      "sender",
      (call: CertifiedRegistryCallV1) => ({
        ...call,
        request: { ...call.request, sender: TARGET_SUBNET },
      }),
    ],
    [
      "noncanonical ingress expiry",
      (call: CertifiedRegistryCallV1) => ({
        ...call,
        request: { ...call.request, ingressExpiryNanos: "01" },
      }),
    ],
    [
      "empty certificate",
      (call: CertifiedRegistryCallV1) => ({
        ...call,
        certificate: new Uint8Array(),
      }),
    ],
    [
      "zero certified time",
      (call: CertifiedRegistryCallV1) => ({
        ...call,
        certifiedTimeNanos: "0",
      }),
    ],
  ] satisfies Array<
    [
      string,
      (call: CertifiedRegistryCallV1) => CertifiedRegistryCallV1,
    ]
  >)(
    "rejects a certified transport result with a tampered %s",
    async (_name, mutateCall) => {
      const harness = transportHarness(validScenario(), mutateCall);

      await expect(observeWithHarness(harness)).rejects.toThrow();
      expect(harness.calls).toHaveLength(1);
    },
  );

  test.each([
    ["truncated response", Uint8Array.of(0x08, 0x80)],
    ["zero version", protobufMessage(varintField(1, 0n))],
    ["missing version", new Uint8Array()],
  ])("rejects a malformed latest Registry version: %s", async (_name, reply) => {
    const scenario = validScenario();
    scenario.latestReply = reply;
    const harness = transportHarness(scenario);

    await expect(observeWithHarness(harness)).rejects.toThrow();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.methodName).toBe("get_latest_version");
  });

  test.each([
    [
      "Registry error",
      registryGetValueResponse({
        version: RECORD_MUTATION_VERSION,
        error: registryError(1n, "subnet record not found"),
      }),
    ],
    [
      "large value indirection",
      registryGetValueResponse({
        version: RECORD_MUTATION_VERSION,
        largeValueChunkKeys: largeValueChunkKeys(
          new Uint8Array(32).fill(0xa7),
        ),
      }),
    ],
    [
      "missing value",
      registryGetValueResponse({ version: RECORD_MUTATION_VERSION }),
    ],
  ])("rejects a get_value response with %s", async (_name, valueReply) => {
    const scenario = validScenario();
    scenario.valueReply = valueReply;
    const harness = transportHarness(scenario);

    await expect(observeWithHarness(harness)).rejects.toThrow();
    assertRegistryCalls(harness.calls);
  });

  test("rejects a record mutation version beyond the certified snapshot", async () => {
    const scenario = validScenario();
    scenario.valueReply = registryGetValueResponse({
      version: REGISTRY_VERSION + 1n,
      value: subnetRecord(),
    });

    await expect(observeScenario(scenario)).rejects.toThrow();
  });

  test.each([
    ["unspecified", 0n],
    ["system", 2n],
    ["reserved", 3n],
    ["cloud engine", 5n],
    ["unknown", 99n],
  ])("rejects the %s subnet type", async (_name, subnetType) => {
    await expect(
      observeScenario(
        validScenario({
          record: subnetRecord({ subnetType }),
        }),
      ),
    ).rejects.toThrow();
  });

  test.each([
    ["twelve nodes", nodePrincipals(12)],
    ["fourteen nodes", nodePrincipals(14)],
    [
      "a duplicate node",
      [...nodePrincipals(12), nodePrincipals(12)[0]!],
    ],
  ])("rejects %s", async (_name, membership) => {
    await expect(
      observeScenario(
        validScenario({
          record: subnetRecord({ membership }),
        }),
      ),
    ).rejects.toThrow();
  });

  test.each([
    [
      "a missing features message",
      subnetRecord({ includeFeatures: false }),
    ],
    [
      "a non-Boolean SEV value",
      subnetRecord({ sevEnabled: 2n }),
    ],
    [
      "duplicate SEV fields",
      subnetRecord({
        featureBytes: protobufMessage(
          varintField(9, 0n),
          varintField(9, 0n),
        ),
      }),
    ],
    [
      "a malformed SEV field",
      subnetRecord({
        featureBytes: protobufMessage(
          bytesField(9, new Uint8Array()),
        ),
      }),
    ],
  ])("rejects %s", async (_name, record) => {
    await expect(
      observeScenario(validScenario({ record })),
    ).rejects.toThrow();
  });

  test.each([
    ["free", 2n],
    ["unknown", 3n],
    ["out of range", 99n],
  ])("rejects the %s cycles pricing schedule", async (_name, pricing) => {
    await expect(
      observeScenario(
        validScenario({
          record: subnetRecord({ pricing }),
        }),
      ),
    ).rejects.toThrow();
  });
});

function validScenario({
  record = subnetRecord(),
  pricing,
  sevEnabled,
}: {
  record?: Uint8Array;
  pricing?: bigint;
  sevEnabled?: bigint;
} = {}): RegistryScenario {
  const value =
    pricing === undefined && sevEnabled === undefined
      ? record
      : subnetRecord({
          ...(pricing === undefined ? {} : { pricing }),
          ...(sevEnabled === undefined ? {} : { sevEnabled }),
        });
  return {
    latestReply: protobufMessage(varintField(1, REGISTRY_VERSION)),
    valueReply: registryGetValueResponse({
      version: RECORD_MUTATION_VERSION,
      value,
    }),
  };
}

async function observeScenario(scenario: RegistryScenario) {
  const harness = transportHarness(scenario);
  const result = await observeWithHarness(harness);
  return { result, calls: harness.calls };
}

async function observeWithHarness(harness: TransportHarness) {
  const provider = createIcRegistryCertifiedEvidenceProvider(
    { host: "https://icp-api.io", policy: POLICY },
    { createTransport: harness.createTransport },
  );
  return provider.observe({ subnetId: TARGET_SUBNET });
}

function transportHarness(
  scenario: RegistryScenario,
  mutateCall: (
    call: CertifiedRegistryCallV1,
  ) => CertifiedRegistryCallV1 = (call) => call,
): TransportHarness {
  const calls: ExecuteRequest[] = [];
  const creations = { count: 0 };
  const transport = {
    async execute(request: ExecuteRequest): Promise<CertifiedRegistryCallV1> {
      calls.push({
        ...request,
        arg: request.arg.slice(),
      });
      switch (request.methodName) {
        case "get_latest_version":
          return mutateCall(
            certifiedCall(request, scenario.latestReply, 0x31),
          );
        case "get_value":
          return mutateCall(
            certifiedCall(request, scenario.valueReply, 0x52),
          );
        default:
          throw new Error(`Unexpected Registry method ${request.methodName}`);
      }
    },
  } satisfies CertifiedRegistryTransportV1;

  return {
    transport,
    calls,
    creations,
    createTransport: () => {
      creations.count += 1;
      return transport;
    },
  };
}

function certifiedCall(
  request: ExecuteRequest,
  reply: Uint8Array,
  discriminator: number,
): CertifiedRegistryCallV1 {
  const nonce = Uint8Array.of(discriminator, 0x01, 0x02, 0x03);
  const requestId = requestIdOf({
    request_type: "call",
    canister_id: Principal.fromText(request.canisterId),
    method_name: request.methodName,
    arg: request.arg,
    sender: Principal.anonymous(),
    ingress_expiry: INGRESS_EXPIRY_NANOS,
    nonce,
  });
  return {
    requestId,
    request: {
      canisterId: request.canisterId,
      methodName: request.methodName,
      arg: request.arg.slice(),
      sender: Principal.anonymous().toText(),
      ingressExpiryNanos: INGRESS_EXPIRY_NANOS.toString(),
      nonce,
    },
    reply: reply.slice(),
    certificate: Uint8Array.of(
      0xd9,
      0xd9,
      0xf7,
      0xa1,
      0x00,
      discriminator,
    ),
    certifiedTimeNanos: CERTIFIED_TIME_NANOS.toString(),
  };
}

function assertRegistryCalls(calls: ExecuteRequest[]): void {
  expect(calls).toHaveLength(2);
  expect(calls[0]?.canisterId).toBe(IC_REGISTRY_CANISTER_ID_V1);
  expect(calls[0]?.methodName).toBe("get_latest_version");
  expect(calls[0]?.arg).toEqual(new Uint8Array());
  expect(calls[1]?.canisterId).toBe(IC_REGISTRY_CANISTER_ID_V1);
  expect(calls[1]?.methodName).toBe("get_value");
  expect(calls[1]?.arg).toEqual(
    registryGetValueRequest(
      `subnet_record_${TARGET_SUBNET}`,
      REGISTRY_VERSION,
    ),
  );
}

function decodeProofBundle(proofBundle: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(proofBundle));
}

function expectedProofCall(call: CertifiedRegistryCallV1) {
  return {
    request_id_base64: base64(call.requestId),
    request: {
      canister_id: call.request.canisterId,
      method_name: call.request.methodName,
      arg_base64: base64(call.request.arg),
      sender: call.request.sender,
      ingress_expiry_nanos: call.request.ingressExpiryNanos,
      nonce_base64:
        call.request.nonce === null ? null : base64(call.request.nonce),
    },
    reply_base64: base64(call.reply),
    certificate_base64: base64(call.certificate),
    certified_time_nanos: call.certifiedTimeNanos,
  };
}

function registryGetValueRequest(
  key: string,
  version: bigint,
): Uint8Array {
  return protobufMessage(
    bytesField(1, protobufMessage(varintField(1, version))),
    bytesField(2, TEXT_ENCODER.encode(key)),
  );
}

function registryGetValueResponse({
  error,
  version,
  value,
  largeValueChunkKeys: chunks,
}: {
  error?: Uint8Array;
  version: bigint;
  value?: Uint8Array;
  largeValueChunkKeys?: Uint8Array;
}): Uint8Array {
  return protobufMessage(
    error === undefined ? undefined : bytesField(1, error),
    varintField(2, version),
    value === undefined ? undefined : bytesField(3, value),
    chunks === undefined ? undefined : bytesField(4, chunks),
  );
}

function registryError(code: bigint, reason: string): Uint8Array {
  return protobufMessage(
    varintField(1, code),
    bytesField(2, TEXT_ENCODER.encode(reason)),
  );
}

function largeValueChunkKeys(digest: Uint8Array): Uint8Array {
  return protobufMessage(bytesField(1, digest));
}

function subnetRecord({
  membership = nodePrincipals(13),
  subnetType = 1n,
  includeFeatures = true,
  includeSev = true,
  sevEnabled = 0n,
  featureBytes,
  pricing = 0n,
}: {
  membership?: Uint8Array[];
  subnetType?: bigint;
  includeFeatures?: boolean;
  includeSev?: boolean;
  sevEnabled?: bigint;
  featureBytes?: Uint8Array;
  pricing?: bigint;
} = {}): Uint8Array {
  const features =
    featureBytes ??
    (includeSev
      ? protobufMessage(varintField(9, sevEnabled))
      : new Uint8Array());
  return protobufMessage(
    ...membership.map((principal) => bytesField(3, principal)),
    varintField(15, subnetType),
    includeFeatures ? bytesField(23, features) : undefined,
    pricing === 0n ? undefined : varintField(30, pricing),
  );
}

function nodePrincipals(count: number): Uint8Array[] {
  return Array.from({ length: count }, (_, index) =>
    Principal.selfAuthenticating(
      new Uint8Array(32).fill(index + 1),
    ).toUint8Array(),
  );
}

function protobufMessage(
  ...fields: Array<Uint8Array | undefined>
): Uint8Array {
  return concatBytes(
    fields.filter((field): field is Uint8Array => field !== undefined),
  );
}

function varintField(fieldNumber: number, value: bigint): Uint8Array {
  return concatBytes([
    encodeVarint(BigInt(fieldNumber << 3)),
    encodeVarint(value),
  ]);
}

function bytesField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return concatBytes([
    encodeVarint(BigInt((fieldNumber << 3) | 2)),
    encodeVarint(BigInt(value.byteLength)),
    value,
  ]);
}

function encodeVarint(input: bigint): Uint8Array {
  if (input < 0n) throw new Error("Cannot encode a negative protobuf varint");
  const bytes: number[] = [];
  let value = input;
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0n);
  return Uint8Array.from(bytes);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
