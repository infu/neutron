import type { HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { serve, sleep } from "bun";
import type {
  PocketIcCanisterCall,
  PocketIcIngressMessage,
} from "neutron-provision/src/pocketic_rest.js";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import {
  exactExpressionPath,
  publicationHeaders,
} from "./http_v2.ts";
import {
  HttpRequestMethod,
  KernelAppUsageMethod,
  KernelDiagnosticsMethod,
  QualificationMethods,
} from "./idl.ts";
import {
  CERTIFIED_ASSETS_QUALIFICATION_FIXTURES,
  certifiedAssetsQualificationFixture,
  type CertifiedAssetsQualificationFixtureId,
} from "./fixture_manifests.ts";
import {
  createQualificationSampleRuntime,
  createQualificationSampleRuntimeForTest,
  type QualificationSampleRuntimeInput,
} from "./sample_runtime.ts";

const CANISTER_ID = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const CONTROLLER = Principal.selfAuthenticating(
  Uint8Array.from({ length: 32 }, (_, index) => index + 1),
).toText();

type CallMode = "query" | "update";
type Reply = (
  mode: CallMode,
  call: PocketIcCanisterCall,
) => Uint8Array | Promise<Uint8Array>;

class FakePocketIcClient {
  readonly calls: Array<Readonly<{ mode: CallMode; call: PocketIcCanisterCall }>> =
    [];
  #pending: PocketIcCanisterCall | undefined;

  constructor(private readonly reply: Reply) {}

  async queryCanister(
    _instanceId: number,
    call: PocketIcCanisterCall,
  ): Promise<Uint8Array> {
    this.calls.push({ mode: "query", call });
    return this.reply("query", call);
  }

  async submitIngressMessage(
    _instanceId: number,
    call: PocketIcCanisterCall,
  ): Promise<PocketIcIngressMessage> {
    this.calls.push({ mode: "update", call });
    this.#pending = call;
    return { effectivePrincipal: "None", messageId: "AQ==" };
  }

  async awaitIngressMessage(
    _instanceId: number,
    _message: PocketIcIngressMessage,
  ): Promise<Uint8Array> {
    if (this.#pending === undefined) {
      throw new Error("No submitted ingress");
    }
    const call = this.#pending;
    this.#pending = undefined;
    return this.reply("update", call);
  }
}

describe("Certified Assets qualification SampleRuntime", () => {
  test("maps a behavior-scope logical query to its physical method and records exact Candid", async () => {
    const appId = "ca_qualification_aux_1";
    const client = new FakePocketIcClient((_mode, call) => {
      expect(call.method).toBe(
        physicalAppMethodName(appId, "qualification_scope_info"),
      );
      const decoded = IDL.decode(
        QualificationMethods.qualification_scope_info.argTypes,
        call.payload,
      );
      expect(decoded).toHaveLength(1);
      expect(decoded[0]).toBeNull();
      return encodeScopeInfo(appId);
    });
    const runtime = runtimeFor(appId, client);

    expect(await runtime.generation("immutable")).toBe(7n);
    const transcript = runtime.observations.candid;
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toEqual({
      schema: "neutron.kernel.certified-assets-raw-candid.v1",
      mode: "query",
      method: physicalAppMethodName(appId, "qualification_scope_info"),
      request: exact(callAt(client, 0).payload),
      reply: exact(encodeScopeInfo(appId)),
    });
    expect(Object.isFrozen(runtime.observations)).toBe(true);
    expect(Object.isFrozen(transcript)).toBe(true);
  });

  test("maps another scope's update and freezes the decoded result", async () => {
    const appId = "ca_qualification_aux_3";
    let executions = 0n;
    const client = new FakePocketIcClient((mode, call) => {
      if (mode === "query") {
        expect(call.method).toBe("kernel_app_usage_snapshot");
        return encodeKernelAppUsage(appId, {
          instructions: executions * 31n,
          executions,
          outgoingCycles: executions * 7n,
        });
      }
      expect(mode).toBe("update");
      expect(call.method).toBe(
        physicalAppMethodName(appId, "qualification_abort_stage"),
      );
      expect(
        IDL.decode(
          QualificationMethods.qualification_abort_stage.argTypes,
          call.payload,
        ),
      ).toEqual([9n]);
      executions += 1n;
      return new Uint8Array(IDL.encode(
        QualificationMethods.qualification_abort_stage.retTypes,
        [{ ok: null }],
      ));
    });
    const runtime = runtimeFor(appId, client);

    await runtime.call("kernel_app_usage", [null]);
    const result = await runtime.call("qualification_abort_stage", [9n]);
    expect(result).toEqual({ ok: null });
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      runtime.observations.candid.filter(({ mode }) => mode === "update"),
    ).toHaveLength(1);
    expect(runtime.observations.candid).toHaveLength(2);
    expect(client.calls.map(({ call }) => call.method)).toEqual([
      "kernel_app_usage_snapshot",
      physicalAppMethodName(appId, "qualification_abort_stage"),
      "kernel_app_usage_snapshot",
    ]);
    expect(runtime.updateUsageBrackets).toHaveLength(1);
    expect(runtime.updateUsageBrackets[0]?.method).toBe(
      physicalAppMethodName(appId, "qualification_abort_stage"),
    );
    expect(
      appUsageExecutions(runtime.updateUsageBrackets[0]!.before, appId),
    ).toBe(0n);
    expect(
      appUsageExecutions(runtime.updateUsageBrackets[0]!.after, appId),
    ).toBe(1n);
    expect(Object.isFrozen(runtime.updateUsageBrackets)).toBe(true);
    expect(Object.isFrozen(runtime.updateUsageBrackets[0])).toBe(true);
    expect(Object.isFrozen(runtime.updateUsageBrackets[0]!.before)).toBe(true);
    expect(Object.isFrozen(runtime.updateUsageBrackets[0]!.after)).toBe(true);
  });

  test("takes one source-owned usage/diagnostics snapshot through exact methods", async () => {
    const appId = "ca_qualification_aux_1";
    const client = new FakePocketIcClient((_mode, call) => {
      if (
        call.method ===
          physicalAppMethodName(appId, "qualification_usage")
      ) {
        return new Uint8Array(IDL.encode(
          QualificationMethods.qualification_usage.retTypes,
          [{ ok: usage() }],
        ));
      }
      if (call.method === "kernel_certified_assets_diagnostics") {
        return new Uint8Array(IDL.encode(
          KernelDiagnosticsMethod.retTypes,
          [diagnostics()],
        ));
      }
      if (call.method === "kernel_app_usage_snapshot") {
        return new Uint8Array(IDL.encode(
          KernelAppUsageMethod.retTypes,
          [{ snapshot_version: 2n, current_day: 4n, apps: [] }],
        ));
      }
      throw new Error(`Unexpected method ${call.method}`);
    });
    const runtime = runtimeFor(appId, client);

    const snapshot = await runtime.snapshotUsageAndDiagnostics();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(client.calls.map(({ call }) => call.method)).toEqual([
      physicalAppMethodName(appId, "qualification_usage"),
      "kernel_certified_assets_diagnostics",
      "kernel_app_usage_snapshot",
    ]);
    expect(runtime.observations.candid).toHaveLength(3);
  });

  test("records the raw http_request before the real verifier rejects upgrade", async () => {
    const appId = "ca_qualification_aux_1";
    const body = new Uint8Array([0x51]);
    const path = `/app/${appId}/_route/download/sample.bin`;
    const headers = publicationHeaders({
      contentTag: new Uint8Array(32),
      contentLength: body.byteLength,
      filename: "sample.bin",
    });
    const client = new FakePocketIcClient((_mode, call) => {
      expect(call.method).toBe("http_request");
      const [request] = IDL.decode(HttpRequestMethod.argTypes, call.payload) as [
        {
          method: string;
          url: string;
          headers: Array<[string, string]>;
          certificate_version: number[];
        },
      ];
      expect(request.method).toBe("GET");
      expect(request.url).toBe(path);
      expect(request.headers).toContainEqual([
        "Host",
        `${CANISTER_ID}.localhost:8000`,
      ]);
      expect(request.certificate_version).toEqual([2]);
      return new Uint8Array(IDL.encode(HttpRequestMethod.retTypes, [{
        body,
        headers,
        streaming_strategy: [],
        status_code: 200,
        upgrade: [true],
      }]));
    });
    const runtime = runtimeFor(appId, client);

    await expect(runtime.verifyHttp({
      canisterId: CANISTER_ID,
      url: `${runtime.gatewayOrigin}${path}`,
      method: "GET",
      status: 200,
      authority: "host_bound",
      expressionPath: exactExpressionPath(path),
      headers,
      body,
    })).rejects.toThrow("must not upgrade");
    expect(runtime.observations.candid.at(-1)?.method).toBe("http_request");
    expect(runtime.observations.http).toHaveLength(0);
  });

  test("derives bytes from the exact contract block formula", () => {
    const client = new FakePocketIcClient(() => {
      throw new Error("No transport expected");
    });
    const runtime = runtimeFor("ca_qualification_aux_1", client, {
      caseId: "mutable_key_cas",
      sample: 0,
    });
    const expected = createHash("sha256")
      .update("neutron.kernel.certified-assets-workload.v1")
      .update("\0")
      .update("mutable_key_cas")
      .update("\0")
      .update(u32(0))
      .update(new Uint8Array([0]))
      .update(u32(19))
      .update(new Uint8Array([0]))
      .update(u32(0))
      .digest();

    expect(runtime.deterministicBytes(19, 32)).toEqual(
      new Uint8Array(expected),
    );
  });

  test("preserves the block formula across counter carries and partial final blocks", () => {
    const runtime = runtimeFor("ca_qualification_aux_1", new FakePocketIcClient(() => {
      throw new Error("No transport expected");
    }), { caseId: "mutable_key_cas", sample: 0 });
    for (const step of [0, 19, 0xffff_ffff]) {
      // The 257th block crosses the first byte of the big-endian counter.
      const reference = Buffer.concat(Array.from({ length: 257 }, (_, block) =>
        createHash("sha256")
          .update("neutron.kernel.certified-assets-workload.v1\0mutable_key_cas\0")
          .update(u32(0))
          .update(new Uint8Array([0]))
          .update(u32(step))
          .update(new Uint8Array([0]))
          .update(u32(block))
          .digest(),
      ));
      for (const length of [0, 1, 31, 32, 33, 65, 8_193]) {
        expect(runtime.deterministicBytes(step, length)).toEqual(
          new Uint8Array(reference.subarray(0, length)),
        );
      }
    }
  });

  test("case runtimes share the isolated environment's control-operation queue", async () => {
    let active = 0;
    let maximumActive = 0;
    let requests = 0;
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        requests += 1;
        maximumActive = Math.max(maximumActive, ++active);
        await sleep(20);
        active -= 1;
        return Response.json({
          Ok: Buffer.from(encodeScopeInfo("ca_qualification_aux_1")).toString("base64"),
        });
      },
    });
    try {
      const environment: QualificationSampleRuntimeInput["environment"] = {
        controlUrl: `http://127.0.0.1:${server.port}/`,
        gatewayTransportOrigin: "http://127.0.0.2:8000",
        instanceId: 3,
        rootKeyBase64: "AQ==",
        controllerPrincipal: CONTROLLER,
        provision: { agent: {} as HttpAgent },
        canonicalCertifiedOrigin: (id) => `http://${id}.localhost:8000`,
      };
      const runtimes = Array.from({ length: 3 }, () => createQualificationSampleRuntime({
        environment,
        canisterId: CANISTER_ID,
        appId: "ca_qualification_aux_1",
        caseId: "mutable_key_cas",
        sample: 0,
        verifyGateway: false,
      }));
      await Promise.all(runtimes.map((runtime) => runtime.call("qualification_scope_info", [null])));
      expect(requests).toBe(3);
      expect(maximumActive).toBe(1);
      expect(active).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});

