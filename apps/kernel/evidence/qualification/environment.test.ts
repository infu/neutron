import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { describe, expect, test } from "bun:test";
import { localManagementIdl } from "neutron-provision/src/idl.js";
import {
  assertQualificationHostWallSafety,
  createIsolatedQualificationInstanceConfig,
  encodeQualificationInstallChunkedCodeCall,
  parseQualificationInstanceCreation,
  qualificationManagementStatusFromWire,
  qualificationInstanceConfigSha256,
} from "./environment.ts";

describe("isolated Certified Assets qualification environment", () => {
  test("derives the normal minimal profile on the isolated gateway alias", () => {
    const config = createIsolatedQualificationInstanceConfig(
      "/tmp/neutron-ca-qualification-test/state",
    );

    expect(config.state_dir).toBe(
      "/tmp/neutron-ca-qualification-test/state",
    );
    expect(config.initial_time).toEqual({
      Timestamp: {
        nanos_since_epoch: 1_735_689_540_000_000_000,
      },
    });
    expect(
      BigInt(config.initial_time.Timestamp.nanos_since_epoch),
    ).toBe(1_735_689_540_000_000_000n);
    expect(config.http_gateway_config).toEqual({
      ip_addr: "127.0.0.2",
      port: 8000,
      domains: null,
      https_config: null,
      domain_custom_provider_local_file: null,
    });
    expect(config.subnet_config_set.application).toHaveLength(1);
    expect(config.subnet_config_set.ii).not.toBeNull();
    expect(config.subnet_config_set.test_threshold_keys).not.toBeNull();
    expect(config.subnet_config_set.nns).not.toBeNull();
    expect(config.subnet_config_set.sns).toBeNull();
    expect(config.subnet_config_set.fiduciary).toBeNull();
    expect(config.subnet_config_set.bitcoin).toBeNull();
  });

  test("binds the reproducible qualification profile config", () => {
    const first = createIsolatedQualificationInstanceConfig(
      "/tmp/neutron-ca-qualification-test-a/state",
    );
    const same = createIsolatedQualificationInstanceConfig(
      "/tmp/neutron-ca-qualification-test-a/state",
    );
    const other = createIsolatedQualificationInstanceConfig(
      "/tmp/neutron-ca-qualification-test-b/state",
    );
    const changed = {
      ...first,
      mainnet_nns_subnet_id: !first.mainnet_nns_subnet_id,
    };
    const changedTime = {
      ...first,
      initial_time: {
        Timestamp: {
          nanos_since_epoch:
            first.initial_time.Timestamp.nanos_since_epoch +
            1_000_000_000,
        },
      },
    };

    expect(qualificationInstanceConfigSha256(first)).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(qualificationInstanceConfigSha256(first)).toBe(
      qualificationInstanceConfigSha256(same),
    );
    expect(qualificationInstanceConfigSha256(first)).toBe(
      qualificationInstanceConfigSha256(other),
    );
    expect(qualificationInstanceConfigSha256(first)).not.toBe(
      qualificationInstanceConfigSha256(changed),
    );
    expect(qualificationInstanceConfigSha256(first)).not.toBe(
      qualificationInstanceConfigSha256(changedTime),
    );
  });

  test("requires a host wall safely beyond the fixed receipt rollover", () => {
    const minimumExclusive =
      1_735_689_600_000_000_000n +
      86_400_000_000_001n +
      5n * 60n * 1_000_000_000n;

    expect(() =>
      assertQualificationHostWallSafety(minimumExclusive)
    ).toThrow("must be later than");
    expect(() =>
      assertQualificationHostWallSafety(minimumExclusive + 1n)
    ).not.toThrow();
  });

  test("accepts only the fixed certified gateway port", () => {
    const result = parseQualificationInstanceCreation(
      createdResponse(8000),
    );

    expect(result.instanceId).toBe(4);
    expect(result.gatewayId).toBe(9);
    expect(result.gatewayPort).toBe(8000);
    expect(result.topologySummary.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.values(result.topologySummary.subnetIds)).toHaveLength(4);

    expect(() =>
      parseQualificationInstanceCreation(createdResponse(43_217)),
    ).toThrow("must be 8000");
    expect(() =>
      parseQualificationInstanceCreation(createdResponse(0)),
    ).toThrow("must be 8000");
  });

  test("rejects create-response shape drift", () => {
    const changed = createdResponse(8000) as {
      Created: Record<string, unknown>;
    };
    changed.Created.unreviewed = true;
    expect(() => parseQualificationInstanceCreation(changed)).toThrow(
      "unexpected fields",
    );
    expect(() =>
      parseQualificationInstanceCreation({
        Error: { message: "port unavailable" },
      }),
    ).toThrow("could not create the isolated qualification instance");
  });

  test("preserves the exact live management canister version", () => {
    const first = Principal.selfAuthenticating(new Uint8Array(32).fill(1));
    const second = Principal.selfAuthenticating(new Uint8Array(32).fill(2));
    const maximumNat64 = 18_446_744_073_709_551_615n;
    const moduleHash = new Uint8Array([0, 1, 254, 255]);

    expect(
      qualificationManagementStatusFromWire({
        status: { running: null },
        version: maximumNat64,
        settings: { controllers: [second, first] },
        module_hash: [moduleHash],
      }),
    ).toEqual({
      installedTransportWasmSha256: "0001feff",
      controllers: [first.toText(), second.toText()].sort(),
      status: "running",
      canisterVersion: maximumNat64,
    });
    expect(
      qualificationManagementStatusFromWire({
        status: { stopped: null },
        version: 0n,
        settings: { controllers: [first] },
        module_hash: [],
      }),
    ).toMatchObject({
      installedTransportWasmSha256: null,
      status: "stopped",
      canisterVersion: 0n,
    });
  });

  test("binds the exact install_chunked_code Candid transcript", () => {
    const canister = Principal.selfAuthenticating(
      new Uint8Array(32).fill(7),
    );
    const call = encodeQualificationInstallChunkedCodeCall({
      mode: {
        upgrade: [{
          skip_pre_upgrade: [],
          wasm_memory_persistence: [{ replace: null }],
        }],
      },
      target_canister: canister,
      store_canister: [],
      chunk_hashes_list: [{ hash: new Uint8Array([1, 2, 3]) }],
      wasm_module_hash: new Uint8Array(32).fill(9),
      arg: new Uint8Array([68, 73, 68, 76, 0, 0]),
      sender_canister_version: [],
    });

    expect(call.mode).toBe("update");
    expect(call.method).toBe("install_chunked_code");
    expect([...call.request.subarray(0, 4)]).toEqual([68, 73, 68, 76]);
    expect([...call.reply]).toEqual([68, 73, 68, 76, 0, 0]);

    const method = localManagementIdl({ IDL })._fields.find(
      ([name]) => name === "install_chunked_code",
    )![1];
    const decoded = IDL.decode(method.argTypes, call.request);
    expect(IDL.encode(method.argTypes, decoded)).toEqual(call.request);
    expect(
      (decoded[0] as unknown as {
        mode: {
          upgrade: [{
            skip_pre_upgrade: [];
            wasm_memory_persistence: [{ replace: null }];
          }];
        };
      }).mode,
    ).toEqual({
      upgrade: [{
        skip_pre_upgrade: [],
        wasm_memory_persistence: [{ replace: null }],
      }],
    });
    expect(
      (decoded[0] as unknown as { target_canister: Principal })
        .target_canister.toText(),
    ).toBe(canister.toText());
  });
});

function createdResponse(gatewayPort: number): unknown {
  return {
    Created: {
      instance_id: 4,
      topology: minimalTopology(),
      http_gateway_info: {
        instance_id: 9,
        port: gatewayPort,
      },
    },
  };
}

function minimalTopology(): unknown {
  const kinds = ["Application", "NNS", "II", "TestThresholdKeys"] as const;
  return {
    subnet_configs: Object.fromEntries(
      kinds.map((subnet_kind, index) => [
        Principal.selfAuthenticating(
          new Uint8Array(32).fill(index + 1),
        ).toText(),
        {
          subnet_kind,
          subnet_admins: null,
          cost_schedule: "Normal",
          subnet_seed: new Array<number>(32).fill(index + 7),
          instruction_config: "Production",
          canister_ranges: [
            {
              start: {
                canister_id: Buffer.from([index + 1]).toString("base64"),
              },
              end: {
                canister_id: Buffer.from([index + 1, 255]).toString(
                  "base64",
                ),
              },
            },
          ],
        },
      ]),
    ),
    default_effective_canister_id: {
      canister_id: Buffer.from([42, 1, 1]).toString("base64"),
    },
  };
}
