import { IDL } from "@dfinity/candid";
import type { HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import {
  PocketIcRestClient,
  type PocketIcCanisterCall,
} from "neutron-provision/src/pocketic_rest.js";
import {
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT,
  CERTIFIED_ASSETS_QUALIFICATION_CASES,
  type CertifiedAssetsQualificationCaseId,
} from "neutron-tools/src/certified_assets_qualification.js";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import type {
  SampleLogicalMethod,
  SampleRuntime,
} from "./cases.ts";
import type { IsolatedQualificationPocketIc } from "./environment.ts";
import {
  HttpRequestMethod,
  KernelAppUsageMethod,
  KernelDiagnosticsMethod,
  QualificationMethods,
  type QualificationMethodName,
} from "./idl.ts";
import {
  exactBytes,
  fetchAndVerifyCertifiedHttp,
  verifyCertifiedHttpQueryResponse,
  type CertifiedHttpQueryRequest,
  type CertifiedHttpQueryResponse,
  type ExpectedCertifiedHttpResponse,
} from "./http_v2.ts";
import {
  CERTIFIED_ASSETS_QUALIFICATION_FIXTURES,
  certifiedAssetsQualificationFixture,
  type CertifiedAssetsQualificationFixtureId,
} from "./fixture_manifests.ts";
import {
  CERTIFIED_ASSETS_RAW_CANDID_OBSERVATION_SCHEMA,
  type CertifiedHttpObservation,
  type RawCandidObservation,
} from "./receipt.ts";

const LIVE_DEVELOPMENT_GATEWAY = "http://127.0.0.1:8000/";
const QUALIFICATION_GATEWAY_TRANSPORT_ORIGIN = "http://127.0.0.2:8000";
const MAX_DETERMINISTIC_BYTES =
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.workload.publication_body_bytes;

type RawPocketIcClient = Pick<
  PocketIcRestClient,
  "submitIngressMessage" | "awaitIngressMessage" | "queryCanister"
>;

export type QualificationUsageDiagnosticsSnapshot = Readonly<{
  scope_usage: unknown;
  kernel_diagnostics: unknown;
  kernel_app_usage: unknown;
}>;

export type QualificationUpdateUsageBracket = Readonly<{
  method: string;
  before: unknown;
  after: unknown;
}>;

export interface QualificationSampleRuntime extends SampleRuntime {
  readonly appId: CertifiedAssetsQualificationFixtureId;
  readonly updateUsageBrackets:
    readonly QualificationUpdateUsageBracket[];
  rawHttpRequest(
    request: CertifiedHttpQueryRequest,
  ): Promise<CertifiedHttpQueryResponse>;
  snapshotUsageAndDiagnostics():
    Promise<QualificationUsageDiagnosticsSnapshot>;
}

type QualificationSampleRuntimeEnvironment = Pick<
  IsolatedQualificationPocketIc,
  | "controlUrl"
  | "gatewayTransportOrigin"
  | "instanceId"
  | "rootKeyBase64"
  | "controllerPrincipal"
  | "canonicalCertifiedOrigin"
> & {
  readonly provision: {
    readonly agent: HttpAgent;
  };
};

export type QualificationSampleRuntimeInput = Readonly<{
  environment: QualificationSampleRuntimeEnvironment;
  canisterId: string;
  appId: CertifiedAssetsQualificationFixtureId;
  caseId: CertifiedAssetsQualificationCaseId;
  sample: number;
  verifyGateway: boolean;
}>;

/**
 * Construct the release runtime from the source-owned isolated environment.
 * There is intentionally no caller-supplied client or verifier on this path.
 */
export function createQualificationSampleRuntime(
  input: QualificationSampleRuntimeInput,
): QualificationSampleRuntime {
  return createRuntime(
    input,
    new PocketIcRestClient(input.environment.controlUrl),
  );
}

/**
 * Narrow fake transport seam used only by this adapter's unit tests. Release
 * orchestration must call `createQualificationSampleRuntime`, whose transport
 * and verifier are fixed above.
 *
 * @internal
 */
export function createQualificationSampleRuntimeForTest(
  input: QualificationSampleRuntimeInput,
  client: RawPocketIcClient,
): QualificationSampleRuntime {
  return createRuntime(input, client);
}

class QualificationSampleRuntimeImpl
  implements QualificationSampleRuntime
{
  readonly canisterId: string;
  readonly appId: CertifiedAssetsQualificationFixtureId;
  readonly gatewayOrigin: string;
  readonly #instanceId: number;
  readonly #caller: Principal;
  readonly #canister: Principal;
  readonly #client: RawPocketIcClient;
  readonly #rootKey: Uint8Array;
  readonly #certificateAgent: HttpAgent;
  readonly #gatewayTransportOrigin: string;
  readonly #verifyGateway: boolean;
  readonly #sampleSeed: Uint8Array;
  readonly #collectionIds: ReadonlySet<string>;
  readonly #candid: RawCandidObservation[] = [];
  readonly #http: CertifiedHttpObservation[] = [];
  readonly #updateUsageBrackets: QualificationUpdateUsageBracket[] = [];
  #updateUsageCursor: unknown;
  #updateUsageCursorArmed = false;
  #callTail: Promise<void> = Promise.resolve();

  constructor(input: QualificationSampleRuntimeInput, client: RawPocketIcClient) {
    assertEnvironment(input.environment);
    this.canisterId = canonicalCanister(input.canisterId, "canisterId");
    this.appId = certifiedAssetsQualificationFixture(input.appId).app_id;
    this.gatewayOrigin = input.environment.canonicalCertifiedOrigin(
      this.canisterId,
    );
    if (
      this.gatewayOrigin !==
        `http://${this.canisterId}.localhost:8000`
    ) {
      throw new Error(
        "Qualification environment returned a foreign certified origin",
      );
    }
    this.#instanceId = nonnegativeSafeInteger(
      input.environment.instanceId,
      "PocketIC instanceId",
    );
    this.#caller = canonicalNonAnonymousPrincipal(
      input.environment.controllerPrincipal,
      "qualification controller",
    );
    this.#canister = Principal.fromText(this.canisterId);
    this.#client = client;
    this.#rootKey = canonicalBase64Bytes(
      input.environment.rootKeyBase64,
      "qualification root key",
    );
    this.#certificateAgent = input.environment.provision.agent;
    this.#gatewayTransportOrigin = input.environment.gatewayTransportOrigin;
    if (typeof input.verifyGateway !== "boolean") {
      throw new Error("Qualification verifyGateway must be boolean");
    }
    this.#verifyGateway = input.verifyGateway;
    this.#sampleSeed = sampleSeed(
      input.caseId,
      input.sample,
    );
    this.#collectionIds = new Set(
      certifiedAssetsQualificationFixture(this.appId).certified_assets
        .collections.map(({ id }) => id),
    );
  }

  get observations(): SampleRuntime["observations"] {
    return Object.freeze({
      candid: Object.freeze([...this.#candid]),
      http: Object.freeze([...this.#http]),
    });
  }

  get updateUsageBrackets(): readonly QualificationUpdateUsageBracket[] {
    return Object.freeze([...this.#updateUsageBrackets]);
  }

  call(method: SampleLogicalMethod, args: readonly unknown[]): Promise<unknown> {
    const binding = logicalBinding(this.appId, method);
    return this.#serialized(() =>
      this.#invoke(binding.physicalMethod, binding.method, args)
    );
  }

  async generation(collection: string): Promise<bigint> {
    if (!this.#collectionIds.has(collection)) {
      throw new Error(
        `Collection ${collection} is not declared by fixture ${this.appId}`,
      );
    }
    const result = exactVariant(
      await this.call("qualification_scope_info", [null]),
      "qualification_scope_info result",
    );
    if (!("ok" in result)) {
      throw new Error("qualification_scope_info returned a domain error");
    }
    const scope = record(result.ok, "qualification_scope_info.ok");
    const collections = array(
      scope.collections,
      "qualification_scope_info.ok.collections",
    );
    const generations = new Map<string, bigint>();
    for (const [index, value] of collections.entries()) {
      const entry = record(
        value,
        `qualification_scope_info.ok.collections[${index}]`,
      );
      if (
        typeof entry.id !== "string" ||
        typeof entry.generation !== "bigint" ||
        entry.generation < 0n ||
        generations.has(entry.id)
      ) {
        throw new Error("qualification_scope_info returned invalid collections");
      }
      generations.set(entry.id, entry.generation);
    }
    if (
      generations.size !== this.#collectionIds.size ||
      [...this.#collectionIds].some((id) => !generations.has(id))
    ) {
      throw new Error(
        `qualification_scope_info does not match fixture ${this.appId}`,
      );
    }
    return generations.get(collection)!;
  }

  deterministicBytes(step: number, length: number): Uint8Array {
    if (!Number.isSafeInteger(step) || step < 0 || step > 0xffff_ffff) {
      throw new Error("Deterministic workload step must be a uint32");
    }
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_DETERMINISTIC_BYTES
    ) {
      throw new Error("Deterministic workload length is outside its bound");
    }
    const output = new Uint8Array(length);
    for (let block = 0, offset = 0; offset < length; block += 1) {
      const digest = createHash("sha256")
        .update(this.#sampleSeed)
        .update(uint32Bytes(step))
        .update(new Uint8Array([0]))
        .update(uint32Bytes(block))
        .digest();
      const take = Math.min(digest.byteLength, length - offset);
      output.set(digest.subarray(0, take), offset);
      offset += take;
    }
    return output;
  }

  async rawHttpRequest(
    request: CertifiedHttpQueryRequest,
  ): Promise<CertifiedHttpQueryResponse> {
    return this.#serialized(async () => {
      const value = await this.#invoke(
        "http_request",
        HttpRequestMethod,
        [copyHttpRequest(request)],
      );
      return value as CertifiedHttpQueryResponse;
    });
  }

  async verifyHttp(
    expected: ExpectedCertifiedHttpResponse,
  ): Promise<CertifiedHttpObservation> {
    if (expected.canisterId !== this.canisterId) {
      throw new Error("Certified HTTP expectation targets another canister");
    }
    const url = new URL(expected.url);
    if (url.origin !== this.gatewayOrigin) {
      throw new Error(
        "Certified HTTP expectation is not on the qualification canister origin",
      );
    }
    const request: CertifiedHttpQueryRequest = {
      method: expected.method,
      url: `${url.pathname}${url.search}`,
      headers: effectiveRequestHeaders(url, expected.requestHeaders ?? []),
      body: new Uint8Array(),
      certificate_version: [2],
    };
    const response = await this.rawHttpRequest(request);
    const observation = deepFreezeDecoded(
      await verifyCertifiedHttpQueryResponse(
        expected,
        this.#rootKey,
        request,
        response,
        this.#certificateAgent,
      ),
    ) as CertifiedHttpObservation;
    this.#http.push(observation);
    if (this.#verifyGateway) {
      const gatewayObservation = deepFreezeDecoded(
        await fetchAndVerifyCertifiedHttp(
          expected,
          this.#rootKey,
          globalThis.fetch,
          this.#certificateAgent,
          this.#gatewayTransportOrigin,
        ),
      ) as CertifiedHttpObservation;
      this.#http.push(gatewayObservation);
    }
    return observation;
  }

  async snapshotUsageAndDiagnostics():
    Promise<QualificationUsageDiagnosticsSnapshot> {
    const certifiedAssetsUsage = await this.call(
      "qualification_usage",
      [null],
    );
    const kernelDiagnostics = await this.call("kernel_diagnostics", [null]);
    const kernelAppUsage = await this.call("kernel_app_usage", [null]);
    return deepFreezeDecoded({
      scope_usage: certifiedAssetsUsage,
      kernel_diagnostics: kernelDiagnostics,
      kernel_app_usage: kernelAppUsage,
    }) as QualificationUsageDiagnosticsSnapshot;
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#callTail.then(operation, operation);
    this.#callTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #invoke(
    physicalMethod: string,
    method: IDL.FuncClass,
    args: readonly unknown[],
  ): Promise<unknown> {
    const request = new Uint8Array(IDL.encode(method.argTypes, [...args]));
    const mode = method.annotations.some(
      (annotation) =>
        annotation === "query" || annotation === "composite_query",
    )
      ? "query"
      : "update";
    const call: PocketIcCanisterCall = {
      sender: this.#caller,
      canisterId: this.#canister,
      method: physicalMethod,
      payload: request,
    };
    const meterUpdate = mode === "update" && this.#updateUsageCursorArmed;
    const usageBefore = meterUpdate ? this.#updateUsageCursor : undefined;
    const reply = mode === "query"
      ? await this.#client.queryCanister(this.#instanceId, call)
      : await this.#client.awaitIngressMessage(
          this.#instanceId,
          await this.#client.submitIngressMessage(this.#instanceId, call),
        );
    const usageAfter = meterUpdate
      ? await this.#unobservedKernelAppUsageSnapshot()
      : undefined;
    if (!(reply instanceof Uint8Array)) {
      throw new Error(`PocketIC ${physicalMethod} returned non-byte Candid`);
    }
    const value = decodeSingleReply(method, reply, physicalMethod);
    this.#candid.push(Object.freeze({
      schema: CERTIFIED_ASSETS_RAW_CANDID_OBSERVATION_SCHEMA,
      mode,
      method: physicalMethod,
      request: Object.freeze(exactBytes(request)),
      reply: Object.freeze(exactBytes(reply)),
    }));
    if (
      mode === "query" &&
      physicalMethod === "kernel_app_usage_snapshot"
    ) {
      this.#updateUsageCursor = value;
      this.#updateUsageCursorArmed = true;
    }
    if (meterUpdate) {
      this.#updateUsageBrackets.push(Object.freeze({
        method: physicalMethod,
        before: usageBefore,
        after: usageAfter,
      }));
      this.#updateUsageCursor = usageAfter;
    }
    return value;
  }

  async #unobservedKernelAppUsageSnapshot(): Promise<unknown> {
    const request = new Uint8Array(IDL.encode(
      KernelAppUsageMethod.argTypes,
      [null],
    ));
    const physicalMethod = "kernel_app_usage_snapshot";
    const reply = await this.#client.queryCanister(this.#instanceId, {
      sender: this.#caller,
      canisterId: this.#canister,
      method: physicalMethod,
      payload: request,
    });
    if (!(reply instanceof Uint8Array)) {
      throw new Error(`PocketIC ${physicalMethod} returned non-byte Candid`);
    }
    return decodeSingleReply(KernelAppUsageMethod, reply, physicalMethod);
  }
}

