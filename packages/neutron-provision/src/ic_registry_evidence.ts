import { createHash } from "node:crypto";
import {
  AnonymousIdentity,
  Certificate,
  HttpAgent,
  IC_ROOT_KEY,
  LookupPathStatus,
  isV3ResponseBody,
  requestIdOf,
  type Agent,
  type CallRequest,
} from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import {
  DEPLOYMENT_OBSERVATION_SCHEMA_V1,
  DEPLOYMENT_OBSERVATION_SOURCE_V1,
  DEPLOYMENT_PRICING_PROFILE_V1,
  assertDeploymentObservationProofV1,
  assertDeploymentObservationV1,
  parseIJson,
  rfc8785JcsBytes,
  type DeploymentEvidenceProviderV1,
  type DeploymentObservationV1,
  type DeploymentObservationProviderResultV1,
  type JsonValue,
} from "./deployment_evidence.ts";

export const IC_REGISTRY_EVIDENCE_SOURCE_V1 =
  DEPLOYMENT_OBSERVATION_SOURCE_V1;
export const IC_REGISTRY_CANISTER_ID_V1 =
  "rwlgt-iiaaa-aaaaa-aaaaa-cai" as const;
export const IC_MAINNET_ROOT_KEY_SHA256 =
  "737ba355e855bd4b61279056603e05501db5e5bad147c6eba7be8c2a13f4b6b3" as const;

/** Exact DER-encoded IC mainnet root key used by every certified observer. */
export function icMainnetRootKey(): Uint8Array {
  return mainnetRootKey();
}

const REGISTRY_LATEST_VERSION_METHOD = "get_latest_version";
const REGISTRY_GET_VALUE_METHOD = "get_value";
const REGISTRY_SUBNET_KEY_PREFIX = "subnet_record_";
const ANONYMOUS_PRINCIPAL = Principal.anonymous().toText();
const MAX_REGISTRY_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_CERTIFICATE_BYTES = 4 * 1024 * 1024;
const MAX_NONCE_BYTES = 64;
const MAX_POLL_ATTEMPTS = 120;
const POLL_INTERVAL_MILLISECONDS = 250;
const MAX_REGISTRY_CALL_TIME_SKEW_NANOS = 300_000_000_000n;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type IcRegistryEvidencePolicyV1 = {
  source: typeof IC_REGISTRY_EVIDENCE_SOURCE_V1;
  registry_canister: typeof IC_REGISTRY_CANISTER_ID_V1;
  root_key_sha256: typeof IC_MAINNET_ROOT_KEY_SHA256;
  pricing_profile: typeof DEPLOYMENT_PRICING_PROFILE_V1;
};

export type CertifiedRegistryCallRequestV1 = {
  canisterId: string;
  methodName: string;
  arg: Uint8Array;
  sender: string;
  ingressExpiryNanos: string;
  nonce: Uint8Array | null;
};

export type CertifiedRegistryCallV1 = {
  requestId: Uint8Array;
  request: CertifiedRegistryCallRequestV1;
  reply: Uint8Array;
  certificate: Uint8Array;
  certifiedTimeNanos: string;
};

export interface CertifiedRegistryTransportV1 {
  execute(input: {
    canisterId: string;
    methodName: string;
    arg: Uint8Array;
  }): Promise<CertifiedRegistryCallV1>;
}

export type IcRegistryEvidenceProviderOptionsV1 = {
  host: string;
  policy: IcRegistryEvidencePolicyV1;
};

export type IcRegistryEvidenceProviderDependenciesV1 = {
  /**
   * Test seam. Production callers must omit this so certificates are verified
   * by the pinned-root transport below.
   */
  createTransport?: (input: {
    host: string;
    registryCanisterId: string;
    rootKey: Uint8Array;
  }) =>
    | CertifiedRegistryTransportV1
    | Promise<CertifiedRegistryTransportV1>;
};

type ProtobufField = {
  number: number;
  wireType: number;
  value: bigint | Uint8Array;
};

type ParsedSubnetRecord = {
  subnetType: "application" | "verified_application";
  nodeCount: number;
  sevEnabled: boolean;
  costSchedule: "normal";
};

type CertifiedLookup = {
  status: string | null;
  reply: Uint8Array | null;
  certifiedTimeNanos: bigint;
};

/**
 * Build the stock, mainnet-only Registry evidence provider.
 *
 * Construction is synchronous and performs no network operation. Network work
 * starts only in observe(), after the host and every trust/policy pin have
 * passed this closed validator.
 */
