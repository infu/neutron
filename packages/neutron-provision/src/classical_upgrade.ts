import { Principal } from "@dfinity/principal";
import type { ActorSubclass } from "@dfinity/agent";
import type {
  KernelPackageInstaller,
  KernelInstallCodeChunkedRequest,
  KernelInstallCodeRequest,
} from "neutron-compiler/src/install.js";
import { EMPTY_CANDID_ARGS } from "./ic_client.ts";
import type { ManagementActor } from "./idl.ts";

export type ControllerUpgradePersistence = "classical" | "enhanced";

function controllerUpgradeMode(persistenceMode: ControllerUpgradePersistence): {
  upgrade: [
    {
      skip_pre_upgrade: [];
      wasm_memory_persistence: [
        { keep: null } | { replace: null },
      ];
    },
  ];
} {
  return {
    upgrade: [
      {
        skip_pre_upgrade: [],
        wasm_memory_persistence: [
          persistenceMode === "enhanced"
            ? { keep: null }
            : { replace: null },
        ],
      },
    ],
  };
}

/**
 * Preserve the checked Kernel install transaction while dispatching its one
 * activation call through an already-authorized external controller. The
 * caller must select the already-installed persistence lineage explicitly;
 * the bridge never attempts an enhanced-to-classical downgrade.
 */
export function controllerPersistenceUpgradeActor({
  actor,
  management,
  targetCanisterId,
  persistenceMode,
}: {
  actor: KernelPackageInstaller;
  management: Pick<ActorSubclass<ManagementActor>, "install_code" | "install_chunked_code">;
  targetCanisterId: string;
  persistenceMode: ControllerUpgradePersistence;
}): KernelPackageInstaller {
  const target = Principal.fromText(targetCanisterId);
  return new Proxy(actor, {
    get(source, property, receiver) {
      if (property === "kernel_install_code") {
        return async (request: KernelInstallCodeRequest): Promise<void> => {
          await management.install_code({
            mode: controllerUpgradeMode(persistenceMode),
            canister_id: target,
            wasm_module: request.wasm,
            arg: EMPTY_CANDID_ARGS,
            sender_canister_version: [],
          });
        };
      }
      if (property === "kernel_install_code_chunked") {
        return async (
          request: KernelInstallCodeChunkedRequest,
        ): Promise<void> => {
          await management.install_chunked_code({
            mode: controllerUpgradeMode(persistenceMode),
            target_canister: target,
            store_canister: [],
            chunk_hashes_list: request.chunk_hashes.map((hash) => ({ hash })),
            wasm_module_hash: request.wasm_module_hash,
            arg: EMPTY_CANDID_ARGS,
            sender_canister_version: [],
          });
        };
      }
      const value = Reflect.get(source, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

export function controllerClassicalUpgradeActor(input: {
  actor: KernelPackageInstaller;
  management: Pick<ActorSubclass<ManagementActor>, "install_code" | "install_chunked_code">;
  targetCanisterId: string;
}): KernelPackageInstaller {
  return controllerPersistenceUpgradeActor({
    ...input,
    persistenceMode: "classical",
  });
}
