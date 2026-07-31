import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  CONNECTION_PROVIDER_SUPPORT_SCHEMA,
  CONNECTIONS_MAX_PROVIDERS_GLOBAL,
  CONNECTIONS_MAX_PROVIDERS_PER_APP,
  parseConnectionProviderSupportCatalog,
} from "neutron-tools/src/capabilities/catalog.js";
import type { RegisteredEndpoint } from "../src/frame_context.ts";
import {
  getRegisteredEndpoint,
  registerFrameContext,
} from "../src/frame_context.ts";
import { assertSupportedConnections } from "../src/connections/catalog.ts";
import { generatedConnectionProviders } from "../src/connections/catalog.generated.ts";
import {
  acquireConnectionForEndpoint,
  disconnectConnectionForEndpoint,
  listConnectionsForEndpoint,
  requestConnectionForEndpoint,
} from "../src/connections/service.ts";
import { useAppsStore } from "../src/reducer/apps.ts";
import {
  approveConnectionConsent,
  CONNECTION_PENDING_FLOW_KEY,
  clearConnectionRequestsForAuth,
  removeConnectionRequestsForApp,
  requestConnectionConsent,
  normalizeConnectionSummary,
  useConnectionsStore,
} from "../src/reducer/connections.ts";
import { resetUiAttentionState } from "../src/ui_attention/owner.ts";
import { registryApp } from "./app_registry_fixture.ts";

const source = {} as Window;

function endpoint(role: "tile" | "background"): RegisteredEndpoint {
  const context =
    role === "background"
      ? ({ role, appId: "agent" } as const)
      : ({
          role,
          appId: "agent",
          tileId: "chat",
          instanceId: "one",
          workspace: 1,
        } as const);
  const channel = new MessageChannel();
  return {
    endpointId:
      role === "background"
        ? "app:agent:background"
        : "app:agent:tile:chat:instance:one",
    source,
    context,
    origin: "null",
    port: channel.port1,
    sessionId: "connection-test-session",
  };
}

function trayEndpoint(): RegisteredEndpoint {
  const channel = new MessageChannel();
  return {
    endpointId: "app:agent:tray:instance:panel-one",
    source,
    context: {
      role: "tray",
      appId: "agent",
      instanceId: "panel-one",
    },
    origin: "null",
    port: channel.port1,
    sessionId: "connection-tray-test-session",
  };
}

afterEach(() => {
  clearConnectionRequestsForAuth();
  resetUiAttentionState();
  useAppsStore.setState({ list: {} });
});

const consent = {
  kind: "connect" as const,
  appId: "agent",
  appName: "Agent",
  provider: "openrouter",
  providerName: "OpenRouter",
  scopes: [],
  flowId: "flow-1234567890123456",
  authorizationUrl: "https://openrouter.ai/auth",
};

test("connection consent is cancelled with its app lifecycle", async () => {
  const pending = requestConnectionConsent(consent, () => true);
  expect(useConnectionsStore.getState().dialog?.appId).toBe(
    "agent",
  );

  removeConnectionRequestsForApp("agent");

  await expect(pending).rejects.toThrow("was cancelled");
  expect(useConnectionsStore.getState().dialog).toBeNull();
});

test("connection consent closes when its exact endpoint disappears", async () => {
  const endpointId = "app:agent:background";
  const unregister = registerFrameContext(
    {} as Window,
    { role: "background", appId: "agent" },
    { appVersion: 100, origin: "null" },
  );
  const pending = requestConnectionConsent(
    consent,
    () => Boolean(getRegisteredEndpoint(endpointId)),
  );

  unregister();

  await expect(pending).rejects.toThrow("no longer active");
  expect(useConnectionsStore.getState().dialog).toBeNull();
});

test("stale connection consent cannot open an authorization popup", async () => {
  const pending = requestConnectionConsent(consent, () => false);
  approveConnectionConsent();

  await expect(pending).rejects.toThrow("no longer active");
  expect(useConnectionsStore.getState().dialog).toBeNull();
});

test("identity restoration preserves popup recovery but logout clears it", () => {
  const originalWindow = globalThis.window;
  const values = new Map<string, string>([
    [CONNECTION_PENDING_FLOW_KEY, consent.flowId],
  ]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
      },
    },
  });

  try {
    clearConnectionRequestsForAuth({ preserveStoredRecovery: true });
    expect(values.get(CONNECTION_PENDING_FLOW_KEY)).toBe(consent.flowId);

    clearConnectionRequestsForAuth();
    expect(values.has(CONNECTION_PENDING_FLOW_KEY)).toBe(false);
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  }
});

test("kernel provider catalog accepts only trusted provider declarations", () => {
  expect(() =>
    assertSupportedConnections([
      {
        provider: "openrouter",
        scopes: [],
      },
    ])
  ).not.toThrow();
  expect(() =>
    assertSupportedConnections([
      {
        provider: "evil",
        scopes: [],
      },
    ])
  ).toThrow("Unsupported connection provider 'evil'");
  expect(() =>
    assertSupportedConnections([
      {
        provider: "constructor",
        scopes: [],
      },
    ]),
  ).toThrow("Unsupported connection provider 'constructor'");
  expect(() =>
    assertSupportedConnections([
      {
        provider: "openrouter",
        scopes: ["constructor"],
      },
    ]),
  ).toThrow("does not support scope 'constructor'");
});