function decodeSingleReply(
  method: IDL.FuncClass,
  reply: Uint8Array,
  physicalMethod: string,
): unknown {
  const decoded = IDL.decode(method.retTypes, reply);
  if (decoded.length !== method.retTypes.length || decoded.length !== 1) {
    throw new Error(
      `PocketIC ${physicalMethod} returned the wrong Candid arity`,
    );
  }
  return deepFreezeDecoded(decoded[0]);
}

function createRuntime(
  input: QualificationSampleRuntimeInput,
  client: RawPocketIcClient,
): QualificationSampleRuntime {
  if (
    !CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.some(
      ({ app_id: appId }) => appId === input.appId,
    )
  ) {
    throw new Error(
      `Unknown Certified Assets qualification fixture ${input.appId}`,
    );
  }
  return new QualificationSampleRuntimeImpl(input, client);
}

function logicalBinding(
  appId: CertifiedAssetsQualificationFixtureId,
  method: SampleLogicalMethod,
): Readonly<{ physicalMethod: string; method: IDL.FuncClass }> {
  if (method === "kernel_diagnostics") {
    return {
      physicalMethod: "kernel_certified_assets_diagnostics",
      method: KernelDiagnosticsMethod,
    };
  }
  if (method === "kernel_app_usage") {
    return {
      physicalMethod: "kernel_app_usage_snapshot",
      method: KernelAppUsageMethod,
    };
  }
  const candid = QualificationMethods[method as QualificationMethodName];
  if (candid === undefined) {
    throw new Error(`Unknown qualification method ${method}`);
  }
  return {
    physicalMethod: physicalAppMethodName(appId, method),
    method: candid,
  };
}

