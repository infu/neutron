import { createInterface } from "node:readline/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import {
  canonicalAdoptionTarget,
  runAdopt,
  type AdoptOptions,
} from "./adopt.ts";
import { prepareDeployment } from "./artifact.ts";
import {
  loadNdeployConfig,
  resolveLocalPackagePaths,
  resolveNdeployConfigPath,
  type LoadedIcTarget,
  type LoadedNdeployConfig,
} from "./config.ts";
import {
  canonicalNonAnonymousPrincipal,
  formatIcp,
} from "./ic_client.ts";
import { createIcRegistryCertifiedEvidenceProvider } from "./ic_registry_evidence.ts";
import {
  runLocalAuthorize,
  type LocalAuthorizeOptions,
} from "./local_authorize.ts";
import { runLocalReinstall } from "./local_deploy.ts";
import {
  attachLocalConfigToRunningServer,
  readLocalServerStatus,
  startLocalServer,
} from "./local_server.ts";
import { runProvision, type ProvisionOptions } from "./provision.ts";
import { runReinstall, type ReinstallOptions } from "./reinstall.ts";
import { readSession } from "./session.ts";
import { localDeploymentNodes } from "./session.ts";

export type ProvisionCommand =
  | "adopt"
  | "authorize"
  | "create"
  | "reinstall"
  | "serve"
  | "status";

export type ProvisionCli =
  | { help: true }
  | {
      help: false;
      configPath: string;
      command: ProvisionCommand;
      execute: boolean;
      yes: boolean;
      principal?: string;
      canisterId?: string;
    };

export type ProvisionCliDependencies = {
  loadConfig?: typeof loadNdeployConfig;
  prepareDeployment?: typeof prepareDeployment;
  adopt?: typeof runAdopt;
  provision?: typeof runProvision;
  reinstall?: typeof runReinstall;
  localReinstall?: typeof runLocalReinstall;
  localAuthorize?: typeof runLocalAuthorize;
  attachLocalConfig?: typeof attachLocalConfigToRunningServer;
  startLocalServer?: typeof startLocalServer;
  readLocalServerStatus?: typeof readLocalServerStatus;
  createDeploymentEvidenceProvider?: typeof createIcRegistryCertifiedEvidenceProvider;
  waitForServer?: (
    handle: Awaited<ReturnType<typeof startLocalServer>>,
  ) => Promise<void>;
};

export async function main(
  argv = process.argv.slice(2),
  logger: Pick<Console, "log" | "error"> = console,
  dependencies: ProvisionCliDependencies = {},
): Promise<void> {
  const parsed = parseProvisionCli(argv);
  if (parsed.help) {
    logger.log(helpText());
    return;
  }
  const config = await (dependencies.loadConfig ?? loadNdeployConfig)(
    parsed.configPath,
  );

  switch (parsed.command) {
    case "adopt":
      await invokeAdopt(config, parsed, logger, dependencies);
      return;
    case "authorize":
      await invokeAuthorize(config, parsed, logger, dependencies);
      return;
    case "create":
      await invokeCreate(config, parsed, logger, dependencies);
      return;
    case "reinstall":
      await invokeReinstall(config, parsed, logger, dependencies);
      return;
    case "serve":
      await invokeServe(config, parsed, logger, dependencies);
      return;
    case "status":
      await invokeStatus(config, parsed, logger, dependencies);
  }
}

async function invokeAdopt(
  config: LoadedNdeployConfig,
  parsed: Exclude<ProvisionCli, { help: true }>,
  logger: Pick<Console, "log" | "error">,
  dependencies: ProvisionCliDependencies,
): Promise<void> {
  if (config.target.kind !== "ic") {
    throw new Error("adopt requires an IC target config");
  }
  if (parsed.canisterId === undefined) {
    throw new Error("adopt requires a canister ID");
  }
  const options: AdoptOptions = {
    configSha256: config.configSha256,
    host: config.target.host,
    identityId: config.target.identityId,
    targetSubnet: config.target.targetSubnet,
    controllers: config.target.controllers,
    canisterId: parsed.canisterId,
    sessionPath: config.sessionPath,
    execute: parsed.execute,
  };
  await (dependencies.adopt ?? runAdopt)(options, {
    logger,
    deploymentEvidenceProvider: icDeploymentEvidenceProvider(
      config.target,
      dependencies,
    ),
  });
}