export function createIcRegistryCertifiedEvidenceProvider(
  options: IcRegistryEvidenceProviderOptionsV1,
  dependencies: IcRegistryEvidenceProviderDependenciesV1 = {},
): DeploymentEvidenceProviderV1 {
  const input = plainRecord(options, "IC Registry evidence options");
  exactKeys(input, ["host", "policy"], "IC Registry evidence options");
  const host = bareHttpsOrigin(input.host, "IC Registry evidence host");
  const policy = exactPolicy(input.policy);
  const rootKey = mainnetRootKey();
  const rootKeySha256 = sha256Hex(rootKey);
  if (
    rootKeySha256 !== policy.root_key_sha256 ||
    rootKeySha256 !== IC_MAINNET_ROOT_KEY_SHA256
  ) {
    throw new Error(
      "Compiled IC mainnet root key does not match the deployment-evidence trust pin",
    );
  }
  let transportPromise: Promise<CertifiedRegistryTransportV1> | undefined;
  const loadTransport = (): Promise<CertifiedRegistryTransportV1> => {
    transportPromise ??= Promise.resolve(
      dependencies.createTransport
        ? dependencies.createTransport({
            host,
            registryCanisterId: policy.registry_canister,
            rootKey: rootKey.slice(),
          })
        : createCertifiedRegistryTransport({
            host,
            registryCanisterId: policy.registry_canister,
            rootKey,
          }),
    );
    return transportPromise;
  };

  return {
    async observe({ subnetId }): Promise<DeploymentObservationProviderResultV1> {
      const canonicalSubnetId = canonicalNonAnonymousPrincipal(
        subnetId,
        "deployment evidence subnet",
      );
      const transport = await loadTransport();
      assertTransport(transport);

      const latestCall = await executeExactCertifiedCall(transport, {
        canisterId: policy.registry_canister,
        methodName: REGISTRY_LATEST_VERSION_METHOD,
        arg: new Uint8Array(),
      });
      const snapshotVersion = decodeLatestRegistryVersion(latestCall.reply);
      const registryKey = `${REGISTRY_SUBNET_KEY_PREFIX}${canonicalSubnetId}`;
      const valueArg = encodeGetValueRequest(
        textEncoder.encode(registryKey),
        snapshotVersion,
      );
      const valueCall = await executeExactCertifiedCall(transport, {
        canisterId: policy.registry_canister,
        methodName: REGISTRY_GET_VALUE_METHOD,
        arg: valueArg,
      });
      const value = decodeRegistryValueResponse(
        valueCall.reply,
        snapshotVersion,
      );
      const subnet = decodeSubnetRecord(value.record);
      const certifiedTimeNanos = orderedRegistryCallTime(
        BigInt(latestCall.certifiedTimeNanos),
        BigInt(valueCall.certifiedTimeNanos),
      );
      const proofBundle = registryProofBundle({
        policy,
        subnetId: canonicalSubnetId,
        registryKey,
        snapshotVersion,
        recordMutationVersion: value.mutationVersion,
        rawSubnetRecord: value.record,
        latestCall,
        valueCall,
      });

      return {
        observation: {
          schema: DEPLOYMENT_OBSERVATION_SCHEMA_V1,
          source: IC_REGISTRY_EVIDENCE_SOURCE_V1,
          subnetId: canonicalSubnetId,
          registryVersion: snapshotVersion.toString(),
          subnetType: subnet.subnetType,
          nodeCount: subnet.nodeCount,
          sevEnabled: subnet.sevEnabled,
          pricingProfile: policy.pricing_profile,
          verifiedAt: certifiedTimeToIso(certifiedTimeNanos),
        },
        proofBundle,
      };
    },
  };
}

/**
 * Re-verify a persisted Registry proof bundle without contacting the network.
 *
 * The content-addressed deployment-evidence layer validates the normalized
 * observation and proof digest. This boundary additionally reconstructs both
 * ingress request IDs, verifies both IC certificates against the compiled
 * mainnet root key, derives both certified replies, and re-decodes the exact
 * Registry snapshot and subnet record. Certificate wall-clock freshness is
 * intentionally disabled so historical release evidence remains auditable;
 * its authenticated time is still required to equal observation.verifiedAt.
 */