function copyHttpRequest(
  request: CertifiedHttpQueryRequest,
): CertifiedHttpQueryRequest {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers.map(([name, value]) => [name, value] as const),
    body: new Uint8Array(request.body),
    certificate_version: [...request.certificate_version],
  };
}

function effectiveRequestHeaders(
  url: URL,
  headers: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  const hosts = headers.filter(([name]) => name.toLowerCase() === "host");
  return hosts.length === 0
    ? [
        ["Host", url.host],
        ...headers.map(([name, value]) => [name, value] as const),
      ]
    : headers.map(([name, value]) => [name, value] as const);
}

function assertEnvironment(
  environment: QualificationSampleRuntimeInput["environment"],
): void {
  const control = exactLoopbackUrl(environment.controlUrl, "controlUrl");
  if (control.href === LIVE_DEVELOPMENT_GATEWAY) {
    throw new Error(
      "Qualification cannot attach to the live development gateway",
    );
  }
  if (
    environment.gatewayTransportOrigin !==
      QUALIFICATION_GATEWAY_TRANSPORT_ORIGIN
  ) {
    throw new Error(
      `Qualification gateway must be the isolated ${QUALIFICATION_GATEWAY_TRANSPORT_ORIGIN}`,
    );
  }
}

function exactLoopbackUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "127.0.0.2") ||
    url.port === "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.href !== value
  ) {
    throw new Error(`${label} must be a canonical loopback HTTP origin`);
  }
  return url;
}