async function invokeAuthorize(
  config: LoadedNdeployConfig,
  parsed: Exclude<ProvisionCli, { help: true }>,
  logger: Pick<Console, "log" | "error">,
  dependencies: ProvisionCliDependencies,
): Promise<void> {
  rejectMutationFlags(parsed, "authorize");
  if (config.target.kind !== "pocketic") {
    throw new Error("authorize currently requires a PocketIC target config");
  }
  if (parsed.principal === undefined) {
    throw new Error("authorize requires a principal");
  }
  const options: LocalAuthorizeOptions = {
    configSha256: config.configSha256,
    sessionPath: config.sessionPath,
    developerIdentitySeed: config.target.developerIdentitySeed,
    principal: parsed.principal,
  };
  await (dependencies.localAuthorize ?? runLocalAuthorize)(options, { logger });
}

async function invokeCreate(
  config: LoadedNdeployConfig,
  parsed: Exclude<ProvisionCli, { help: true }>,
  logger: Pick<Console, "log" | "error">,
  dependencies: ProvisionCliDependencies,
): Promise<void> {
  if (config.target.kind !== "ic") {
    throw new Error(
      "PocketIC has no separate create operation; start it with serve, then run reinstall",
    );
  }
  const options: ProvisionOptions = {
    configSha256: config.configSha256,
    host: config.target.host,
    identityId: config.target.identityId,
    targetSubnet: config.target.targetSubnet,
    amountE8s: config.target.amountE8s,
    expectedArtifacts: config.packageArtifacts,
    controllers: config.target.controllers,
    sessionPath: config.sessionPath,
    execute: parsed.execute,
  };
  await (dependencies.provision ?? runProvision)(options, {
    logger,
    deploymentEvidenceProvider: icDeploymentEvidenceProvider(
      config.target,
      dependencies,
    ),
    ...(parsed.execute && !parsed.yes
      ? {
          waitForFunding: waitForFundingKey,
          confirm: confirmProvision,
        }
      : {}),
  });
}

async function invokeReinstall(
  config: LoadedNdeployConfig,
  parsed: Exclude<ProvisionCli, { help: true }>,
  logger: Pick<Console, "log" | "error">,
  dependencies: ProvisionCliDependencies,
): Promise<void> {
  if (config.target.kind === "pocketic") {
    if (parsed.execute || parsed.yes) {
      throw new Error(
        "PocketIC reinstall always executes; --execute and --yes are IC-only",
      );
    }
    const neutronDirectory = path.dirname(config.target.stateDirectory);
    const localPackagePaths = await resolveLocalPackagePaths(config);
    const descriptor = await (
      dependencies.attachLocalConfig ?? attachLocalConfigToRunningServer
    )({
      profile: config.target.profile,
      configSha256: config.configSha256,
      sessionPath: config.sessionPath,
      stateDirectory: config.target.stateDirectory,
    });
    if (descriptor === null) {
      throw new Error(
        "No supervised PocketIC server is running; start it with the serve command first",
      );
    }
    await (dependencies.localReinstall ?? runLocalReinstall)(
      {
        configSha256: config.configSha256,
        sessionPath: config.sessionPath,
        developerIdentitySeed: config.target.developerIdentitySeed,
        nodeLabels: config.target.nodeLabels,
        authorizedPrincipals: config.target.authorizedPrincipals,
        packagePaths: localPackagePaths,
        repositoryRoot: path.dirname(neutronDirectory),
        compileCacheDirectory: path.join(
          neutronDirectory,
          "cache",
          "compiled",
        ),
        profile: config.target.profile,
      },
      {
        logger,
        prepare: pinnedDeploymentPreparer(config, dependencies),
      },
    );
    return;
  }
  const options: ReinstallOptions = {
    configSha256: config.configSha256,
    host: config.target.host,
    identityId: config.target.identityId,
    targetSubnet: config.target.targetSubnet,
    sessionPath: config.sessionPath,
    expectedArtifacts: config.packageArtifacts,
    execute: parsed.execute,
  };
  await (dependencies.reinstall ?? runReinstall)(options, {
    logger,
    deploymentEvidenceProvider: icDeploymentEvidenceProvider(
      config.target,
      dependencies,
    ),
    ...(parsed.execute && !parsed.yes ? { confirm: confirmReinstall } : {}),
  });
}

async function invokeServe(
  config: LoadedNdeployConfig,
  parsed: Exclude<ProvisionCli, { help: true }>,
  logger: Pick<Console, "log" | "error">,
  dependencies: ProvisionCliDependencies,
): Promise<void> {
  rejectMutationFlags(parsed, "serve");
  if (config.target.kind !== "pocketic") {
    throw new Error("serve requires a PocketIC target config");
  }
  const handle = await (
    dependencies.startLocalServer ?? startLocalServer
  )(
    {
      profile: config.target.profile,
      configSha256: config.configSha256,
      sessionPath: config.sessionPath,
      stateDirectory: config.target.stateDirectory,
    },
    { logger },
  );
  await (dependencies.waitForServer ?? waitForLocalServer)(handle);
}