function runtimeFor(
  appId: CertifiedAssetsQualificationFixtureId,
  client: FakePocketIcClient,
  sample: Pick<QualificationSampleRuntimeInput, "caseId" | "sample"> = {
    caseId: "publication_lifecycle",
    sample: 0,
  },
) {
  return createQualificationSampleRuntimeForTest({
    environment: {
      controlUrl: "http://127.0.0.1:41001/",
      gatewayTransportOrigin: "http://127.0.0.2:8000",
      instanceId: 3,
      rootKeyBase64: "AQ==",
      controllerPrincipal: CONTROLLER,
      provision: { agent: {} as HttpAgent },
      canonicalCertifiedOrigin: (canisterId: string) =>
        `http://${canisterId}.localhost:8000`,
    },
    canisterId: CANISTER_ID,
    appId,
    caseId: sample.caseId,
    sample: sample.sample,
    verifyGateway: false,
  }, client);
}

function encodeScopeInfo(
  appId: CertifiedAssetsQualificationFixtureId,
): Uint8Array {
  const fixture = certifiedAssetsQualificationFixture(appId);
  return new Uint8Array(IDL.encode(
    QualificationMethods.qualification_scope_info.retTypes,
    [{
      ok: {
        installation_generation: 1n,
        store_authority_epoch: 1n,
        collections: fixture.certified_assets.collections.map((collection) => ({
          id: collection.id,
          kind:
            collection.kind === "publication"
              ? { publication: null }
              : collection.kind === "immutable_blob"
                ? { immutable_blob: null }
                : { mutable_blob: null },
          authority_epoch: 1n,
          generation: 7n,
          serving: { enabled: null },
          writes: { enabled: null },
          manifest_limits: limits(),
          effective_limits: limits(),
        })),
      },
    }],
  ));
}

