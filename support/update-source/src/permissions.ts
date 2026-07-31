import { Principal } from "@dfinity/principal";
import type { AssetCanisterPort, PermissionName } from "./asset_canister.ts";

export type PublisherStatus = {
  prepare: string[];
  commit: string[];
  manage_permissions: string[];
  controllers: string[];
  controller_publishers: string[];
  single_commit_publisher: boolean;
};

export async function publisherStatus(
  port: AssetCanisterPort,
): Promise<PublisherStatus> {
  const [prepare, commit, managePermissions, controllers] = await Promise.all([
    port.listPermitted("Prepare"),
    port.listPermitted("Commit"),
    port.listPermitted("ManagePermissions"),
    port.controllers(),
  ]);
  const controllerSet = new Set(controllers);
  return {
    prepare: sortedUnique(prepare),
    commit: sortedUnique(commit),
    manage_permissions: sortedUnique(managePermissions),
    controllers: sortedUnique(controllers),
    controller_publishers: sortedUnique(
      commit.filter((principal) => controllerSet.has(principal)),
    ),
    single_commit_publisher: commit.length === 1,
  };
}

export async function configurePublisher(
  port: AssetCanisterPort,
  publisherInput: string,
  options: { replace?: boolean } = {},
): Promise<PublisherStatus> {
  const publisher = normalizePublisher(publisherInput);
  const before = await publisherStatus(port);
  assertNotController(publisher, before.controllers);
  const otherPublishers = before.commit.filter(
    (principal) => principal !== publisher,
  );
  const controllerSet = new Set(before.controllers);
  const existingNonControllerPublishers = otherPublishers.filter(
    (principal) => !controllerSet.has(principal),
  );
  if (existingNonControllerPublishers.length > 0 && !options.replace) {
    throw new Error(
      `Commit is already granted to ${existingNonControllerPublishers.join(", ")}; use --replace to serialize publication under one principal`,
    );
  }

  // Revoke before granting so rotation never creates a concurrent-writer
  // interval. A failed grant safely leaves the source without a publisher.
  for (const current of otherPublishers) {
    await port.revokePermission("Commit", current);
  }
  if (!before.commit.includes(publisher)) {
    await port.grantPermission("Commit", publisher);
  }
  const after = await publisherStatus(port);
  assertConfiguredPublisher(after, publisher);
  return after;
}

export async function rotatePublisher(
  port: AssetCanisterPort,
  oldPublisherInput: string,
  newPublisherInput: string,
): Promise<PublisherStatus> {
  const oldPublisher = normalizePublisher(oldPublisherInput);
  const newPublisher = normalizePublisher(newPublisherInput);
  if (oldPublisher === newPublisher) {
    throw new Error("Old and new publisher principals must differ");
  }
  const before = await publisherStatus(port);
  if (!before.commit.includes(oldPublisher)) {
    throw new Error(`Old publisher '${oldPublisher}' does not have Commit`);
  }
  const unexpected = before.commit.filter(
    (principal) => principal !== oldPublisher && principal !== newPublisher,
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing rotation while other Commit publishers exist: ${unexpected.join(", ")}`,
    );
  }
  assertNotController(newPublisher, before.controllers);

  await port.revokePermission("Commit", oldPublisher);
  if (!before.commit.includes(newPublisher)) {
    await port.grantPermission("Commit", newPublisher);
  }
  const after = await publisherStatus(port);
  assertConfiguredPublisher(after, newPublisher);
  return after;
}

export async function revokePublisher(
  port: AssetCanisterPort,
  publisherInput: string,
): Promise<PublisherStatus> {
  const publisher = normalizePublisher(publisherInput);
  const before = await publisherStatus(port);
  if (before.commit.includes(publisher)) {
    await port.revokePermission("Commit", publisher);
  }
  const after = await publisherStatus(port);
  if (after.commit.includes(publisher)) {
    throw new Error(`Publisher '${publisher}' still has Commit after revocation`);
  }
  return after;
}

export function permissionLabel(permission: PermissionName): string {
  return permission === "ManagePermissions" ? "manage_permissions" : permission.toLowerCase();
}

function assertConfiguredPublisher(
  status: PublisherStatus,
  publisher: string,
): void {
  if (
    status.commit.length !== 1 ||
    status.commit[0] !== publisher ||
    status.controllers.includes(publisher)
  ) {
    throw new Error("Publisher permission verification failed");
  }
}

function assertNotController(publisher: string, controllers: readonly string[]): void {
  if (controllers.includes(publisher)) {
    throw new Error(
      `Publisher '${publisher}' is a controller; remove controller authority before granting Commit`,
    );
  }
}

function normalizePublisher(value: string): string {
  const candidate = value.trim();
  try {
    const normalized = Principal.fromText(candidate).toText();
    if (
      normalized !== candidate ||
      normalized === "2vxsx-fae" ||
      normalized === "aaaaa-aa"
    ) {
      throw new Error("noncanonical or system principal");
    }
    return normalized;
  } catch (cause) {
    throw new Error("Publisher must be a canonical non-anonymous principal", {
      cause,
    });
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