async function invokeStatus(
  config: LoadedNdeployConfig,
  parsed: Exclude<ProvisionCli, { help: true }>,
  logger: Pick<Console, "log" | "error">,
  dependencies: ProvisionCliDependencies,
): Promise<void> {
  rejectMutationFlags(parsed, "status");
  if (config.target.kind === "pocketic") {
    const status = await (
      dependencies.readLocalServerStatus ?? readLocalServerStatus
    )({
      profile: config.target.profile,
      configSha256: config.configSha256,
      sessionPath: config.sessionPath,
    });
    logger.log("PocketIC: healthy");
    logger.log(`Gateway: ${status.descriptor.gateway.url}`);
    logger.log(`Instance: ${status.descriptor.instanceId}`);
    const nodes = localDeploymentNodes(status.session);
    const active =
      status.session.active?.kind === "local-reinstall"
        ? status.session.active.state
        : undefined;
    if (active !== undefined) {
      logger.log(
        "Deployment: partial/in progress (rerun reinstall with the same pinned config to resume)",
      );
    } else if (status.session.current?.kind === "local") {
      logger.log("Deployment: complete");
    } else {
      logger.log("Deployment: not installed");
    }
    if (nodes.length > 0) {
      logger.log(`Neutrons: ${nodes.length}`);
      for (const [index, node] of nodes.entries()) {
        const progress =
          active !== undefined &&
          "nodes" in active &&
          Array.isArray(active.nodes)
            ? active.nodes[index]
            : undefined;
        logger.log(`${node.label}: ${node.canisterId}`);
        if (progress !== undefined) {
          logger.log(`${node.label} phase: ${progress.phase}`);
        }
        logger.log(
          `${node.label} URL: ${localCanisterOrigin(node.canisterId, status.descriptor.gateway.url)}/`,
        );
      }
    }
    return;
  }
  const session = await readSession(config.sessionPath);
  if (session === null) {
    logger.log("IC deployment: no session");
    return;
  }
  if (
    session.configSha256 !== config.configSha256 ||
    session.runtime.kind !== "ic"
  ) {
    throw new Error("Deployment config or runtime does not match provision session");
  }
  logger.log(`IC deployment: ${session.active ? "active" : "idle"}`);
  const currentCanisterId =
    session.current?.kind === "create" ||
    session.current?.kind === "reinstall"
      ? session.current.canisterId
      : undefined;
  logger.log(
    `Canister: ${currentCanisterId ?? session.origin?.canisterId ?? session.adoption?.canisterId ?? "not created"}`,
  );
}

function icDeploymentEvidenceProvider(
  target: LoadedIcTarget,
  dependencies: ProvisionCliDependencies,
) {
  return (
    dependencies.createDeploymentEvidenceProvider ??
    createIcRegistryCertifiedEvidenceProvider
  )({
    host: target.host,
    policy: target.deploymentEvidence,
  });
}

function pinnedDeploymentPreparer(
  config: LoadedNdeployConfig,
  dependencies: ProvisionCliDependencies,
): typeof prepareDeployment {
  const prepare = dependencies.prepareDeployment ?? prepareDeployment;
  return (paths, options = {}) =>
    prepare(paths, {
      ...options,
      ...(config.localPackagePaths === undefined
        ? { expectedArtifacts: config.packageArtifacts }
        : {}),
    });
}

export function parseProvisionCli(argv: string[]): ProvisionCli {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      execute: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
    },
  });
  if (parsed.values.help) return { help: true };
  if (parsed.positionals.length < 2) {
    throw new Error(
      "Expected CONFIG.ndeploy.json followed by adopt, authorize, create, reinstall, serve, or status",
    );
  }
  const [configPath, rawCommand] = parsed.positionals;
  if (!isProvisionCommand(rawCommand)) {
    throw new Error(`Unknown provision command: ${rawCommand}`);
  }
  const expectedPositionals =
    rawCommand === "authorize" || rawCommand === "adopt" ? 3 : 2;
  if (parsed.positionals.length !== expectedPositionals) {
    throw new Error(
      rawCommand === "authorize"
        ? "authorize requires exactly one principal"
        : rawCommand === "adopt"
          ? "adopt requires exactly one canister ID"
        : `${rawCommand} does not accept positional arguments`,
    );
  }
  const principal =
    rawCommand === "authorize"
      ? canonicalNonAnonymousPrincipal(
          parsed.positionals[2]!,
          "Authorization principal",
        )
      : undefined;
  const canisterId =
    rawCommand === "adopt"
      ? canonicalAdoptionTarget(parsed.positionals[2]!)
      : undefined;
  const execute = Boolean(parsed.values.execute);
  const yes = Boolean(parsed.values.yes);
  if (rawCommand === "adopt" && yes) {
    throw new Error("adopt does not accept --yes");
  }
  if (yes && !execute) {
    throw new Error("--yes is only valid together with --execute");
  }
  return {
    help: false,
    configPath: resolveNdeployConfigPath(configPath!),
    command: rawCommand,
    execute,
    yes,
    ...(principal === undefined ? {} : { principal }),
    ...(canisterId === undefined ? {} : { canisterId }),
  };
}

