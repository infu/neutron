import type { Identity } from "@dfinity/agent";
import { canonicalNonAnonymousPrincipal } from "./ic_client.ts";
import { localIdentityFromSeed } from "./kernel.ts";
import { LocalProvisionClient } from "./local_client.ts";
import {
  localDeploymentNodes,
  localDeploymentPrimaryCanisterId,
  readSession,
  withSessionLock,
  type PocketIcRuntime,
} from "./session.ts";
import {
  verifyPocketIcRuntime,
  type PocketIcRuntimeDescriptor,
} from "./pocketic_supervisor.ts";

export type LocalAuthorizeOptions = {
  configSha256: string;
  sessionPath: string;
  developerIdentitySeed: number;
  principal: string;
};

export type LocalAuthorizeResult = {
  canisterId: string;
  principal: string;
  authorizedPrincipals: string[];
  nodes: Array<{
    label: string;
    canisterId: string;
    authorizedPrincipals: string[];
  }>;
};

export type LocalAuthorizeClient = {
  operationalState(canisterId: string): Promise<{
    moduleHash: string | null;
    controllers: string[];
    status: "running" | "stopping" | "stopped";
  }>;
  authorizePrincipal(
    canisterId: string,
    principal: string,
  ): Promise<string[]>;
};

export type LocalAuthorizeDependencies = {
  verifyRuntime?: (
    descriptor: PocketIcRuntimeDescriptor,
  ) => Promise<unknown>;
  identityFromSeed?: (seed: number) => Identity;
  createClient?: (input: {
    gatewayUrl: string;
    identity: Identity;
    defaultEffectiveCanisterIdBase64: string;
    expectedRootKeyBase64: string;
    logger: Pick<Console, "log">;
  }) => Promise<LocalAuthorizeClient>;
  logger?: Pick<Console, "log">;
};

/** Grant an additional principal access through the config's local controller. */
export async function runLocalAuthorize(
  options: LocalAuthorizeOptions,
  dependencies: LocalAuthorizeDependencies = {},
): Promise<LocalAuthorizeResult> {
  const principal = canonicalNonAnonymousPrincipal(
    options.principal,
    "Authorization principal",
  );
  const logger = dependencies.logger ?? console;

  return withSessionLock(options.sessionPath, async () => {
    const journal = await readSession(options.sessionPath);
    if (journal === null) {
      throw new Error(
        "Local authorization requires an existing provision session; run reinstall first",
      );
    }
    if (
      journal.configSha256 !== options.configSha256 ||
      journal.runtime.kind !== "pocketic"
    ) {
      throw new Error(
        "Local provision session does not match the selected deployment config",
      );
    }
    if (journal.active !== undefined) {
      throw new Error(
        "Cannot authorize a principal while a local reinstall is active",
      );
    }
    const current = journal.current;
    if (current?.kind !== "local") {
      throw new Error(
        "Local authorization requires a completed PocketIC deployment",
      );
    }

    const { kind: _kind, ...descriptor } = journal.runtime as PocketIcRuntime;
    await (dependencies.verifyRuntime ?? verifyPocketIcRuntime)(descriptor);
    const identity = (
      dependencies.identityFromSeed ?? localIdentityFromSeed
    )(options.developerIdentitySeed);
    const client = await (
      dependencies.createClient ??
      ((input) => LocalProvisionClient.create(input))
    )({
      gatewayUrl: descriptor.gateway.url,
      identity,
      defaultEffectiveCanisterIdBase64:
        descriptor.topology.defaultEffectiveCanisterId,
      expectedRootKeyBase64: descriptor.rootKeyBase64,
      logger,
    });

    const nodes = localDeploymentNodes(journal);
    const developerPrincipal = identity.getPrincipal().toText();
    for (const node of nodes) {
      const operational = await client.operationalState(node.canisterId);
      if (operational.status !== "running") {
        throw new Error(
          `Local Neutron ${node.label} (${node.canisterId}) is ${operational.status}, not running`,
        );
      }
      if (operational.moduleHash !== current.transportWasmSha256) {
        throw new Error(
          `PocketIC module drift on ${node.label} (${node.canisterId}): expected ${current.transportWasmSha256}, found ${operational.moduleHash ?? "no installed module"}`,
        );
      }
      const expectedControllers = [developerPrincipal, node.canisterId].sort();
      const actualControllers = [...operational.controllers].sort();
      if (
        actualControllers.length !== expectedControllers.length ||
        actualControllers.some(
          (controller, index) => controller !== expectedControllers[index],
        )
      ) {
        throw new Error(
          `PocketIC controller drift on ${node.label} (${node.canisterId}): expected ${expectedControllers.join(", ")}, found ${actualControllers.join(", ") || "none"}`,
        );
      }
    }
    const results: LocalAuthorizeResult["nodes"] = [];
    for (const [index, node] of nodes.entries()) {
      try {
        const authorizedPrincipals = await client.authorizePrincipal(
          node.canisterId,
          principal,
        );
        if (!authorizedPrincipals.includes(principal)) {
          throw new Error(
            `authorization verification did not find ${principal}`,
          );
        }
        results.push({ ...node, authorizedPrincipals });
        logger.log(`Authorized ${principal} on ${node.label} (${node.canisterId})`);
      } catch (error) {
        throw new Error(
          `Authorization stopped at ${node.label} (${index + 1}/${nodes.length}). ${results.length} earlier node${results.length === 1 ? "" : "s"} may already include ${principal}; rerun the same command to finish safely.`,
          { cause: error },
        );
      }
    }
    return {
      canisterId: localDeploymentPrimaryCanisterId(journal),
      principal,
      authorizedPrincipals: results[0]?.authorizedPrincipals ?? [],
      nodes: results,
    };
  });
}