export async function verifyIcRegistryCertifiedObservationProofV1(input: {
  observation: DeploymentObservationV1;
  proofBundle: Uint8Array;
}): Promise<void> {
  assertDeploymentObservationV1(
    input.observation,
    "certified Registry observation",
  );
  assertDeploymentObservationProofV1(
    input.observation,
    input.proofBundle,
    "certified Registry observation",
  );
  const proofBytes = boundedBytes(
    input.proofBundle,
    "certified Registry proof bundle",
    1,
    16 * 1024 * 1024,
  );
  const proofText = decodeUtf8(
    proofBytes,
    "certified Registry proof bundle",
  );
  const proofValue = parseIJson(proofText);
  if (
    !equalBytes(
      proofBytes,
      rfc8785JcsBytes(proofValue),
    )
  ) {
    throw new Error(
      "Certified Registry proof bundle must use canonical RFC 8785 JSON bytes",
    );
  }
  const proof = plainRecord(
    proofValue,
    "certified Registry proof bundle",
  );
  exactKeys(
    proof,
    [
      "schema",
      "source",
      "policy",
      "subnet_id",
      "registry_key",
      "snapshot_registry_version",
      "subnet_record_mutation_version",
      "raw_subnet_record_base64",
      "latest_version_call",
      "subnet_value_call",
    ],
    "certified Registry proof bundle",
  );
  if (
    proof.schema !== 1 ||
    proof.source !== IC_REGISTRY_EVIDENCE_SOURCE_V1
  ) {
    throw new Error(
      "Certified Registry proof bundle has an unsupported schema or source",
    );
  }
  const policy = exactPolicy(proof.policy);
  const rootKey = mainnetRootKey();
  if (
    sha256Hex(rootKey) !== policy.root_key_sha256 ||
    policy.root_key_sha256 !== IC_MAINNET_ROOT_KEY_SHA256
  ) {
    throw new Error(
      "Certified Registry proof root key does not match the mainnet trust pin",
    );
  }
  if (proof.subnet_id !== input.observation.subnetId) {
    throw new Error(
      "Certified Registry proof subnet does not match its observation",
    );
  }
  const subnetId = canonicalNonAnonymousPrincipal(
    proof.subnet_id,
    "certified Registry proof subnet",
  );
  const registryKey = `${REGISTRY_SUBNET_KEY_PREFIX}${subnetId}`;
  if (proof.registry_key !== registryKey) {
    throw new Error(
      "Certified Registry proof key does not match its subnet",
    );
  }
  const snapshotVersion = canonicalNat(
    proof.snapshot_registry_version,
    "certified Registry proof snapshot version",
  );
  if (
    snapshotVersion <= 0n ||
    snapshotVersion.toString() !== input.observation.registryVersion
  ) {
    throw new Error(
      "Certified Registry proof snapshot version does not match its observation",
    );
  }
  const recordMutationVersion = canonicalNat(
    proof.subnet_record_mutation_version,
    "certified Registry proof record mutation version",
  );
  if (recordMutationVersion > snapshotVersion) {
    throw new Error(
      "Certified Registry proof record mutation version exceeds its snapshot",
    );
  }
  const rawSubnetRecord = decodeCanonicalBase64(
    proof.raw_subnet_record_base64,
    "certified Registry raw subnet record",
    1,
    MAX_REGISTRY_REPLY_BYTES,
  );
  const latestCall = parsePersistedProofCall(
    proof.latest_version_call,
    {
      canisterId: policy.registry_canister,
      methodName: REGISTRY_LATEST_VERSION_METHOD,
      arg: new Uint8Array(),
    },
    "certified Registry latest-version call",
  );
  const valueArg = encodeGetValueRequest(
    textEncoder.encode(registryKey),
    snapshotVersion,
  );
  const valueCall = parsePersistedProofCall(
    proof.subnet_value_call,
    {
      canisterId: policy.registry_canister,
      methodName: REGISTRY_GET_VALUE_METHOD,
      arg: valueArg,
    },
    "certified Registry subnet-value call",
  );
  await Promise.all([
    verifyPersistedProofCallCertificate(latestCall, rootKey),
    verifyPersistedProofCallCertificate(valueCall, rootKey),
  ]);
  if (decodeLatestRegistryVersion(latestCall.reply) !== snapshotVersion) {
    throw new Error(
      "Certified Registry latest-version reply does not match the proof snapshot",
    );
  }
  const value = decodeRegistryValueResponse(
    valueCall.reply,
    snapshotVersion,
  );
  if (
    value.mutationVersion !== recordMutationVersion ||
    !equalBytes(value.record, rawSubnetRecord)
  ) {
    throw new Error(
      "Certified Registry subnet-value reply does not match the proof record",
    );
  }
  const subnet = decodeSubnetRecord(rawSubnetRecord);
  if (
    input.observation.schema !== DEPLOYMENT_OBSERVATION_SCHEMA_V1 ||
    input.observation.source !== IC_REGISTRY_EVIDENCE_SOURCE_V1 ||
    input.observation.subnetType !== subnet.subnetType ||
    input.observation.nodeCount !== subnet.nodeCount ||
    input.observation.sevEnabled !== subnet.sevEnabled ||
    input.observation.pricingProfile !== policy.pricing_profile
  ) {
    throw new Error(
      "Certified Registry subnet record does not match its normalized observation",
    );
  }
  const certifiedTime = orderedRegistryCallTime(
    BigInt(latestCall.certifiedTimeNanos),
    BigInt(valueCall.certifiedTimeNanos),
  );
  if (
    certifiedTimeToIso(certifiedTime) !== input.observation.verifiedAt
  ) {
    throw new Error(
      "Certified Registry proof time does not match its observation",
    );
  }
}

async function createCertifiedRegistryTransport({
  host,
  registryCanisterId,
  rootKey,
}: {
  host: string;
  registryCanisterId: string;
  rootKey: Uint8Array;
}): Promise<CertifiedRegistryTransportV1> {
  const agent = await HttpAgent.create({
    host,
    identity: new AnonymousIdentity(),
    rootKey: rootKey.slice(),
    shouldFetchRootKey: false,
    shouldSyncTime: false,
    verifyQuerySignatures: false,
  });
  if (
    agent.rootKey === null ||
    !equalBytes(agent.rootKey, rootKey) ||
    sha256Hex(agent.rootKey) !== IC_MAINNET_ROOT_KEY_SHA256
  ) {
    throw new Error("IC agent did not retain the pinned mainnet root key");
  }
  const canister = Principal.fromText(registryCanisterId);

  return {
    async execute({ canisterId, methodName, arg }) {
      if (canisterId !== registryCanisterId) {
        throw new Error("Registry transport canister does not match its pin");
      }
      return executeReplicatedRead({
        agent,
        canister,
        methodName,
        arg,
        rootKey,
      });
    },
  };
}

