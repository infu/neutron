import { assertNeutronManifest } from "neutron-tools/src/memory.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import type {
  NeutronMemoryConfig,
  NeutronMemoryMigrationConfig,
  PackagedNeutronManifest,
} from "neutron-tools/src/schema.js";

export type MigrationEdge = NeutronMemoryMigrationConfig & {
  entry: string;
};

export type MemoryUpgrade =
  | {
      kind: "initialize";
      owner: string;
      memoryId: string;
      to: number;
    }
  | {
      kind: "keep";
      owner: string;
      memoryId: string;
      version: number;
    }
  | {
      kind: "migrate";
      owner: string;
      memoryId: string;
      from: number;
      to: number;
      oldSchemaEntry: string;
      path: MigrationEdge[];
    }
  | {
      kind: "retire";
      reason: "memory-retirement" | "app-uninstall";
      owner: string;
      memoryId: string;
      from: number;
      oldSchemaEntry: string;
    };

export type MemoryMigrationPlan = {
  upgrades: MemoryUpgrade[];
  removedApps: string[];
  destructiveMemoryRoots: MemoryResource[];
};

export type MemoryResource = {
  owner: string;
  memoryId: string;
};

export function assertMemoryMigrationPlan(
  plan: MemoryMigrationPlan,
): void {
  const plannedRetirements = plan.upgrades
    .filter(
      (upgrade): upgrade is Extract<MemoryUpgrade, { kind: "retire" }> =>
        upgrade.kind === "retire",
    )
    .map(({ owner, memoryId }) => ({ owner, memoryId }))
    .sort(compareMemoryResources);
  const destructiveMemoryRoots = [...plan.destructiveMemoryRoots].sort(
    compareMemoryResources,
  );
  if (
    JSON.stringify(plannedRetirements) !==
    JSON.stringify(destructiveMemoryRoots)
  ) {
    throw new Error(
      "Invalid managed-memory plan: retirements do not match destructive memory roots",
    );
  }
}

type OwnedMemory = {
  owner: string;
  manifest: PackagedNeutronManifest;
  memoryId: string;
  memory: NeutronMemoryConfig;
  version: number;
  active: boolean;
};

export function planMemoryMigrations(
  installed: Record<string, PackagedNeutronManifest>,
  target: Record<string, PackagedNeutronManifest>,
): MemoryMigrationPlan {
  validateManifestSet(installed, "installed");
  validateManifestSet(target, "target");
  if (Object.keys(installed).length > 0 && !target.kernel) {
    throw new Error("The kernel app cannot be uninstalled");
  }

  const oldOwners = collectOwners(installed);
  const targetOwners = collectOwners(target);
  const removedApps = Object.keys(installed)
    .filter((id) => !target[id])
    .sort(compareCanonicalText);

  const upgrades: MemoryUpgrade[] = [];
  const allMemoryRoots = new Map<string, MemoryResource>();
  for (const memory of [...oldOwners.values(), ...targetOwners.values()]) {
    allMemoryRoots.set(memoryResourceKey(memory.owner, memory.memoryId), {
      owner: memory.owner,
      memoryId: memory.memoryId,
    });
  }
  for (const resource of [...allMemoryRoots.values()].sort(
    compareMemoryResources,
  )) {
    const resourceKey = memoryResourceKey(resource.owner, resource.memoryId);
    const old = oldOwners.get(resourceKey);
    const next = targetOwners.get(resourceKey);
    if (!old && next) {
      // A package keeps historical tombstones so the same final release can
      // be installed both on a fresh canister and over an older release.
      if (!next.active) continue;
      upgrades.push({
        kind: "initialize",
        owner: next.owner,
        memoryId: next.memoryId,
        to: next.version,
      });
      continue;
    }
    if (!old) continue;

    if (!next) {
      if (target[old.owner]) {
        throw new Error(
          `App ${old.owner} removed memory ${old.memoryId} without declaring retired: true`,
        );
      }
      if (old.active) {
        upgrades.push(retirement(old, "app-uninstall"));
      }
      continue;
    }

    if (!old.active) {
      if (next.active) {
        throw new Error(
          `Retired memory ${old.memoryId} cannot be restored or reused`,
        );
      }
      continue;
    }
    if (!next.active) {
      upgrades.push(retirement(old, "memory-retirement"));
      continue;
    }
    upgrades.push(planActiveMemory(old, next));
  }

  validateConsumedMemoryRoots(upgrades);

  return {
    upgrades,
    removedApps,
    destructiveMemoryRoots: upgrades
      .filter(
        (upgrade): upgrade is Extract<MemoryUpgrade, { kind: "retire" }> =>
          upgrade.kind === "retire",
      )
      .map(({ owner, memoryId }) => ({ owner, memoryId })),
  };
}

function validateConsumedMemoryRoots(upgrades: MemoryUpgrade[]): void {
  const retirements = new Map(
    upgrades
      .filter(
        (upgrade): upgrade is Extract<MemoryUpgrade, { kind: "retire" }> =>
          upgrade.kind === "retire",
      )
      .map((upgrade) => [
        memoryResourceKey(upgrade.owner, upgrade.memoryId),
        upgrade,
      ]),
  );
  const consumers = new Map<string, string>();

  for (const upgrade of upgrades) {
    if (upgrade.kind !== "migrate") continue;
    for (const edge of upgrade.path) {
      for (const memoryId of edge.consume ?? []) {
        const resourceKey = memoryResourceKey(upgrade.owner, memoryId);
        const retirement = retirements.get(resourceKey);
        if (!retirement || retirement.reason !== "memory-retirement") {
          throw new Error(
            `Memory ${upgrade.memoryId} migration ${edge.from}->${edge.to} can consume only a root retired in the same upgrade; ${memoryId} is not`,
          );
        }
        const existing = consumers.get(resourceKey);
        if (existing) {
          throw new Error(
            `Memory ${memoryId} is consumed by both ${existing} and ${upgrade.memoryId}`,
          );
        }
        consumers.set(resourceKey, upgrade.memoryId);
      }
    }
  }
}

