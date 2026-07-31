import {
  assertManifestFunctionExports,
  normalizeManifestDependencies,
  type PackagedNeutronManifest,
} from "neutron-tools/src/schema.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { formatAppVersionLabel } from "neutron-tools/src/version.js";

export type ResolvedAppDependency = {
  alias: string;
  consumer: string;
  provider: string;
  minVersion: number;
  providerVersion: number;
  functions: string[];
};

export type AppDependent = {
  consumer: string;
  alias: string;
  minVersion: number;
  functions: string[];
};

export type AppDependencyPlan = {
  order: string[];
  dependenciesByConsumer: Record<string, ResolvedAppDependency[]>;
  dependentsByProvider: Record<string, AppDependent[]>;
};

export function planAppDependencies(
  target: Record<string, PackagedNeutronManifest>,
): AppDependencyPlan {
  const entries = Object.entries(target).sort(([a], [b]) =>
    compareCanonicalText(a, b),
  );
  for (const [key, manifest] of entries) {
    if (key !== manifest.id) {
      throw new Error(`Config key ${key} does not match app id ${manifest.id}`);
    }
  }
  const manifests = entries
    .map(([, manifest]) => manifest)
    .sort((a, b) => compareCanonicalText(a.id, b.id));
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const dependenciesByConsumer: Record<string, ResolvedAppDependency[]> = {};
  const dependentsByProvider: Record<string, AppDependent[]> = {};
  const providersByConsumer = new Map<string, Set<string>>();

  for (const manifest of manifests) {
    assertManifestFunctionExports(manifest);
    if (manifest.id === "kernel" && manifest.dependencies !== undefined) {
      throw new Error("Kernel cannot declare app dependencies");
    }

    const dependencies = normalizeManifestDependencies(manifest);

    dependenciesByConsumer[manifest.id] = [];
    providersByConsumer.set(manifest.id, new Set());
    for (const [alias, dependency] of Object.entries(dependencies)) {
      const provider = byId.get(dependency.app);
      const providerName = provider?.name ?? displayAppId(dependency.app);
      if (!provider) {
        throw new Error(
          `${manifest.name} requires ${providerName} ${formatAppVersionLabel(dependency.min_version)} or newer; ${providerName} is not installed.`,
        );
      }
      if (provider.version < dependency.min_version) {
        throw new Error(
          `${manifest.name} requires ${provider.name} ${formatAppVersionLabel(dependency.min_version)} or newer; ${formatAppVersionLabel(provider.version)} is installed.`,
        );
      }

      for (const functionName of dependency.functions) {
        const functionConfig = provider.func?.[functionName];
        if (!functionConfig) {
          throw new Error(
            `${provider.name} ${formatAppVersionLabel(provider.version)} violates ${manifest.name}'s dependency: ${functionName} is missing.`,
          );
        }
        if (functionConfig.type !== "internal") {
          throw new Error(
            `${provider.name}.${functionName} required by ${manifest.name} is not internal.`,
          );
        }
        if (functionConfig.expose !== "apps") {
          throw new Error(
            `${provider.name}.${functionName} is internal but is not exposed to apps.`,
          );
        }
      }

      const resolved: ResolvedAppDependency = {
        alias,
        consumer: manifest.id,
        provider: provider.id,
        minVersion: dependency.min_version,
        providerVersion: provider.version,
        functions: [...dependency.functions],
      };
      dependenciesByConsumer[manifest.id]!.push(resolved);
      providersByConsumer.get(manifest.id)!.add(provider.id);
      (dependentsByProvider[provider.id] ??= []).push({
        consumer: manifest.id,
        alias,
        minVersion: dependency.min_version,
        functions: [...dependency.functions],
      });
    }
  }

  for (const dependents of Object.values(dependentsByProvider)) {
    dependents.sort(
      (a, b) =>
        compareCanonicalText(a.consumer, b.consumer) ||
        compareCanonicalText(a.alias, b.alias),
    );
  }

  const cycle = findDependencyCycle(providersByConsumer);
  if (cycle) throw new Error(`Dependency cycle: ${cycle.join(" -> ")}.`);

  return {
    order: topologicalOrder(manifests, providersByConsumer),
    dependenciesByConsumer,
    dependentsByProvider,
  };
}

function topologicalOrder(
  manifests: PackagedNeutronManifest[],
  providersByConsumer: Map<string, Set<string>>,
): string[] {
  const ids = manifests
    .map(({ id }) => id)
    .filter((id) => id !== "kernel")
    .sort(compareCanonicalText);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const consumersByProvider = new Map<string, Set<string>>();

  for (const consumer of ids) {
    for (const provider of providersByConsumer.get(consumer) ?? []) {
      indegree.set(consumer, (indegree.get(consumer) ?? 0) + 1);
      const consumers = consumersByProvider.get(provider) ?? new Set<string>();
      consumers.add(consumer);
      consumersByProvider.set(provider, consumers);
    }
  }

  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const provider = ready.shift()!;
    order.push(provider);
    const consumers = [...(consumersByProvider.get(provider) ?? [])].sort(
      compareCanonicalText,
    );
    for (const consumer of consumers) {
      const next = (indegree.get(consumer) ?? 0) - 1;
      indegree.set(consumer, next);
      if (next === 0) {
        ready.push(consumer);
        ready.sort(compareCanonicalText);
      }
    }
  }

  if (manifests.some(({ id }) => id === "kernel")) order.unshift("kernel");
  return order;
}

function findDependencyCycle(
  providersByConsumer: Map<string, Set<string>>,
): string[] | null {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];

  const visit = (consumer: string): string[] | null => {
    state.set(consumer, "visiting");
    stack.push(consumer);
    const providers = [...(providersByConsumer.get(consumer) ?? [])].sort(
      compareCanonicalText,
    );
    for (const provider of providers) {
      if (state.get(provider) === "visiting") {
        return [...stack.slice(stack.indexOf(provider)), provider];
      }
      if (state.get(provider) !== "visited") {
        const cycle = visit(provider);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(consumer, "visited");
    return null;
  };

  for (const id of [...providersByConsumer.keys()].sort(compareCanonicalText)) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function displayAppId(id: string): string {
  return id
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
