import { describe, expect, test } from "bun:test";
import {
  assertLocalSnapshot,
  assertLoopbackHost,
  parseArgs,
} from "../scripts/compare-installed-bindings";
import {
  fixtureFrameUrl,
  replicaRequestUrl,
} from "../scripts/prove-installed-origins";

describe("installed fixture verifier boundary", () => {
  test("accepts only canonical HTTP loopback origins", () => {
    for (const host of [
      "http://localhost:8000",
      "http://neutron.localhost:8000/",
      "http://127.0.0.1:8000",
      "http://127.42.0.9:8000",
      "http://[::1]:8000",
    ]) {
      expect(assertLoopbackHost(host)).toBe(new URL(host).origin);
    }
    for (const host of [
      "https://localhost:8000",
      "http://0.0.0.0:8000",
      "http://192.168.1.1:8000",
      "http://example.com",
      "http://user:pass@localhost:8000",
      "http://localhost:8000/path",
      "http://localhost:8000/?canisterId=aaaaa-aa",
    ]) {
      expect(() => assertLoopbackHost(host)).toThrow("loopback");
    }
  });

  test("requires the kernel's explicit local vetKeys environment", () => {
    expect(() => assertLocalSnapshot({
      environment: [{ local: null }],
      slots: [],
    })).not.toThrow();
    expect(() => assertLocalSnapshot({
      environment: [],
      slots: [],
    })).toThrow("must be local");
    expect(() => assertLocalSnapshot({
      environment: [{ production: null }],
      slots: [],
    })).toThrow("must be local");
  });

  test("parses a closed, deterministic local command surface", () => {
    const runtime = {
      canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      canisterIds: ["rrkah-fqaaa-aaaaa-aaaaq-cai"],
      nodeLabel: "neutron-1",
      nodeLabels: ["neutron-1"],
      nodeIndex: 0,
      developerIdentityPrincipal: "fixture-developer-principal",
      developerIdentitySeed: 3,
      gatewayUrl: "http://localhost:8000/",
      controlUrl: "http://127.0.0.1:41000/",
      instanceId: 0,
      sessionPath: "/tmp/local.ndeploy.session.json",
    };
    expect(parseArgs([], runtime)).toEqual({
      canisterId: runtime.canisterId,
      host: runtime.gatewayUrl,
      identitySeed: 3,
    });
    expect(() => parseArgs([
      "--host",
      "https://icp0.io",
    ], runtime)).toThrow("Unknown option");
    expect(() => parseArgs([
      "--identity-seed",
      "2",
    ], runtime)).toThrow("Unknown option");
    expect(() => parseArgs([
      "--no-fetch-root-key",
    ], runtime)).toThrow("Unknown option");
  });

  test("pins baked browser API origins to the selected disposable host", () => {
    expect(replicaRequestUrl(
      "http://raw.localhost:8020/api/v2/canister/aaaaa-aa/query?x=1",
      "http://127.0.0.1:18080",
    )).toBe(
      "http://raw.localhost:18080/api/v2/canister/aaaaa-aa/query?x=1",
    );
    expect(replicaRequestUrl(
      "http://avetkeys-fixturea--aaaaa-aa.raw.localhost:8020/app/vetkeys_fixture/index.html",
      "http://127.0.0.1:18080",
    )).toBe(
      "http://avetkeys-fixturea--aaaaa-aa.raw.localhost:18080/app/vetkeys_fixture/index.html",
    );
    expect(() => replicaRequestUrl(
      "http://example.com/api/v2/status",
      "http://127.0.0.1:18080",
    )).toThrow("loopback");
  });

  test("rebinds a baked app frame to the selected gateway origin", () => {
    expect(fixtureFrameUrl(
      "http://avetkeys-fixturea--aaaaa-aa.localhost:8000/app/vetkeys_fixture/index.html?app=vetkeys_fixture",
      "http://raw.localhost:18080",
    )).toBe(
      "http://avetkeys-fixturea--aaaaa-aa.raw.localhost:18080/app/vetkeys_fixture/index.html?app=vetkeys_fixture",
    );
    expect(fixtureFrameUrl(
      "http://avetkeys-fixturea--aaaaa-aa.raw.localhost:8020/app/vetkeys_fixture/index.html",
      "http://127.0.0.1:18080",
    )).toBe(
      "http://127.0.0.1:18080/app/vetkeys_fixture/index.html",
    );
  });
});