function validateManifestSet(
  manifests: Record<string, PackagedNeutronManifest>,
  label: string,
): void {
  for (const [id, manifest] of Object.entries(manifests)) {
    if (id !== manifest.id) {
      throw new Error(
        `${label} manifest key ${id} does not match app id ${manifest.id}`,
      );
    }
    assertNeutronManifest(manifest, "package");
  }
}

function collectOwners(
  manifests: Record<string, PackagedNeutronManifest>,
): Map<string, OwnedMemory> {
  const owners = new Map<string, OwnedMemory>();
  for (const manifest of Object.values(manifests).sort((a, b) =>
    compareCanonicalText(a.id, b.id),
  )) {
    for (const [memoryId, memory] of Object.entries(manifest.memory ?? {})) {
      const resourceKey = memoryResourceKey(manifest.id, memoryId);
      const version = memory.version ?? 1;
      owners.set(resourceKey, {
        owner: manifest.id,
        manifest,
        memoryId,
        memory,
        version,
        active: memory.retired !== true,
      });
    }
  }
  return owners;
}

function memoryResourceKey(owner: string, memoryId: string): string {
  return `${owner.length}:${owner}${memoryId.length}:${memoryId}`;
}

function compareMemoryResources(
  left: MemoryResource,
  right: MemoryResource,
): number {
  return (
    compareCanonicalText(left.owner, right.owner) ||
    compareCanonicalText(left.memoryId, right.memoryId)
  );
}

function planActiveMemory(old: OwnedMemory, next: OwnedMemory): MemoryUpgrade {
  if (next.version < old.version) {
    throw new Error(
      `Memory ${old.memoryId} cannot downgrade from v${old.version} to v${next.version}`,
    );
  }
  if (next.version === old.version) {
    if (schemaHash(old, old.version) !== schemaHash(next, next.version)) {
      throw new Error(
        `Memory ${old.memoryId} v${old.version} schema hash changed`,
      );
    }
    return {
      kind: "keep",
      owner: next.owner,
      memoryId: next.memoryId,
      version: next.version,
    };
  }

  const oldSchemaEntry = schemaEntry(next, old.version);
  if (schemaHash(old, old.version) !== schemaHash(next, old.version)) {
    throw new Error(
      `Memory ${old.memoryId} package does not preserve installed v${old.version} schema`,
    );
  }
  const path = findUniquePath(
    old.memoryId,
    old.version,
    next.version,
    next.memory,
  );
  return {
    kind: "migrate",
    owner: next.owner,
    memoryId: next.memoryId,
    from: old.version,
    to: next.version,
    oldSchemaEntry,
    path,
  };
}

function findUniquePath(
  memoryId: string,
  from: number,
  to: number,
  memory: NeutronMemoryConfig,
): MigrationEdge[] {
  const byFrom = new Map<number, MigrationEdge[]>();
  for (const edge of memory.migrations ?? []) {
    if (!edge.entry)
      throw new Error(
        `Memory ${memoryId} migration is missing its package entry`,
      );
    const entries = byFrom.get(edge.from) ?? [];
    entries.push(edge as MigrationEdge);
    byFrom.set(edge.from, entries);
  }
  for (const entries of byFrom.values()) entries.sort((a, b) => a.to - b.to);

  const pathCounts = new Map<number, number>([[to, 1]]);
  const versions = [...new Set([from, to, ...byFrom.keys()])].sort(
    (a, b) => b - a,
  );
  for (const version of versions) {
    if (version === to) continue;
    let count = 0;
    for (const edge of byFrom.get(version) ?? []) {
      if (edge.to > to) continue;
      count = Math.min(2, count + (pathCounts.get(edge.to) ?? 0));
    }
    pathCounts.set(version, count);
  }

  const count = pathCounts.get(from) ?? 0;
  if (count === 0) {
    throw new Error(
      `Memory ${memoryId} has no migration path from v${from} to v${to}`,
    );
  }
  if (count > 1) {
    throw new Error(
      `Memory ${memoryId} has ambiguous migration paths from v${from} to v${to}`,
    );
  }
  const path: MigrationEdge[] = [];
  let version = from;
  while (version !== to) {
    const edge = (byFrom.get(version) ?? []).find(
      (candidate) =>
        candidate.to <= to && (pathCounts.get(candidate.to) ?? 0) > 0,
    );
    if (!edge) {
      throw new Error(`Unable to reconstruct migration path for ${memoryId}`);
    }
    path.push(edge);
    version = edge.to;
  }
  return path;
}

function retirement(
  old: OwnedMemory,
  reason: "memory-retirement" | "app-uninstall",
): Extract<MemoryUpgrade, { kind: "retire" }> {
  return {
    kind: "retire",
    reason,
    owner: old.owner,
    memoryId: old.memoryId,
    from: old.version,
    oldSchemaEntry: schemaEntry(old, old.version),
  };
}

function schemaEntry(memory: OwnedMemory, version: number): string {
  const entry = memory.memory.schemas?.[String(version)]?.entry;
  if (!entry) {
    throw new Error(
      `Memory ${memory.memoryId} is missing packaged schema v${version}`,
    );
  }
  return entry;
}

function schemaHash(memory: OwnedMemory, version: number): string {
  const hash = memory.memory.schemas?.[String(version)]?.hash;
  if (!hash) {
    throw new Error(
      `Memory ${memory.memoryId} is missing packaged schema hash v${version}`,
    );
  }
  return hash;
}