function encodeKernelAppUsage(
  appId: CertifiedAssetsQualificationFixtureId,
  counters: Readonly<{
    instructions: bigint;
    executions: bigint;
    outgoingCycles: bigint;
  }>,
): Uint8Array {
  return new Uint8Array(IDL.encode(KernelAppUsageMethod.retTypes, [{
    snapshot_version: 2n,
    current_day: 4n,
    apps: [{
      app_id: appId,
      installation_uid: 1n,
      lifetime_instructions: counters.instructions,
      lifetime_executions: counters.executions,
      lifetime_outgoing_cycles: counters.outgoingCycles,
      lifetime_incoming_cycles_accepted: 0n,
      window_instructions: counters.instructions,
      window_executions: counters.executions,
      window_outgoing_cycles: counters.outgoingCycles,
      window_incoming_cycles_accepted: 0n,
      days: [],
    }],
  }]));
}

function appUsageExecutions(
  snapshot: unknown,
  appId: CertifiedAssetsQualificationFixtureId,
): bigint {
  const root = snapshot as { apps: Array<{
    app_id: string;
    lifetime_executions: bigint;
  }> };
  return root.apps.find(({ app_id: candidate }) => candidate === appId)!
    .lifetime_executions;
}

function limits() {
  return {
    entries: 64n,
    committed_bytes: 1n,
    object_bytes: 1n,
    staged_bytes: 1n,
    pending_stages: 1n,
    batch_operations: 1n,
    batch_bytes: 1n,
    general_receipts: 1n,
    revocation_lanes: 1n,
  };
}