async function waitForLocalServer(
  handle: Awaited<ReturnType<typeof startLocalServer>>,
): Promise<void> {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void handle.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await handle.wait();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (stopping) await handle.stop();
  }
}

function rejectMutationFlags(
  parsed: Exclude<ProvisionCli, { help: true }>,
  command: string,
): void {
  if (parsed.execute || parsed.yes) {
    throw new Error(`${command} does not accept --execute or --yes`);
  }
}

function isProvisionCommand(value: string | undefined): value is ProvisionCommand {
  return (
    value === "adopt" ||
    value === "authorize" ||
    value === "create" ||
    value === "reinstall" ||
    value === "serve" ||
    value === "status"
  );
}

async function waitForFundingKey({
  principal,
  accountIdentifier,
  amountE8s,
  ledgerFeeE8s,
  requiredE8s,
  ledgerBalanceE8s,
  shortfallE8s,
}: {
  principal: string;
  accountIdentifier: string;
  amountE8s: bigint;
  ledgerFeeE8s: bigint;
  requiredE8s: bigint;
  ledgerBalanceE8s: bigint;
  shortfallE8s: bigint;
}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Funding requires ${formatIcp(shortfallE8s)} more ICP. Send ICP to ${accountIdentifier} (principal ${principal}), then rerun in a terminal or use --yes after funding.`,
    );
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(
      `\nFund the icblast identity's ICP account:\n${accountIdentifier}\nPrincipal: ${principal}\nCMC payment: ${formatIcp(amountE8s)} ICP\nCurrent ledger fee: ${formatIcp(ledgerFeeE8s)} ICP\nRequired total: ${formatIcp(requiredE8s)} ICP\nAvailable: ${formatIcp(ledgerBalanceE8s)} ICP\nMissing: ${formatIcp(shortfallE8s)} ICP\n\nPress Enter to check again, or type q to cancel: `,
    );
    if (answer.trim().toLowerCase() === "q") {
      throw new Error("Provisioning cancelled while waiting for ICP funding");
    }
  } finally {
    readline.close();
  }
}

async function confirmReinstall({
  canisterId,
  principal,
}: {
  canisterId: string;
  principal: string;
}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Interactive reinstall confirmation requires a TTY; pass --yes for automation",
    );
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const expected = `reinstall ${canisterId}`;
    const answer = await readline.question(
      `DANGER: this permanently erases all installed-app state, keys, permissions, authorizations, certified assets, canister snapshots, and restore points in ${canisterId}.\nThe canister ID, controllers, settings, subnet, and remaining cycles stay in place. No ICP is paid and no canister is created.\nSigner: ${principal}\n\nType ${expected} to continue:\n> `,
    );
    if (answer.trim() !== expected) {
      throw new Error("Reinstall confirmation did not match the target canister");
    }
  } finally {
    readline.close();
  }
}

async function confirmProvision({
  principal,
  subnet,
  amountE8s,
  feeE8s,
}: {
  principal: string;
  subnet: string;
  amountE8s: bigint;
  feeE8s: bigint;
}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive confirmation requires a TTY; pass --yes for automation");
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(
      `Create a mainnet Neutron on subnet ${subnet}?\nSigner: ${principal}\nCMC transfer: ${formatIcp(amountE8s)} ICP\nLedger fee: ${formatIcp(feeE8s)} ICP\n\nType create to continue:\n> `,
    );
    if (answer.trim() !== "create") {
      throw new Error("Provisioning confirmation was not accepted");
    }
  } finally {
    readline.close();
  }
}

function helpText(): string {
  return `Usage:
  neutron-provision CONFIG.ndeploy.json adopt CANISTER_ID [--execute]
  neutron-provision CONFIG.ndeploy.json authorize PRINCIPAL
  neutron-provision CONFIG.ndeploy.json create [--execute] [--yes]
  neutron-provision CONFIG.ndeploy.json reinstall [--execute] [--yes]
  neutron-provision CONFIG.ndeploy.json serve
  neutron-provision CONFIG.ndeploy.json status

Commands:
  adopt      Live-verify an existing IC Neutron and write an adoption receipt.
  authorize  Grant a principal access to every deployed local fleet node.
  create     Plan or execute a new paid IC deployment.
  reinstall  Fully reinstall an IC deployment, or immediately reinstall PocketIC.
  serve      Run and supervise the config's long-lived PocketIC server and gateway.
  status     Verify and print the config's deployment session and local fleet.
`;
}