async function executeReplicatedRead({
  agent,
  canister,
  methodName,
  arg,
  rootKey,
}: {
  agent: Agent;
  canister: Principal;
  methodName: string;
  arg: Uint8Array;
  rootKey: Uint8Array;
}): Promise<CertifiedRegistryCallV1> {
  const submitted = await agent.call(canister, {
    methodName,
    arg,
    effectiveCanisterId: canister,
  });
  const requestDetails = submitted.requestDetails;
  if (!requestDetails) {
    throw new Error("Replicated Registry call omitted its request details");
  }
  assertSubmittedRequest(requestDetails, canister, methodName, arg);
  const computedRequestId = requestIdOf(requestDetails);
  if (!equalBytes(computedRequestId, submitted.requestId)) {
    throw new Error("Replicated Registry request ID does not match its request");
  }

  let rawCertificate: Uint8Array | null = null;
  let lookup: CertifiedLookup | null = null;
  if (isV3ResponseBody(submitted.response.body)) {
    rawCertificate = boundedBytes(
      submitted.response.body.certificate,
      "Registry call certificate",
      1,
      MAX_CERTIFICATE_BYTES,
    );
    lookup = await verifyRequestCertificate({
      canister,
      rootKey,
      requestId: submitted.requestId,
      certificate: rawCertificate,
    });
  } else if (submitted.response.status !== 202) {
    throw new Error(
      `Registry replicated call returned an uncertified HTTP ${submitted.response.status}`,
    );
  }

  for (let attempt = 0; lookup?.status !== "replied"; attempt += 1) {
    if (lookup?.status === "rejected" || lookup?.status === "done") {
      throw new Error(
        `Registry replicated call ended with certified status ${lookup.status}`,
      );
    }
    if (
      lookup?.status !== null &&
      lookup?.status !== undefined &&
      lookup.status !== "received" &&
      lookup.status !== "processing" &&
      lookup.status !== "unknown"
    ) {
      throw new Error(
        `Registry replicated call returned unknown certified status ${lookup.status}`,
      );
    }
    if (attempt >= MAX_POLL_ATTEMPTS) {
      throw new Error("Timed out waiting for certified Registry reply");
    }
    if (attempt > 0 || lookup !== null) {
      await delay(POLL_INTERVAL_MILLISECONDS);
    }
    const state = await agent.readState(canister, {
      paths: [[textEncoder.encode("request_status"), submitted.requestId]],
    });
    rawCertificate = boundedBytes(
      state.certificate,
      "Registry read_state certificate",
      1,
      MAX_CERTIFICATE_BYTES,
    );
    lookup = await verifyRequestCertificate({
      canister,
      rootKey,
      requestId: submitted.requestId,
      certificate: rawCertificate,
    });
  }

  if (!rawCertificate || !lookup.reply) {
    throw new Error("Certified Registry response did not contain a reply");
  }
  return {
    requestId: submitted.requestId.slice(),
    request: normalizeSubmittedRequest(requestDetails),
    reply: boundedBytes(
      lookup.reply,
      "certified Registry reply",
      1,
      MAX_REGISTRY_REPLY_BYTES,
    ).slice(),
    certificate: rawCertificate.slice(),
    certifiedTimeNanos: lookup.certifiedTimeNanos.toString(),
  };
}

async function verifyRequestCertificate({
  canister,
  rootKey,
  requestId,
  certificate,
}: {
  canister: Principal;
  rootKey: Uint8Array;
  requestId: Uint8Array;
  certificate: Uint8Array;
}): Promise<CertifiedLookup> {
  const verified = await Certificate.create({
    certificate,
    rootKey,
    canisterId: canister,
  });
  const prefix: Array<string | Uint8Array> = [
    "request_status",
    requestId,
  ];
  const statusBytes = foundLookup(
    verified.lookup_path([...prefix, "status"]),
  );
  const timeBytes = foundLookup(verified.lookup_path(["time"]));
  if (!timeBytes) {
    throw new Error("Certified Registry response omitted certified time");
  }
  const certifiedTimeNanos = decodeUnsignedLeb128(
    timeBytes,
    "certificate time",
  );
  if (certifiedTimeNanos <= 0n) {
    throw new Error("Certified Registry response time must be positive");
  }
  if (!statusBytes) {
    return { status: null, reply: null, certifiedTimeNanos };
  }
  const status = decodeUtf8(statusBytes, "certified request status");
  return {
    status,
    reply:
      status === "replied"
        ? foundLookup(verified.lookup_path([...prefix, "reply"])) ?? null
        : null,
    certifiedTimeNanos,
  };
}

async function executeExactCertifiedCall(
  transport: CertifiedRegistryTransportV1,
  expected: {
    canisterId: string;
    methodName: string;
    arg: Uint8Array;
  },
): Promise<CertifiedRegistryCallV1> {
  const result = await transport.execute({
    canisterId: expected.canisterId,
    methodName: expected.methodName,
    arg: expected.arg.slice(),
  });
  const call = validateCertifiedCall(result, expected);
  return {
    requestId: call.requestId.slice(),
    request: {
      ...call.request,
      arg: call.request.arg.slice(),
      nonce: call.request.nonce?.slice() ?? null,
    },
    reply: call.reply.slice(),
    certificate: call.certificate.slice(),
    certifiedTimeNanos: call.certifiedTimeNanos,
  };
}

function validateCertifiedCall(
  value: unknown,
  expected: {
    canisterId: string;
    methodName: string;
    arg: Uint8Array;
  },
): CertifiedRegistryCallV1 {
  const call = plainRecord(value, "certified Registry call");
  exactKeys(
    call,
    ["requestId", "request", "reply", "certificate", "certifiedTimeNanos"],
    "certified Registry call",
  );
  const requestId = boundedBytes(
    call.requestId,
    "certified Registry request ID",
    32,
    32,
  );
  const requestValue = plainRecord(
    call.request,
    "certified Registry request",
  );
  exactKeys(
    requestValue,
    [
      "canisterId",
      "methodName",
      "arg",
      "sender",
      "ingressExpiryNanos",
      "nonce",
    ],
    "certified Registry request",
  );
  if (requestValue.canisterId !== expected.canisterId) {
    throw new Error("Certified Registry request canister does not match");
  }
  if (requestValue.methodName !== expected.methodName) {
    throw new Error("Certified Registry request method does not match");
  }
  const arg = boundedBytes(
    requestValue.arg,
    "certified Registry request argument",
    0,
    MAX_REGISTRY_REPLY_BYTES,
  );
  if (!equalBytes(arg, expected.arg)) {
    throw new Error("Certified Registry request argument does not match");
  }
  if (requestValue.sender !== ANONYMOUS_PRINCIPAL) {
    throw new Error("Certified Registry requests must use the anonymous sender");
  }
  const ingressExpiryNanos = canonicalNat(
    requestValue.ingressExpiryNanos,
    "certified Registry request ingress expiry",
  );
  if (ingressExpiryNanos <= 0n) {
    throw new Error("Certified Registry request ingress expiry must be positive");
  }
  const nonce =
    requestValue.nonce === null
      ? null
      : boundedBytes(
          requestValue.nonce,
          "certified Registry request nonce",
          1,
          MAX_NONCE_BYTES,
        );
  const reconstructedRequestId = requestIdOf({
    request_type: "call",
    canister_id: Principal.fromText(expected.canisterId),
    method_name: expected.methodName,
    arg,
    sender: Principal.anonymous(),
    ingress_expiry: ingressExpiryNanos,
    ...(nonce === null ? {} : { nonce }),
  });
  if (!equalBytes(requestId, reconstructedRequestId)) {
    throw new Error(
      "Certified Registry request ID does not bind its method, argument, and sender",
    );
  }
  const certifiedTimeNanos = canonicalNat(
    call.certifiedTimeNanos,
    "certified Registry response time",
  );
  if (certifiedTimeNanos <= 0n) {
    throw new Error("Certified Registry response time must be positive");
  }
  return {
    requestId,
    request: {
      canisterId: expected.canisterId,
      methodName: expected.methodName,
      arg,
      sender: ANONYMOUS_PRINCIPAL,
      ingressExpiryNanos: ingressExpiryNanos.toString(),
      nonce,
    },
    reply: boundedBytes(
      call.reply,
      "certified Registry reply",
      1,
      MAX_REGISTRY_REPLY_BYTES,
    ),
    certificate: boundedBytes(
      call.certificate,
      "certified Registry certificate",
      1,
      MAX_CERTIFICATE_BYTES,
    ),
    certifiedTimeNanos: certifiedTimeNanos.toString(),
  };
}