function usageCounters() {
  return {
    live_entries: 0n,
    occupied_entry_slots: 0n,
    committed_body_bytes: 0n,
    reserved_committed_body_bytes: 0n,
    allocated_body_bytes: 0n,
    charged_metadata_bytes: 0n,
    accepted_staged_bytes: 0n,
    reserved_staged_bytes: 0n,
    detached_charged_bytes: 0n,
    active_stages: 0n,
    reserved_entry_slots: 0n,
    receipt_lanes: 0n,
    general_receipt_lanes: 0n,
    reserved_general_receipt_lanes: 0n,
    reserved_revocation_lanes: 0n,
    filled_revocation_lanes: 0n,
    receipt_nonce_indexes: 0n,
    receipt_expiry_indexes: 0n,
    cleanup_jobs: 0n,
  };
}

function usage() {
  return {
    current: usageCounters(),
    manifest_limits: limits(),
    effective_limits: limits(),
  };
}

function diagnostics() {
  return {
    implementation_binding: {
      allocator_layout_fingerprint: new Uint8Array(32),
      response_policy_fingerprint: new Uint8Array(32),
    },
    allocator: {
      header_valid: true,
      mutation_epoch: 0n,
      committed_high_water_bytes: 0n,
      allocated_bytes: 0n,
      allocated_extents: 0n,
      free_extents: 0n,
      descriptor_count: 0n,
      descriptor_limit: 1n,
      capacity_limit_bytes: 1n,
      allocatable_limit_bytes: 1n,
      allocatable_headroom_bytes: 1n,
      metadata_charge_bytes: 0n,
    },
    authenticated_forest: {
      healthy: true,
      dirty: false,
      commit_sequence: 0n,
      live_nodes: 0n,
      allocated_nodes: 0n,
      free_nodes: 0n,
      node_capacity: 1n,
      live_maps: 0n,
      allocated_maps: 0n,
      free_maps: 0n,
      map_capacity: 1n,
    },
    charging: {
      total_charged_bytes: 0n,
      total_installed_reservation_bytes: 0n,
      reserved_headroom_bytes: 0n,
      allocator_metadata_charge_bytes: 0n,
      envelope_used_bytes: 0n,
      envelope_limit_bytes: 1n,
      total_installed_arena_reservation_bytes: 0n,
      reserved_arena_headroom_bytes: 0n,
      arena_envelope_used_bytes: 0n,
      arena_envelope_limit_bytes: 1n,
      total_installed_arena_extent_reservation: 0n,
      reserved_arena_extent_headroom: 0n,
      arena_extent_envelope_used: 0n,
      arena_extent_envelope_limit: 1n,
    },
  };
}

function exact(value: Uint8Array) {
  return {
    bytes: value.byteLength,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function callAt(client: FakePocketIcClient, index: number): PocketIcCanisterCall {
  const call = client.calls[index]?.call;
  if (call === undefined) throw new Error(`Missing fake call ${index}`);
  return call;
}

function u32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

expect(CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.length).toBeGreaterThan(1);
