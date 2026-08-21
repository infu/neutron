import { expect, test } from "bun:test";
import type { KernelPackageInstaller } from "neutron-compiler/src/install.js";
import {
  controllerClassicalUpgradeActor,
  controllerPersistenceUpgradeActor,
} from "../src/classical_upgrade.ts";

const TARGET = "ryjl3-tyaaa-aaaaa-aaaba-cai";

test("controller bridge changes only activation dispatch to classical replace", async () => {
  const calls: { method: string; request: any }[] = [];
  const runtime = { deployment_id: "old" } as any;
  const actor = {
    async kernel_runtime_info() {
      calls.push({ method: "runtime", request: null });
      return runtime;
    },
  } as unknown as KernelPackageInstaller;
  const management = {
    async install_code(request: any) {
      calls.push({ method: "install_code", request });
    },
    async install_chunked_code(request: any) {
      calls.push({ method: "install_chunked_code", request });
    },
  };
  const bridged = controllerClassicalUpgradeActor({
    actor,
    management: management as any,
    targetCanisterId: TARGET,
  });

  expect(await bridged.kernel_runtime_info()).toBe(runtime);
  await bridged.kernel_install_code({
    deployment_id: "next",
    candid: "service : {}",
    wasm: new Uint8Array([1, 2, 3]),
    wasm_memory_persistence: { replace: null },
  });
  await bridged.kernel_install_code_chunked({
    deployment_id: "next",
    chunk_hashes: [new Uint8Array([4])],
    wasm_module_hash: new Uint8Array([5]),
    wasm_memory_persistence: { replace: null },
  });

  expect(calls.map(({ method }) => method)).toEqual([
    "runtime",
    "install_code",
    "install_chunked_code",
  ]);
  for (const { request } of calls.slice(1)) {
    expect(request.mode).toEqual({
      upgrade: [
        {
          skip_pre_upgrade: [],
          wasm_memory_persistence: [{ replace: null }],
        },
      ],
    });
    expect(request.sender_canister_version).toEqual([]);
    expect(request.arg).toEqual(new Uint8Array([68, 73, 68, 76, 0, 0]));
  }
  expect(calls[1]!.request.canister_id.toText()).toBe(TARGET);
  expect(calls[2]!.request.target_canister.toText()).toBe(TARGET);
});

test("controller bridge preserves enhanced Wasm memory when selected", async () => {
  let installRequest: any;
  const bridged = controllerPersistenceUpgradeActor({
    actor: {} as KernelPackageInstaller,
    management: {
      async install_code(request: any) {
        installRequest = request;
      },
      async install_chunked_code() {},
    } as any,
    targetCanisterId: TARGET,
    persistenceMode: "enhanced",
  });

  await bridged.kernel_install_code({
    deployment_id: "next",
    candid: "service : {}",
    wasm: new Uint8Array([1]),
    wasm_memory_persistence: { keep: null },
  });
  expect(installRequest.mode).toEqual({
    upgrade: [
      {
        skip_pre_upgrade: [],
        wasm_memory_persistence: [{ keep: null }],
      },
    ],
  });
});