function parsePersistedProofCall(
  value: unknown,
  expected: {
    canisterId: string;
    methodName: string;
    arg: Uint8Array;
  },
  label: string,
): CertifiedRegistryCallV1 {
  const proof = plainRecord(value, label);
  exactKeys(
    proof,
    [
      "request_id_base64",
      "request",
      "reply_base64",
      "certificate_base64",
      "certified_time_nanos",
    ],
    label,
  );
  const request = plainRecord(proof.request, `${label}.request`);
  exactKeys(
    request,
    [
      "canister_id",
      "method_name",
      "arg_base64",
      "sender",
      "ingress_expiry_nanos",
      "nonce_base64",
    ],
    `${label}.request`,
  );
  const ingressExpiry = canonicalNat(
    request.ingress_expiry_nanos,
    `${label}.request.ingress_expiry_nanos`,
  );
  if (ingressExpiry <= 0n) {
    throw new Error(`${label} ingress expiry must be positive`);
  }
  const nonce =
    request.nonce_base64 === null
      ? null
      : decodeCanonicalBase64(
          request.nonce_base64,
          `${label}.request.nonce_base64`,
          1,
          MAX_NONCE_BYTES,
        );
  const call = {
    requestId: decodeCanonicalBase64(
      proof.request_id_base64,
      `${label}.request_id_base64`,
      32,
      32,
    ),
    request: {
      canisterId: request.canister_id,
      methodName: request.method_name,
      arg: decodeCanonicalBase64(
        request.arg_base64,
        `${label}.request.arg_base64`,
        0,
        MAX_REGISTRY_REPLY_BYTES,
      ),
      sender: request.sender,
      ingressExpiryNanos: ingressExpiry.toString(),
      nonce,
    },
    reply: decodeCanonicalBase64(
      proof.reply_base64,
      `${label}.reply_base64`,
      1,
      MAX_REGISTRY_REPLY_BYTES,
    ),
    certificate: decodeCanonicalBase64(
      proof.certificate_base64,
      `${label}.certificate_base64`,
      1,
      MAX_CERTIFICATE_BYTES,
    ),
    certifiedTimeNanos: canonicalNat(
      proof.certified_time_nanos,
      `${label}.certified_time_nanos`,
    ).toString(),
  };
  return validateCertifiedCall(call, expected);
}

async function verifyPersistedProofCallCertificate(
  call: CertifiedRegistryCallV1,
  rootKey: Uint8Array,
): Promise<void> {
  const canister = Principal.fromText(call.request.canisterId);
  const certificate = await Certificate.create({
    certificate: call.certificate,
    rootKey,
    canisterId: canister,
    disableTimeVerification: true,
  });
  const prefix: Array<string | Uint8Array> = [
    "request_status",
    call.requestId,
  ];
  const status = foundLookup(
    certificate.lookup_path([...prefix, "status"]),
  );
  const reply = foundLookup(
    certificate.lookup_path([...prefix, "reply"]),
  );
  const time = foundLookup(certificate.lookup_path(["time"]));
  if (
    status === null ||
    decodeUtf8(status, "persisted certified Registry status") !==
      "replied" ||
    reply === null ||
    !equalBytes(reply, call.reply) ||
    time === null
  ) {
    throw new Error(
      "Persisted certified Registry call does not contain its claimed reply",
    );
  }
  const certifiedTime = decodeUnsignedLeb128(
    time,
    "persisted certified Registry time",
  );
  if (
    certifiedTime <= 0n ||
    certifiedTime.toString() !== call.certifiedTimeNanos
  ) {
    throw new Error(
      "Persisted certified Registry call time does not match its claim",
    );
  }
}

function decodeLatestRegistryVersion(reply: Uint8Array): bigint {
  const fields = parseProtobuf(reply, "Registry latest-version reply");
  const version = oneVarint(
    fields,
    1,
    "Registry latest-version reply.version",
  );
  if (version <= 0n) {
    throw new Error("Registry latest version must be positive");
  }
  return version;
}

