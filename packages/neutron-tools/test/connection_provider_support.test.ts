import { expect, test } from "bun:test";
import {
  assertConnectionProvidersSupported,
  CONNECTION_PROVIDER_SUPPORT_SCHEMA,
  parseConnectionProviderSupportCatalog,
} from "../src/capabilities/catalog.ts";

const support = {
  schema: CONNECTION_PROVIDER_SUPPORT_SCHEMA,
  providers: [
    {
      provider: "openrouter",
      scopes: ["chat:write", "models:read"],
    },
  ],
};

test("connection provider support metadata is closed and canonical", () => {
  const parsed = parseConnectionProviderSupportCatalog(support);
  expect(parsed).toEqual(support);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.providers)).toBe(true);
  expect(Object.isFrozen(parsed.providers[0]!.scopes)).toBe(true);

  expect(() =>
    parseConnectionProviderSupportCatalog({ ...support, product: "Agent" }),
  ).toThrow("Unknown connection provider support catalog field product");
  expect(() =>
    parseConnectionProviderSupportCatalog(Object.create(support)),
  ).toThrow("Unsupported connection provider support catalog");
  expect(() =>
    parseConnectionProviderSupportCatalog({
      ...support,
      schema: "neutron.connection-provider-support.v2",
    }),
  ).toThrow("Unsupported connection provider support catalog");
  expect(() =>
    parseConnectionProviderSupportCatalog({
      ...support,
      providers: [
        {
          provider: "openrouter",
          scopes: ["models:read", "chat:write"],
        },
      ],
    }),
  ).toThrow("scopes are not canonical");
  expect(() =>
    parseConnectionProviderSupportCatalog({
      ...support,
      providers: [
        { provider: "z_provider", scopes: [] },
        { provider: "a_provider", scopes: [] },
      ],
    }),
  ).toThrow("catalog is not canonical");
  expect(() =>
    parseConnectionProviderSupportCatalog({
      ...support,
      providers: [
        { provider: "openrouter", scopes: [] },
        { provider: "openrouter", scopes: [] },
      ],
    }),
  ).toThrow("Duplicate connection provider support openrouter");
});

test("selected Kernel support gates app connection declarations", () => {
  const catalog = parseConnectionProviderSupportCatalog(support);
  expect(() =>
    assertConnectionProvidersSupported(
      [
        {
          provider: "openrouter",
          scopes: ["chat:write"],
        },
      ],
      catalog,
      "app agent",
    ),
  ).not.toThrow();
  expect(() =>
    assertConnectionProvidersSupported(
      [{ provider: "constructor", scopes: [] }],
      catalog,
      "app evil",
    ),
  ).toThrow("Unsupported connection provider 'constructor' for app evil");
  expect(() =>
    assertConnectionProvidersSupported(
      [{ provider: "openrouter", scopes: ["admin"] }],
      catalog,
      "app agent",
    ),
  ).toThrow(
    "Provider 'openrouter' does not support scope 'admin' for app agent",
  );
});
