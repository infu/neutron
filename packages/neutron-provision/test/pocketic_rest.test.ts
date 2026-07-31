import { Cbor } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  NEUTRON_POCKET_IC_BITCOIND,
  NEUTRON_POCKET_IC_SUBNET_KINDS,
  PocketIcRestClient,
  createNeutronPocketIcInstanceConfig,
  normalizePocketIcControlUrl,
  normalizePocketIcGatewayUrl,
  pocketIcInstanceConfigDigest,
  summarizePocketIcTopology,
} from "../src/pocketic_rest.ts";
import {
  jsonResponse,
  pocketIcCreatedResponse,
  pocketIcTestTopology,
} from "./pocketic_test_fixture.ts";

describe("Neutron PocketIC REST schema", () => {
  test("builds the exact persistent seven-subnet, ICP-feature, live gateway request", () => {
    const stateDirectory = path.resolve("/tmp/neutron-state");
    const config = createNeutronPocketIcInstanceConfig({
      profile: "full_protocol_fixtures",
      stateDirectory,
    });

    expect(config).toEqual({
      subnet_config_set: {
        nns: subnetSpec(),
        sns: subnetSpec(),
        ii: subnetSpec(),
        fiduciary: subnetSpec(),
        bitcoin: subnetSpec(),
        test_threshold_keys: subnetSpec(),
        system: [],
        application: [subnetSpec()],
        cloud_engine: [],
        verified_application: [],
      },
      http_gateway_config: {
        ip_addr: "127.0.0.1",
        port: 8000,
        domains: null,
        https_config: null,
        domain_custom_provider_local_file: null,
      },
      state_dir: stateDirectory,
      icp_config: null,
      log_level: null,
      bitcoind_addr: [NEUTRON_POCKET_IC_BITCOIND],
      dogecoind_addr: null,
      icp_features: {
        registry: "DefaultConfig",
        cycles_minting: "DefaultConfig",
        icp_token: "DefaultConfig",
        cycles_token: "DefaultConfig",
        nns_governance: "DefaultConfig",
        sns: "DefaultConfig",
        ii: "DefaultConfig",
        nns_ui: "DefaultConfig",
        bitcoin: "DefaultConfig",
        dogecoin: null,
        canister_migration: "DefaultConfig",
      },
      incomplete_state: "Disabled",
      initial_time: { AutoProgress: { artificial_delay_ms: null } },
      mainnet_nns_subnet_id: true,
      disable_ingress_validation: false,
    });
    expect(pocketIcInstanceConfigDigest(config)).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      createNeutronPocketIcInstanceConfig({
        profile: "full_protocol_fixtures",
        stateDirectory,
        gatewayPort: 8001,
      }),
    ).toThrow("fixed at localhost:8000");
    expect(() =>
      createNeutronPocketIcInstanceConfig({
        profile: "full_protocol_fixtures",
        stateDirectory: "relative",
      }),
    ).toThrow("must be an absolute path");
  });

  test("parses the current v14 Created response and records exact topology identity", async () => {
    const topology = pocketIcTestTopology();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new PocketIcRestClient("http://127.0.0.1:41000/", {
      fetcher: async (input, init) => {
        requests.push({ url: input.toString(), ...(init === undefined ? {} : { init }) });
        return jsonResponse(pocketIcCreatedResponse(topology));
      },
    });
    const config = createNeutronPocketIcInstanceConfig({
      profile: "full_protocol_fixtures",
      stateDirectory: path.resolve("/tmp/neutron-state"),
    });
    const result = await client.createInstance(
      config,
      "full_protocol_fixtures",
    );

    expect(result.instanceId).toBe(0);
    expect(result.gatewayId).toBe(0);
    expect(result.gatewayPort).toBe(8000);
    expect(result.topology).toEqual(topology);
    expect(Object.keys(result.topologySummary.subnetIds).sort()).toEqual(
      [...NEUTRON_POCKET_IC_SUBNET_KINDS].sort(),
    );
    expect(result.topologySummary.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:41000/instances");
    expect(requests[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual(config);
  });

  test("validates health, availability, topology, progress, and the gateway root key", async () => {
    const topology = pocketIcTestTopology();
    const rootKey = new Uint8Array([1, 2, 3, 4, 5]);
    const client = new PocketIcRestClient("http://127.0.0.1:41000/", {
      fetcher: async (input) => {
        const url = new URL(input);
        if (url.origin === "http://127.0.0.1:8000") {
          return new Response(
            arrayBuffer(Cbor.encode({
              root_key: rootKey,
              replica_health_status: "healthy",
            })),
            { status: 200, headers: { "Content-Type": "application/cbor" } },
          );
        }
        if (url.pathname === "/status") return new Response(null, { status: 200 });
        if (url.pathname === "/instances") return jsonResponse(["Available"]);
        if (url.pathname === "/instances/0/read/topology") {
          return jsonResponse(topology);
        }
        if (url.pathname === "/instances/0/auto_progress") {
          return jsonResponse(true);
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });

    await expect(client.assertServerHealthy()).resolves.toBeUndefined();
    await expect(client.listInstances()).resolves.toEqual(["Available"]);
    await expect(
      client.readTopology(0, "full_protocol_fixtures"),
    ).resolves.toEqual(topology);
    await expect(client.isAutoProgressEnabled(0)).resolves.toBe(true);
    await expect(client.gatewayStatus()).resolves.toEqual({
      rootKeyBase64: Buffer.from(rootKey).toString("base64"),
      replicaHealthStatus: "healthy",
    });
  });

  test("rejects topology drift and non-loopback attachment URLs", () => {
    const topology = pocketIcTestTopology();
    const firstId = Object.keys(topology.subnet_configs)[0]!;
    topology.subnet_configs[firstId]!.instruction_config =
      "Benchmarking" as "Production";
    expect(() =>
      summarizePocketIcTopology(topology, "full_protocol_fixtures"),
    ).toThrow(
      "is not in Production mode",
    );
    expect(() => normalizePocketIcControlUrl("http://example.com:41000/")).toThrow(
      "plain loopback HTTP origin",
    );
    expect(() => normalizePocketIcGatewayUrl("http://localhost:8001/")).toThrow(
      "must use port 8000",
    );
  });

  test("surfaces the server's create-instance Error variant", async () => {
    const client = new PocketIcRestClient("http://127.0.0.1:41000/", {
      fetcher: async () =>
        jsonResponse({ Error: { message: "state directory is already in use" } }),
    });
    await expect(
      client.createInstance(
        createNeutronPocketIcInstanceConfig({
          profile: "full_protocol_fixtures",
          stateDirectory: path.resolve("/tmp/neutron-state"),
        }),
        "full_protocol_fixtures",
      ),
    ).rejects.toThrow(
      "PocketIC could not create the Neutron instance: state directory is already in use",
    );
  });

  test("minimal profile includes the NNS trust root required by Internet Identity", () => {
    const config = createNeutronPocketIcInstanceConfig({
      profile: "minimal",
      stateDirectory: path.resolve("/tmp/neutron-minimal"),
    });
    expect(config.subnet_config_set).toMatchObject({
      nns: subnetSpec(),
      sns: null,
      ii: subnetSpec(),
      fiduciary: null,
      bitcoin: null,
      test_threshold_keys: subnetSpec(),
      application: [subnetSpec()],
    });
    expect(config.bitcoind_addr).toBeNull();
    expect(config.mainnet_nns_subnet_id).toBe(false);
    expect(config.icp_features).toEqual({
      registry: null,
      cycles_minting: null,
      icp_token: null,
      cycles_token: null,
      nns_governance: null,
      sns: null,
      ii: "DefaultConfig",
      nns_ui: null,
      bitcoin: null,
      dogecoin: null,
      canister_migration: null,
    });

    const topology = pocketIcTestTopology();
    topology.subnet_configs = Object.fromEntries(
      Object.entries(topology.subnet_configs).filter(([, subnet]) =>
        ["Application", "NNS", "II", "TestThresholdKeys"].includes(
          subnet.subnet_kind,
        ),
      ),
    );
    expect(
      summarizePocketIcTopology(topology, "minimal").summary.subnetIds,
    ).toEqual(
      Object.fromEntries(
        Object.entries(topology.subnet_configs).map(
          ([subnetId, subnet]) => [subnet.subnet_kind, subnetId],
        ),
      ),
    );
  });

  test("submits and awaits every caller-bound ingress through the instance control path", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    let active = 0;
    let maximumActive = 0;
    let nextMessage = 1;
    const client = new PocketIcRestClient("http://127.0.0.1:41000/", {
      fetcher: async (input, init) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          const url = new URL(input);
          const body = JSON.parse(String(init?.body)) as unknown;
          requests.push({ path: url.pathname, body });
          if (url.pathname.endsWith("/submit_ingress_message")) {
            return jsonResponse({
              Ok: {
                effective_principal: "None",
                message_id: Buffer.from(
                  new Uint8Array(32).fill(nextMessage++),
                ).toString("base64"),
              },
            });
          }
          if (url.pathname.endsWith("/await_ingress_message")) {
            return jsonResponse({ Ok: Buffer.from([68, 73, 68, 76]).toString("base64") });
          }
          if (url.pathname.endsWith("/read/query")) {
            return jsonResponse({ Ok: Buffer.from([7, 8]).toString("base64") });
          }
          throw new Error(`Unexpected request ${url.pathname}`);
        } finally {
          active -= 1;
        }
      },
    });
    const sender = Principal.fromText("aaaaa-aa");
    const canisterId = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
    const effectiveCanisterId =
      Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
    const calls = ["/one.js", "/two.js"].map((method, index) => ({
      sender,
      canisterId,
      method,
      payload: new Uint8Array([index + 1]),
      ...(index === 0
        ? {
            effectivePrincipal: {
              CanisterId: Buffer.from(
                effectiveCanisterId.toUint8Array(),
              ).toString("base64"),
            },
          }
        : {}),
    }));

    const messages = await Promise.all(
      calls.map((call) => client.submitIngressMessage(3, call)),
    );
    const replies = await Promise.all(
      messages.map((message) => client.awaitIngressMessage(3, message)),
    );
    const query = await client.queryCanister(3, calls[0]!);

    expect(maximumActive).toBe(1);
    expect(replies.map((reply) => [...reply])).toEqual([
      [68, 73, 68, 76],
      [68, 73, 68, 76],
    ]);
    expect([...query]).toEqual([7, 8]);
    expect(requests.map(({ path }) => path)).toEqual([
      "/instances/3/update/submit_ingress_message",
      "/instances/3/update/submit_ingress_message",
      "/instances/3/update/await_ingress_message",
      "/instances/3/update/await_ingress_message",
      "/instances/3/read/query",
    ]);
    expect(requests.slice(0, 2).map(({ body }) => body)).toEqual(
      calls.map((call) => ({
        sender: Buffer.from(sender.toUint8Array()).toString("base64"),
        canister_id: Buffer.from(canisterId.toUint8Array()).toString("base64"),
        method: call.method,
        payload: Buffer.from(call.payload).toString("base64"),
        effective_principal: call.effectivePrincipal ?? "None",
      })),
    );
    expect(requests.slice(2, 4).map(({ body }) => body)).toEqual(
      messages.map((message) => ({
        effective_principal: message.effectivePrincipal,
        message_id: message.messageId,
      })),
    );
  });

  test("polls opaque PocketIC operation references with canonical URL-safe state labels", async () => {
    const stateLabel = Buffer.from(new Uint8Array(16).fill(250))
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_");
    const operationId = "submit_ingress_message(CanisterId(rwlgt-iiaaa-aaaaa-aaaaa-cai))";
    const paths: string[] = [];
    const client = new PocketIcRestClient("http://127.0.0.1:41000/", {
      fetcher: async (input) => {
        const { pathname } = new URL(input);
        paths.push(pathname);
        if (pathname.endsWith("/submit_ingress_message")) {
          return jsonResponse(
            { state_label: stateLabel, op_id: operationId },
            202,
          );
        }
        if (pathname.startsWith("/read_graph/")) {
          return jsonResponse({
            Ok: {
              effective_principal: "None",
              message_id: Buffer.alloc(32, 7).toString("base64"),
            },
          });
        }
        throw new Error(`Unexpected request ${pathname}`);
      },
    });

    await expect(
      client.submitIngressMessage(3, {
        sender: Principal.fromText("aaaaa-aa"),
        canisterId: Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"),
        method: "kernel_static",
        payload: new Uint8Array([1]),
      }),
    ).resolves.toEqual({
      effectivePrincipal: "None",
      messageId: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(paths).toEqual([
      "/instances/3/update/submit_ingress_message",
      `/read_graph/${encodeURIComponent(stateLabel)}/${encodeURIComponent(operationId)}`,
    ]);
  });

  test("rejects a malformed explicit effective principal", async () => {
    const client = new PocketIcRestClient("http://127.0.0.1:41000/", {
      fetcher: async () => {
        throw new Error("Malformed calls must fail before transport");
      },
    });

    await expect(
      client.submitIngressMessage(3, {
        sender: Principal.fromText("aaaaa-aa"),
        canisterId: Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"),
        method: "canister_status",
        payload: new Uint8Array(),
        effectivePrincipal: {
          CanisterId: "not canonical base64",
        },
      }),
    ).rejects.toThrow(
      "PocketIC canister call effective principal.CanisterId must be canonical base64",
    );
  });
});

function subnetSpec() {
  return {
    state_config: "New" as const,
    instruction_config: "Production" as const,
    subnet_admins: null,
    cost_schedule: "Normal" as const,
  };
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