function decodeRegistryValueResponse(
  reply: Uint8Array,
  snapshotVersion: bigint,
): { mutationVersion: bigint; record: Uint8Array } {
  const fields = parseProtobuf(reply, "Registry get-value reply");
  if (fields.some((field) => field.number === 1)) {
    throw new Error("Registry get-value reply contains an error");
  }
  if (fields.some((field) => field.number === 4)) {
    throw new Error(
      "Registry subnet record requires unsupported chunked retrieval",
    );
  }
  const mutationVersion = oneVarint(
    fields,
    2,
    "Registry get-value reply.version",
  );
  // RegistryGetValueResponse.version is the record's last mutation at or
  // before the requested snapshot, not necessarily the snapshot version.
  if (mutationVersion <= 0n || mutationVersion > snapshotVersion) {
    throw new Error(
      "Registry subnet-record mutation version is outside the certified snapshot",
    );
  }
  const record = oneBytes(
    fields,
    3,
    "Registry get-value reply.value",
  );
  if (record.byteLength === 0) {
    throw new Error("Registry subnet record must not be empty");
  }
  return { mutationVersion, record };
}

function decodeSubnetRecord(bytes: Uint8Array): ParsedSubnetRecord {
  const fields = parseProtobuf(bytes, "Registry SubnetRecord");
  const memberships = fields.filter((field) => field.number === 3);
  const nodes = new Set<string>();
  for (const [index, field] of memberships.entries()) {
    if (field.wireType !== 2 || !(field.value instanceof Uint8Array)) {
      throw new Error(`Registry SubnetRecord.membership[${index}] is malformed`);
    }
    const nodeId = canonicalPrincipalBytes(
      field.value,
      `Registry SubnetRecord.membership[${index}]`,
    );
    if (nodes.has(nodeId)) {
      throw new Error("Registry SubnetRecord contains a duplicate node");
    }
    nodes.add(nodeId);
  }

  const subnetTypeValue = oneVarint(
    fields,
    15,
    "Registry SubnetRecord.subnet_type",
  );
  const subnetType =
    subnetTypeValue === 1n
      ? "application"
      : subnetTypeValue === 4n
        ? "verified_application"
        : null;
  if (subnetType === null) {
    throw new Error(
      `${DEPLOYMENT_PRICING_PROFILE_V1} requires an application-family subnet type`,
    );
  }

  const features = oneBytes(
    fields,
    23,
    "Registry SubnetRecord.features",
  );
  const featureFields = parseProtobuf(features, "Registry SubnetFeatures");
  const sevValue =
    optionalVarint(
      featureFields,
      9,
      "Registry SubnetFeatures.sev_enabled",
    ) ?? 0n;
  if (sevValue !== 0n && sevValue !== 1n) {
    throw new Error(
      "Registry SubnetFeatures.sev_enabled must be an explicit Boolean",
    );
  }

  const costFields = fields.filter((field) => field.number === 30);
  let costSchedule = 0n;
  if (costFields.length > 1) {
    throw new Error(
      "Registry SubnetRecord.canister_cycles_cost_schedule is duplicated",
    );
  }
  if (costFields.length === 1) {
    const field = costFields[0]!;
    if (field.wireType !== 0 || typeof field.value !== "bigint") {
      throw new Error(
        "Registry SubnetRecord.canister_cycles_cost_schedule is malformed",
      );
    }
    costSchedule = field.value;
  }
  if (costSchedule !== 0n && costSchedule !== 1n) {
    throw new Error(
      `${DEPLOYMENT_PRICING_PROFILE_V1} requires the normal canister cycles cost schedule`,
    );
  }

  if (
    nodes.size !== 13 &&
    !(nodes.size === 7 && sevValue === 1n)
  ) {
    throw new Error(
      `${DEPLOYMENT_PRICING_PROFILE_V1} requires 13 subnet members or 7 members with SEV enabled`,
    );
  }

  return {
    subnetType,
    nodeCount: nodes.size,
    sevEnabled: sevValue === 1n,
    costSchedule: "normal",
  };
}

function encodeGetValueRequest(
  key: Uint8Array,
  version: bigint,
): Uint8Array {
  const wrappedVersion = concatBytes(
    Uint8Array.of(0x08),
    encodeVarint(version),
  );
  return concatBytes(
    Uint8Array.of(0x0a),
    encodeVarint(BigInt(wrappedVersion.byteLength)),
    wrappedVersion,
    Uint8Array.of(0x12),
    encodeVarint(BigInt(key.byteLength)),
    key,
  );
}

function registryProofBundle({
  policy,
  subnetId,
  registryKey,
  snapshotVersion,
  recordMutationVersion,
  rawSubnetRecord,
  latestCall,
  valueCall,
}: {
  policy: IcRegistryEvidencePolicyV1;
  subnetId: string;
  registryKey: string;
  snapshotVersion: bigint;
  recordMutationVersion: bigint;
  rawSubnetRecord: Uint8Array;
  latestCall: CertifiedRegistryCallV1;
  valueCall: CertifiedRegistryCallV1;
}): Uint8Array {
  const proof = {
    schema: 1,
    source: IC_REGISTRY_EVIDENCE_SOURCE_V1,
    policy: {
      source: policy.source,
      registry_canister: policy.registry_canister,
      root_key_sha256: policy.root_key_sha256,
      pricing_profile: policy.pricing_profile,
    },
    subnet_id: subnetId,
    registry_key: registryKey,
    snapshot_registry_version: snapshotVersion.toString(),
    subnet_record_mutation_version: recordMutationVersion.toString(),
    raw_subnet_record_base64: base64(rawSubnetRecord),
    latest_version_call: proofCall(latestCall),
    subnet_value_call: proofCall(valueCall),
  } satisfies JsonValue;
  return rfc8785JcsBytes(proof);
}

