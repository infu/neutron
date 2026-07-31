import {
  assertConnectionProvidersSupported,
  CONNECTION_PROVIDER_SUPPORT_SCHEMA,
  type ConnectionProviderSupportCatalog,
  type NormalizedNeutronConnectionConfig,
} from "neutron-tools/src/capabilities/catalog.js";
import { generatedConnectionProviders } from "./catalog.generated.ts";

export type KernelConnectionProvider = {
  id: string;
  name: string;
  description: string;
  authorizationOrigin: string;
  scopes: Readonly<Record<string, { name: string; description: string }>>;
};

type GeneratedProvider = {
  id: string;
  name: string;
  description: string;
  authorizationOrigin: string;
  scopes: readonly { id: string; name: string; description: string }[];
};

const generatedProviders =
  generatedConnectionProviders as readonly GeneratedProvider[];

export const connectionProviders = Object.freeze(
  Object.fromEntries(
    generatedProviders.map((provider) => [
      provider.id,
      Object.freeze({
        id: provider.id,
        name: provider.name,
        description: provider.description,
        authorizationOrigin: provider.authorizationOrigin,
        scopes: Object.freeze(
          Object.fromEntries(
            provider.scopes.map((scope) => [
              scope.id,
              { name: scope.name, description: scope.description },
            ]),
          ),
        ),
      }),
    ]),
  ),
) as Readonly<Record<string, KernelConnectionProvider>>;

const connectionProviderSupport = Object.freeze({
  schema: CONNECTION_PROVIDER_SUPPORT_SCHEMA,
  providers: Object.freeze(
    generatedProviders.map((provider) =>
      Object.freeze({
        provider: provider.id,
        scopes: Object.freeze(provider.scopes.map((scope) => scope.id)),
      }),
    ),
  ),
}) satisfies ConnectionProviderSupportCatalog;

export function getConnectionProvider(
  providerId: string,
): KernelConnectionProvider | undefined {
  return Object.hasOwn(connectionProviders, providerId)
    ? connectionProviders[providerId]
    : undefined;
}

export function assertSupportedConnections(
  connections: readonly NormalizedNeutronConnectionConfig[],
): void {
  assertConnectionProvidersSupported(connections, connectionProviderSupport);
}
