import type {
  AppRegistry,
  KernelRuntimeInfo,
  PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import type { CompileConfig } from "neutron-compiler/src/compile.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import type { CapabilityInstallDisclosureWireV1 } from "neutron-tools/src/capabilities/wire.js";
import { normalizeManifestDependencies } from "neutron-tools/src/schema.js";
import {
  assertAppVersion,
  formatAppVersionLabel,
} from "neutron-tools/src/version.js";
import type {
  AppPermissionExplanation,
  Permission,
} from "../lib/perm.ts";

export type VerifiedRepositoryPackage = {
  id: string;
  version: number;
  digest: string;
  rawSize: number;
  publisher?: { name: string; website?: string };
  source?: string;
  preparedPackage: PreparedPackageInstall;
  permissions: readonly Permission[];
  capabilityPlanFingerprint: string;
  capabilityDisclosures: readonly CapabilityInstallDisclosureWireV1[];
  appExplanations: readonly AppPermissionExplanation[];
};

export type InstalledAppPresence = {
  installed: boolean;
  version: number | null;
  consistent: boolean;
  issues: readonly string[];
  sources: {
    registry: number | null;
    compiled: number | null;
    runtime: number | null;
  };
};

export type RepositoryReconciliation = Record<string, InstalledAppPresence>;

export type RepositorySelection = {
  roots: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  automatic: ReadonlySet<string>;
  requiredBy: Readonly<Record<string, readonly string[]>>;
  blockers: readonly string[];
};

export function reconcileRepositoryPackages({
  packages,
  registry,
  configs,
  runtime,
}: {
  packages: readonly VerifiedRepositoryPackage[];
  registry: AppRegistry;
  configs: CompileConfig;
  runtime: KernelRuntimeInfo;
}): RepositoryReconciliation {
  const runtimeApps = new Map(
    runtime.apps.map((app) => [
      app.scope.app_id,
      {
        version: normalizeVersion(app.version, app.scope.app_id),
        capabilityPlanFingerprint: app.capability_plan_fingerprint,
      },
    ]),
  );
  const result: RepositoryReconciliation = {};
  const ids = new Set([
    ...packages.map(({ id }) => id),
    ...Object.keys(registry),
    ...Object.keys(configs),
    ...runtimeApps.keys(),
  ]);

  for (const appId of [...ids].sort()) {
    const registryVersion = registry[appId]
      ? normalizeOptionalVersion(registry[appId]?.version, appId)
      : null;
    const compiledVersion = configs[appId]
      ? normalizeVersion(configs[appId]!.version, appId)
      : null;
    const runtimeApp = runtimeApps.get(appId);
    const runtimeVersion = runtimeApp?.version ?? null;
    const present = [registry[appId] !== undefined, configs[appId] !== undefined,
      runtimeApps.has(appId)];
    const installed = present.some(Boolean);
    const issues: string[] = [];
    if (installed && !present.every(Boolean)) {
      issues.push(
        `${appId} is present in only part of the registry, compiler, and runtime state`,
      );
    }
    const knownVersions = [registryVersion, compiledVersion, runtimeVersion].filter(
      (value): value is number => value !== null,
    );
    if (new Set(knownVersions).size > 1) {
      issues.push(`${appId} has conflicting installed versions`);
    }
    if (installed && knownVersions.length === 0) {
      issues.push(`${appId} has no trustworthy installed version`);
    }
    if (
      registry[appId] &&
      runtimeApp &&
      registry[appId]!.capability_plan_fingerprint !==
        runtimeApp.capabilityPlanFingerprint
    ) {
      issues.push(`${appId} has conflicting installed capability plans`);
    }

    result[appId] = Object.freeze({
      installed,
      version: issues.length === 0 ? (knownVersions[0] ?? null) : null,
      consistent: issues.length === 0,
      issues: Object.freeze(issues),
      sources: Object.freeze({
        registry: registryVersion,
        compiled: compiledVersion,
        runtime: runtimeVersion,
      }),
    });
  }
  return Object.freeze(result);
}

export function resolveRepositorySelection({
  packages,
  reconciliation,
  roots,
}: {
  packages: readonly VerifiedRepositoryPackage[];
  reconciliation: RepositoryReconciliation;
  roots: ReadonlySet<string>;
}): RepositorySelection {
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const selected = new Set<string>();
  const validRoots = new Set<string>();
  const requiredBy = new Map<string, Set<string>>();
  const blockers = new Set<string>();
  const visiting = new Set<string>();

  const select = (appId: string, consumer?: string): void => {
    const pkg = byId.get(appId);
    if (!pkg) {
      blockers.add(`${consumer ?? appId} requires missing app ${appId}`);
      return;
    }
    const presence = reconciliation[appId];
    if (presence?.installed) {
      if (!presence.consistent) {
        blockers.add(`${appId} has inconsistent installed state`);
      }
      return;
    }
    if (consumer) {
      const consumers = requiredBy.get(appId) ?? new Set<string>();
      consumers.add(consumer);
      requiredBy.set(appId, consumers);
    }
    if (selected.has(appId)) return;
    if (visiting.has(appId)) {
      blockers.add(`Dependency cycle includes ${appId}`);
      return;
    }
    visiting.add(appId);
    selected.add(appId);
    for (const dependency of Object.values(
      normalizeManifestDependencies(pkg.preparedPackage.manifest),
    )) {
      const installed = reconciliation[dependency.app];
      if (installed?.installed) {
        if (!installed.consistent || installed.version === null) {
          blockers.add(
            `${pkg.preparedPackage.manifest.name} requires ${dependency.app}, whose installed state is inconsistent`,
          );
        } else if (installed.version < dependency.min_version) {
          blockers.add(
            `${pkg.preparedPackage.manifest.name} requires ${dependency.app} ${formatAppVersionLabel(dependency.min_version)} or newer; ${formatAppVersionLabel(installed.version)} is installed`,
          );
        }
        continue;
      }
      const provider = byId.get(dependency.app);
      if (!provider) {
        blockers.add(
          `${pkg.preparedPackage.manifest.name} requires ${dependency.app} ${formatAppVersionLabel(dependency.min_version)} or newer`,
        );
        continue;
      }
      if (provider.version < dependency.min_version) {
        blockers.add(
          `${pkg.preparedPackage.manifest.name} requires ${dependency.app} ${formatAppVersionLabel(dependency.min_version)} or newer; the setup contains ${formatAppVersionLabel(provider.version)}`,
        );
        continue;
      }
      select(provider.id, pkg.id);
    }
    visiting.delete(appId);
  };

  for (const root of [...roots].sort()) {
    const pkg = byId.get(root);
    if (!pkg || reconciliation[root]?.installed) continue;
    validRoots.add(root);
    select(root);
  }

  const automatic = new Set(
    [...selected].filter((appId) => !validRoots.has(appId)),
  );
  return Object.freeze({
    roots: readonlySet(validRoots),
    selected: readonlySet(selected),
    automatic: readonlySet(automatic),
    requiredBy: Object.freeze(
      Object.fromEntries(
        [...requiredBy.entries()]
          .sort(([left], [right]) => compareCanonicalText(left, right))
          .map(([id, consumers]) => [
            id,
            Object.freeze([...consumers].sort(compareCanonicalText)),
          ]),
      ),
    ),
    blockers: Object.freeze([...blockers]),
  });
}

export function availableRepositoryPackageIds(
  packages: readonly VerifiedRepositoryPackage[],
  reconciliation: RepositoryReconciliation,
): string[] {
  return packages
    .filter(({ id }) => !reconciliation[id]?.installed)
    .map(({ id }) => id)
    .sort();
}

function normalizeOptionalVersion(
  value: number | undefined,
  appId: string,
): number | null {
  return value === undefined ? null : normalizeVersion(value, appId);
}

function normalizeVersion(value: bigint | number, appId: string): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  assertAppVersion(normalized, `Installed version for ${appId}`);
  return normalized;
}

function readonlySet<T>(value: Set<T>): ReadonlySet<T> {
  return Object.freeze(new ImmutableSet(value));
}

class ImmutableSet<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = new Set(values);
  }

  get size(): number {
    return this.#values.size;
  }

  get [Symbol.toStringTag](): string {
    return "Set";
  }

  has(value: T): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }

  keys(): SetIterator<T> {
    return this.#values.keys();
  }

  values(): SetIterator<T> {
    return this.#values.values();
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.#values[Symbol.iterator]();
  }

  forEach(
    callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
    thisArg?: unknown,
  ): void {
    for (const entry of this.#values) {
      callbackfn.call(thisArg, entry, entry, this);
    }
  }
}