function proofCall(call: CertifiedRegistryCallV1): JsonValue {
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

function exactPolicy(value: unknown): IcRegistryEvidencePolicyV1 {
  const policy = plainRecord(value, "IC Registry evidence policy");
  exactKeys(
    policy,
    ["source", "registry_canister", "root_key_sha256", "pricing_profile"],
    "IC Registry evidence policy",
  );
  if (policy.source !== IC_REGISTRY_EVIDENCE_SOURCE_V1) {
    throw new Error(
      `IC Registry evidence policy.source must be ${IC_REGISTRY_EVIDENCE_SOURCE_V1}`,
    );
  }
  if (policy.registry_canister !== IC_REGISTRY_CANISTER_ID_V1) {
    throw new Error(
      `IC Registry evidence policy.registry_canister must be ${IC_REGISTRY_CANISTER_ID_V1}`,
    );
  }
  if (policy.root_key_sha256 !== IC_MAINNET_ROOT_KEY_SHA256) {
    throw new Error(
      `IC Registry evidence policy.root_key_sha256 must be ${IC_MAINNET_ROOT_KEY_SHA256}`,
    );
  }
  if (policy.pricing_profile !== DEPLOYMENT_PRICING_PROFILE_V1) {
    throw new Error(
      `IC Registry evidence policy.pricing_profile must be ${DEPLOYMENT_PRICING_PROFILE_V1}`,
    );
  }
  return {
    source: IC_REGISTRY_EVIDENCE_SOURCE_V1,
    registry_canister: IC_REGISTRY_CANISTER_ID_V1,
    root_key_sha256: IC_MAINNET_ROOT_KEY_SHA256,
    pricing_profile: DEPLOYMENT_PRICING_PROFILE_V1,
  };
}

function assertTransport(
  value: unknown,
): asserts value is CertifiedRegistryTransportV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { execute?: unknown }).execute !== "function"
  ) {
    throw new Error("Certified Registry transport must implement execute()");
  }
}

function normalizeSubmittedRequest(
  request: CallRequest,
): CertifiedRegistryCallRequestV1 {
  const sender = Principal.from(request.sender).toText();
  const nonce =
    request.nonce === undefined
      ? null
      : boundedBytes(
          request.nonce,
          "Registry request nonce",
          1,
          MAX_NONCE_BYTES,
        ).slice();
  return {
    canisterId: Principal.from(request.canister_id).toText(),
    methodName: request.method_name,
    arg: boundedBytes(
      request.arg,
      "Registry request argument",
      0,
      MAX_REGISTRY_REPLY_BYTES,
    ).slice(),
    sender,
    ingressExpiryNanos: request.ingress_expiry.toString(),
    nonce,
  };
}

function assertSubmittedRequest(
  request: CallRequest,
  canister: Principal,
  methodName: string,
  arg: Uint8Array,
): void {
  if (
    request.request_type !== "call" ||
    Principal.from(request.canister_id).toText() !== canister.toText() ||
    request.method_name !== methodName ||
    !equalBytes(request.arg, arg)
  ) {
    throw new Error(
      "IC agent changed the Registry request before request-ID binding",
    );
  }
  if (Principal.from(request.sender).toText() !== ANONYMOUS_PRINCIPAL) {
    throw new Error("Registry evidence calls must be anonymous");
  }
}

function foundLookup(
  result: ReturnType<Certificate["lookup_path"]>,
): Uint8Array | null {
  return result.status === LookupPathStatus.Found ? result.value : null;
}

function parseProtobuf(bytes: Uint8Array, label: string): ProtobufField[] {
  boundedBytes(bytes, label, 0, MAX_REGISTRY_REPLY_BYTES);
  const fields: ProtobufField[] = [];
  let cursor = 0;
  while (cursor < bytes.byteLength) {
    const tag = readVarint(bytes, cursor, `${label} tag`);
    cursor = tag.cursor;
    const number = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (number < 1 || number > 0x1fffffff) {
      throw new Error(`${label} contains an invalid field number`);
    }
    if (wireType === 0) {
      const decoded = readVarint(bytes, cursor, `${label} field ${number}`);
      cursor = decoded.cursor;
      fields.push({ number, wireType, value: decoded.value });
      continue;
    }
    if (wireType === 1 || wireType === 5) {
      const length = wireType === 1 ? 8 : 4;
      ensureAvailable(bytes, cursor, length, label);
      fields.push({
        number,
        wireType,
        value: bytes.slice(cursor, cursor + length),
      });
      cursor += length;
      continue;
    }
    if (wireType === 2) {
      const decodedLength = readVarint(
        bytes,
        cursor,
        `${label} field ${number} length`,
      );
      cursor = decodedLength.cursor;
      if (decodedLength.value > BigInt(MAX_REGISTRY_REPLY_BYTES)) {
        throw new Error(`${label} length-delimited field is too large`);
      }
      const length = Number(decodedLength.value);
      ensureAvailable(bytes, cursor, length, label);
      fields.push({
        number,
        wireType,
        value: bytes.slice(cursor, cursor + length),
      });
      cursor += length;
      continue;
    }
    throw new Error(`${label} contains unsupported protobuf wire type ${wireType}`);
  }
  return fields;
}

function readVarint(
  bytes: Uint8Array,
  start: number,
  label: string,
): { value: bigint; cursor: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = start;
  for (let count = 0; count < 10; count += 1) {
    ensureAvailable(bytes, cursor, 1, label);
    const byte = bytes[cursor]!;
    cursor += 1;
    if (count === 9 && byte > 1) {
      throw new Error(`${label} exceeds uint64`);
    }
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      const encoded = encodeVarint(value);
      if (!equalBytes(encoded, bytes.slice(start, cursor))) {
        throw new Error(`${label} is not canonically encoded`);
      }
      return { value, cursor };
    }
    shift += 7n;
  }
  throw new Error(`${label} exceeds uint64`);
}