test("connection summaries retain their installation identity", () => {
  expect(
    normalizeConnectionSummary({
      app_id: "agent",
      installation_uid: 17n,
      provider: "openrouter",
      created_at: 1n,
    }),
  ).toMatchObject({
    appId: "agent",
    installationUid: "17",
  });
  expect(() =>
    normalizeConnectionSummary({
      app_id: "agent",
      installation_uid: 0n,
      provider: "openrouter",
      created_at: 1n,
    }),
  ).toThrow("Invalid installation uid");
  expect(() =>
    normalizeConnectionSummary({
      connection_id: "legacy-id",
      app_id: "agent",
      installation_uid: 17n,
      provider: "openrouter",
      created_at: 1n,
    }),
  ).toThrow("Invalid connection summary");
});

test("generated provider catalogs exactly match the trusted provider source", async () => {
  const source = JSON.parse(
    await readFile(
      new URL("../connections/providers.json", import.meta.url),
      "utf8",
    ),
  ) as {
    providers: Array<{
      id: string;
      name: string;
      description: string;
      authorizationOrigin: string;
      scopes: Array<{ id: string; name: string; description: string }>;
    }>;
  };
  expect(JSON.stringify(generatedConnectionProviders)).toBe(
    JSON.stringify(source.providers),
  );

  const motoko = await readFile(
    new URL("../backend/connections/CatalogData.mo", import.meta.url),
    "utf8",
  );
  for (const provider of source.providers) {
    expect(motoko).toContain(`id = "${provider.id}"`);
    expect(motoko).toContain(
      `authorization_origin = "${provider.authorizationOrigin}"`,
    );
  }
  expect(motoko).not.toContain("supported_access");
  expect(motoko).not.toContain("test_only");
  expect(motoko).toContain(
    `public let max_connections_per_app : Nat = ${CONNECTIONS_MAX_PROVIDERS_PER_APP};`,
  );
  expect(motoko).toContain(
    `public let max_connections : Nat = ${CONNECTIONS_MAX_PROVIDERS_GLOBAL};`,
  );

  const registry = await readFile(
    new URL(
      "../backend/connections/providers/Registry.mo",
      import.meta.url,
    ),
    "utf8",
  );
  expect(
    [...registry.matchAll(/provider == "([^"]+)"/gu)]
      .map((match) => match[1])
      .sort(),
  ).toEqual(source.providers.map((provider) => provider.id).sort());
  expect(
    [...registry.matchAll(/entry\("([^"]+)"/gu)]
      .map((match) => match[1])
      .sort(),
  ).toEqual(source.providers.map((provider) => provider.id).sort());

  const support = JSON.parse(
    await readFile(
      new URL(
        "../connections/provider-support.generated.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(parseConnectionProviderSupportCatalog(support)).toEqual({
    schema: CONNECTION_PROVIDER_SUPPORT_SCHEMA,
    providers: source.providers.map((provider) => ({
      provider: provider.id,
      scopes: provider.scopes.map((scope) => scope.id),
    })),
  });
  expect(JSON.stringify(support)).not.toContain("authorizationOrigin");
  expect(JSON.stringify(support)).not.toContain("description");
});

test("tiles cannot invoke private connection actions", async () => {
  await expect(
    listConnectionsForEndpoint({}, endpoint("tile"))
  ).rejects.toThrow("only to an app background process");
  await expect(
    acquireConnectionForEndpoint(
      { provider: "openrouter" },
      endpoint("tile"),
    ),
  ).rejects.toThrow("only to an app background process");
  await expect(
    disconnectConnectionForEndpoint(
      { provider: "openrouter" },
      endpoint("tile"),
    ),
  ).rejects.toThrow("only to an app background process");
});

test("tray popouts cannot invoke private connection actions", async () => {
  await expect(
    listConnectionsForEndpoint({}, trayEndpoint()),
  ).rejects.toThrow("only to an app background process");
});

test("background requests reject legacy fields and undeclared providers", async () => {
  useAppsStore.setState({
    list: {
      agent: registryApp({
        id: "agent",
        name: "Agent",
        background: { path: "service.html" },
        capabilities: {
          connections: {
            api: 1,
            providers: [
              {
                provider: "openrouter",
                scopes: [],
              },
            ],
          },
        },
      }),
    },
  });

  await expect(
    requestConnectionForEndpoint(
      {
        provider: "openrouter",
        access: "backend_proxy",
      },
      endpoint("background")
    )
  ).rejects.toThrow("Invalid connection request");
  await expect(
    requestConnectionForEndpoint(
      {
        provider: "not_declared",
      },
      endpoint("background")
    )
  ).rejects.toThrow("not declared by this app");
  await expect(
    listConnectionsForEndpoint(
      { provider: "openrouter", status: "active" },
      endpoint("background"),
    ),
  ).rejects.toThrow("Invalid connection request");
  await expect(
    acquireConnectionForEndpoint(
      { provider: "openrouter", connectionId: "legacy-id" },
      endpoint("background"),
    ),
  ).rejects.toThrow("Invalid connection request");
  await expect(
    disconnectConnectionForEndpoint(
      { provider: "openrouter", connectionId: "legacy-id" },
      endpoint("background"),
    ),
  ).rejects.toThrow("Invalid connection request");
});