function canonicalCanister(value: string, label: string): string {
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch {
    throw new Error(`${label} must be a canonical canister principal`);
  }
  const bytes = principal.toUint8Array();
  if (
    principal.toText() !== value ||
    bytes.byteLength < 2 ||
    bytes.at(-1) !== 0x01
  ) {
    throw new Error(`${label} must be a canonical canister principal`);
  }
  return value;
}

function canonicalNonAnonymousPrincipal(value: string, label: string): Principal {
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch {
    throw new Error(`${label} must be a canonical principal`);
  }
  if (
    principal.toText() !== value ||
    value === Principal.anonymous().toText()
  ) {
    throw new Error(`${label} must be a canonical non-anonymous principal`);
  }
  return principal;
}

function canonicalBase64Bytes(value: string, label: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > 4 * 1024 ||
    decoded.toString("base64") !== value
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  return new Uint8Array(decoded);
}

function sampleSeed(
  caseId: CertifiedAssetsQualificationCaseId,
  sample: number,
): Uint8Array {
  if (
    !CERTIFIED_ASSETS_QUALIFICATION_CASES.some(({ id }) => id === caseId)
  ) {
    throw new Error(`Unknown Certified Assets qualification case ${caseId}`);
  }
  if (
    !Number.isSafeInteger(sample) ||
    sample < 0 ||
    sample >=
      CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.minimum_samples_per_case
  ) {
    throw new Error("Qualification sample index is outside the contract");
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(
        CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.workload.seed_domain,
        "utf8",
      ),
      Buffer.from([0]),
      Buffer.from(caseId, "utf8"),
      Buffer.from([0]),
      Buffer.from(uint32Bytes(sample)),
      Buffer.from([0]),
    ]),
  );
}

function uint32Bytes(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

function deepFreezeDecoded(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    // ECMAScript forbids freezing a non-empty typed array. Returning a fresh
    // copy prevents the Candid decoder's backing bytes from being retained;
    // every containing record and ordinary array is frozen below.
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreezeDecoded));
  }
  if (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          deepFreezeDecoded(entry),
        ]),
      ),
    );
  }
  return value;
}

function exactVariant(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const candidate = record(value, label);
  if (Object.keys(candidate).length !== 1) {
    throw new Error(`${label} must contain exactly one variant`);
  }
  return candidate;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}