function encodeVarint(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error("protobuf uint64 is out of range");
  }
  const output: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    output.push(byte);
  } while (remaining !== 0n);
  return Uint8Array.from(output);
}

function oneVarint(
  fields: ProtobufField[],
  number: number,
  label: string,
): bigint {
  const matches = fields.filter((field) => field.number === number);
  if (
    matches.length !== 1 ||
    matches[0]!.wireType !== 0 ||
    typeof matches[0]!.value !== "bigint"
  ) {
    throw new Error(`${label} must occur exactly once as a varint`);
  }
  return matches[0]!.value as bigint;
}

function optionalVarint(
  fields: ProtobufField[],
  number: number,
  label: string,
): bigint | null {
  const matches = fields.filter((field) => field.number === number);
  if (matches.length === 0) return null;
  if (
    matches.length !== 1 ||
    matches[0]!.wireType !== 0 ||
    typeof matches[0]!.value !== "bigint"
  ) {
    throw new Error(`${label} must occur at most once as a varint`);
  }
  return matches[0]!.value as bigint;
}

function oneBytes(
  fields: ProtobufField[],
  number: number,
  label: string,
): Uint8Array {
  const matches = fields.filter((field) => field.number === number);
  if (
    matches.length !== 1 ||
    matches[0]!.wireType !== 2 ||
    !(matches[0]!.value instanceof Uint8Array)
  ) {
    throw new Error(
      `${label} must occur exactly once as a length-delimited field`,
    );
  }
  return matches[0]!.value as Uint8Array;
}

function decodeUnsignedLeb128(bytes: Uint8Array, label: string): bigint {
  let value = 0n;
  let shift = 0n;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (index >= 19) throw new Error(`${label} is too large`);
    const byte = bytes[index]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (index !== bytes.byteLength - 1) {
        throw new Error(`${label} has trailing bytes`);
      }
      return value;
    }
    shift += 7n;
  }
  throw new Error(`${label} is truncated`);
}

function certifiedTimeToIso(nanos: bigint): string {
  const milliseconds = nanos / 1_000_000n;
  if (milliseconds > 8_640_000_000_000_000n) {
    throw new Error("Certified Registry time is outside the Date range");
  }
  const date = new Date(Number(milliseconds));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Certified Registry time is invalid");
  }
  return date.toISOString();
}

function canonicalPrincipalBytes(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength < 1 || bytes.byteLength > 29) {
    throw new Error(`${label} is not a valid node principal`);
  }
  let principal: Principal;
  try {
    principal = Principal.fromUint8Array(bytes);
  } catch (error) {
    throw new Error(`${label} is not a valid node principal`, { cause: error });
  }
  const text = principal.toText();
  if (
    principal.isAnonymous() ||
    text === Principal.managementCanister().toText() ||
    !equalBytes(Principal.fromText(text).toUint8Array(), bytes)
  ) {
    throw new Error(`${label} is not a non-anonymous node principal`);
  }
  return text;
}

function canonicalNonAnonymousPrincipal(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a principal`);
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch (error) {
    throw new Error(`${label} must be a principal`, { cause: error });
  }
  if (
    principal.isAnonymous() ||
    principal.toText() === Principal.managementCanister().toText() ||
    principal.toText() !== value
  ) {
    throw new Error(`${label} must be a canonical non-anonymous principal`);
  }
  return value;
}

function mainnetRootKey(): Uint8Array {
  if (
    typeof IC_ROOT_KEY !== "string" ||
    IC_ROOT_KEY.length === 0 ||
    IC_ROOT_KEY.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(IC_ROOT_KEY)
  ) {
    throw new Error("The IC agent mainnet root key is not canonical DER hex");
  }
  return new Uint8Array(Buffer.from(IC_ROOT_KEY, "hex"));
}

function bareHttpsOrigin(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} must be a valid HTTPS origin`, { cause: error });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${label} must be a bare HTTPS origin`);
  }
  return url.origin;
}

function canonicalNat(value: unknown, label: string): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new Error(`${label} must be a canonical unsigned decimal`);
  }
  return BigInt(value);
}

function boundedBytes(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  ) {
    throw new Error(
      `${label} must contain ${minimum} through ${maximum} bytes`,
    );
  }
  return value;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !keys.includes(key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing field(s): ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    throw new Error(`${label} has unknown field(s): ${extra.join(", ")}`);
  }
}

function ensureAvailable(
  bytes: Uint8Array,
  cursor: number,
  length: number,
  label: string,
): void {
  if (
    cursor < 0 ||
    length < 0 ||
    cursor + length > bytes.byteLength
  ) {
    throw new Error(`${label} is truncated`);
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  return output;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    different |= left[index]! ^ right[index]!;
  }
  return different === 0;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return textDecoder.decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not UTF-8`, { cause: error });
  }
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeCanonicalBase64(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    ) ||
    value.length > Math.ceil(maximum / 3) * 4
  ) {
    throw new Error(`${label} must be canonical padded base64`);
  }
  const decoded = new Uint8Array(Buffer.from(value, "base64"));
  if (
    decoded.byteLength < minimum ||
    decoded.byteLength > maximum ||
    base64(decoded) !== value
  ) {
    throw new Error(
      `${label} must encode ${minimum} through ${maximum} bytes`,
    );
  }
  return decoded;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function orderedRegistryCallTime(
  latestVersionTime: bigint,
  subnetValueTime: bigint,
): bigint {
  if (
    subnetValueTime < latestVersionTime ||
    subnetValueTime - latestVersionTime >
      MAX_REGISTRY_CALL_TIME_SKEW_NANOS
  ) {
    throw new Error(
      "Certified Registry calls must be ordered and no more than five minutes apart",
    );
  }
  return subnetValueTime;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
