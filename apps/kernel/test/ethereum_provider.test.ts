import { afterEach, expect, test } from "bun:test";
import {
  ETHEREUM_PROVIDER_MAX_IN_FLIGHT,
  beginEthereumProviderForEndpoint,
  endEthereumProviderForEndpoint,
  requestEthereumProviderForEndpoint,
  resetEthereumProviderSessionsForTests,
  type Eip1193Provider,
  type Eip1193ProviderDescriptor,
} from "../src/ethereum_provider/service.ts";
import type { RegisteredEndpoint } from "../src/frame_context.ts";
import { useAppsStore } from "../src/reducer/apps.ts";
import { registryApp } from "./app_registry_fixture.ts";

const account = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const transactionHash = `0x${"ab".repeat(32)}`;
const sessionId = "0123456789abcdef0123456789abcdef";
const owner = {
  ownerAuthorized: true,
  ownerPrincipal: "owner-principal",
};

const tileEndpoint: RegisteredEndpoint = {
  endpointId: "app:wallet:tile:wallet:instance:one",
  source: {} as Window,
  origin: "null",
  sessionId: "endpoint-session",
  appScope: { appId: "wallet", installationUid: "101" },
  context: {
    role: "tile",
    appId: "wallet",
    tileId: "wallet",
    instanceId: "one",
    workspace: 1,
  },
};

afterEach(() => {
  resetEthereumProviderSessionsForTests();
  useAppsStore.setState({ list: {} });
});

test("ethereum provider session is tile, focus, activation, and manifest bound", async () => {
  installWalletDeclaration();
  const provider = mockProvider();
  const background: RegisteredEndpoint = {
    endpointId: "app:wallet:background",
    source: {} as Window,
    sessionId: "background-session",
    appScope: { appId: "wallet", installationUid: "101" },
    context: { role: "background", appId: "wallet" },
  };

  await expect(
    beginEthereumProviderForEndpoint({}, background, {
      focused: true,
      userActivated: true,
      provider: descriptor(provider),
      sessionId,
      ...owner,
    }),
  ).rejects.toMatchObject({ code: "USER_INTERACTION_REQUIRED" });
  await expect(
    beginEthereumProviderForEndpoint({}, tileEndpoint, {
      focused: true,
      userActivated: false,
      provider: descriptor(provider),
      sessionId,
      ...owner,
    }),
  ).rejects.toMatchObject({ code: "USER_INTERACTION_REQUIRED" });

  useAppsStore.setState({ list: {} });
  await expect(
    beginEthereumProviderForEndpoint({}, tileEndpoint, {
      focused: true,
      userActivated: true,
      provider: descriptor(provider),
      sessionId,
      ...owner,
    }),
  ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
});

test("ethereum provider broker validates accounts, chains, methods, and transactions", async () => {
  installWalletDeclaration();
  const calls: Array<{ method: string; params?: unknown }> = [];
  const provider = mockProvider((request) => {
    calls.push(request);
  });
  await expect(
    beginEthereumProviderForEndpoint({}, tileEndpoint, {
      focused: true,
      userActivated: true,
      provider: descriptor(provider),
      sessionId,
      now: 1_000,
      ...owner,
    }),
  ).resolves.toEqual({
    sessionId,
    provider: { name: "Example wallet", rdns: "org.example.wallet" },
  });

  await expect(
    requestEthereumProviderForEndpoint(
      { sessionId, method: "eth_requestAccounts" },
      tileEndpoint,
      { focused: true, now: 1_001, ...owner },
    ),
  ).resolves.toEqual([account]);
  await expect(
    requestEthereumProviderForEndpoint(
      {
        sessionId,
        method: "eth_sendTransaction",
        params: [
          {
            from: account,
            to: recipient,
            data: "0x",
            value: "0xde0b6b3a7640000",
          },
        ],
      },
      tileEndpoint,
      { focused: true, now: 1_002, ...owner },
    ),
  ).resolves.toBe(transactionHash);
  expect(calls.map(({ method }) => method)).toEqual([
    "eth_requestAccounts",
    "eth_chainId",
    "eth_sendTransaction",
  ]);

  await expect(
    requestEthereumProviderForEndpoint(
      { sessionId, method: "personal_sign", params: ["0x", account] },
      tileEndpoint,
      { focused: true, now: 1_003, ...owner },
    ),
  ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
  await expect(
    requestEthereumProviderForEndpoint(
      {
        sessionId,
        method: "eth_sendTransaction",
        params: [
          {
            from: "0x3333333333333333333333333333333333333333",
            to: recipient,
            data: "0x",
          },
        ],
      },
      tileEndpoint,
      { focused: true, now: 1_004, ...owner },
    ),
  ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });

  expect(
    endEthereumProviderForEndpoint({ sessionId }, tileEndpoint),
  ).toBeNull();
  await expect(
    requestEthereumProviderForEndpoint(
      { sessionId, method: "eth_chainId" },
      tileEndpoint,
      { focused: true, now: 1_005, ...owner },
    ),
  ).rejects.toThrow("expired or was revoked");
});

test("ethereum provider sessions revoke when same-version capabilities change", async () => {
  installWalletDeclaration();
  const provider = mockProvider();
  await beginEthereumProviderForEndpoint({}, tileEndpoint, {
    focused: true,
    userActivated: true,
    provider: descriptor(provider),
    sessionId,
    now: 1_000,
    ...owner,
  });

  useAppsStore.setState({
    list: {
      wallet: registryApp({
        id: "wallet",
        name: "Wallet",
        version: 100,
        capabilities: {
          ethereum_provider: {
            api: 1,
            chains: [1],
            methods: ["eth_chainId"],
          },
        },
      }),
    },
  });

  await expect(
    requestEthereumProviderForEndpoint(
      { sessionId, method: "eth_chainId" },
      tileEndpoint,
      { focused: true, now: 1_001, ...owner },
    ),
  ).rejects.toThrow("expired or was revoked");
});

test("ethereum provider sessions revoke across a same-version reinstall", async () => {
  installWalletDeclaration();
  await beginEthereumProviderForEndpoint({}, tileEndpoint, {
    focused: true,
    userActivated: true,
    provider: descriptor(mockProvider()),
    sessionId,
    now: 1_000,
    ...owner,
  });

  await expect(
    requestEthereumProviderForEndpoint(
      { sessionId, method: "eth_chainId" },
      {
        ...tileEndpoint,
        appScope: { appId: "wallet", installationUid: "102" },
      },
      { focused: true, now: 1_001, ...owner },
    ),
  ).rejects.toThrow("expired or was revoked");
});

test("ethereum provider requests have no elapsed-time quota", async () => {
  installWalletDeclaration();
  await beginEthereumProviderForEndpoint({}, tileEndpoint, {
    focused: true,
    userActivated: true,
    provider: descriptor(mockProvider()),
    sessionId,
    now: 1_000,
    ...owner,
  });

  for (let index = 0; index < 40; index += 1) {
    await expect(
      requestEthereumProviderForEndpoint(
        { sessionId, method: "eth_chainId" },
        tileEndpoint,
        { focused: true, now: 1_001, ...owner },
      ),
    ).resolves.toBe("0x1");
  }
});

test("ethereum provider retains bounded in-flight backpressure", async () => {
  installWalletDeclaration();
  const resolvers: Array<(value: string) => void> = [];
  const provider: Eip1193Provider = {
    async request() {
      return new Promise<string>((resolve) => resolvers.push(resolve));
    },
  };
  await beginEthereumProviderForEndpoint({}, tileEndpoint, {
    focused: true,
    userActivated: true,
    provider: descriptor(provider),
    sessionId,
    now: 1_000,
    ...owner,
  });

  const pending = Array.from(
    { length: ETHEREUM_PROVIDER_MAX_IN_FLIGHT },
    () =>
      requestEthereumProviderForEndpoint(
        { sessionId, method: "eth_chainId" },
        tileEndpoint,
        { focused: true, now: 1_001, ...owner },
      ),
  );
  await expect(
    requestEthereumProviderForEndpoint(
      { sessionId, method: "eth_chainId" },
      tileEndpoint,
      { focused: true, now: 1_001, ...owner },
    ),
  ).rejects.toMatchObject({ code: "UI_BUSY" });

  for (const resolve of resolvers) resolve("0x1");
  await expect(Promise.all(pending)).resolves.toEqual(
    Array(ETHEREUM_PROVIDER_MAX_IN_FLIGHT).fill("0x1"),
  );
});

test("EIP-6963 request and announce automatically bind exactly one provider", async () => {
  installWalletDeclaration();
  const calls: string[] = [];
  const provider = mockProvider(({ method }) => calls.push(method));
  const browser = new FakeEip6963Window([
    descriptor(provider),
  ]);

  await withBrowserWindow(browser, async () => {
    await expect(
      beginEthereumProviderForEndpoint({}, tileEndpoint, {
        focused: true,
        userActivated: true,
        sessionId,
        ...owner,
      }),
    ).resolves.toEqual({
      sessionId,
      provider: { name: "Example wallet", rdns: "org.example.wallet" },
    });

    await expect(
      requestEthereumProviderForEndpoint(
        { sessionId, method: "eth_chainId" },
        tileEndpoint,
        { focused: true, ...owner },
      ),
    ).resolves.toBe("0x1");
  });

  expect(browser.requestProviderCount).toBe(1);
  expect(browser.promptCalls).toEqual([]);
  expect(calls).toEqual(["eth_chainId"]);
});

test("EIP-6963 requires the owner to choose among multiple announced providers", async () => {
  installWalletDeclaration();
  const firstCalls: string[] = [];
  const secondCalls: string[] = [];
  const browser = new FakeEip6963Window(
    [
      {
        provider: mockProvider(({ method }) => firstCalls.push(method)),
        name: "First wallet",
        rdns: "org.example.first",
      },
      {
        provider: mockProvider(({ method }) => secondCalls.push(method)),
        name: "Second wallet",
        rdns: "org.example.second",
      },
    ],
    ["2"],
  );

  await withBrowserWindow(browser, async () => {
    await expect(
      beginEthereumProviderForEndpoint({}, tileEndpoint, {
        focused: true,
        userActivated: true,
        sessionId,
        ...owner,
      }),
    ).resolves.toEqual({
      sessionId,
      provider: { name: "Second wallet", rdns: "org.example.second" },
    });

    await expect(
      requestEthereumProviderForEndpoint(
        { sessionId, method: "eth_chainId" },
        tileEndpoint,
        { focused: true, ...owner },
      ),
    ).resolves.toBe("0x1");
  });

  expect(browser.promptCalls).toHaveLength(1);
  expect(browser.promptCalls[0]?.message).toContain(
    "1. First wallet (org.example.first)",
  );
  expect(browser.promptCalls[0]?.message).toContain(
    "2. Second wallet (org.example.second)",
  );
  expect(browser.promptCalls[0]?.defaultValue).toBe("1");
  expect(firstCalls).toEqual([]);
  expect(secondCalls).toEqual(["eth_chainId"]);
});

test("EIP-6963 provider choice rejects cancellation and invalid selections", async () => {
  installWalletDeclaration();
  const providers: Eip1193ProviderDescriptor[] = [
    {
      provider: mockProvider(),
      name: "First wallet",
      rdns: "org.example.first",
    },
    {
      provider: mockProvider(),
      name: "Second wallet",
      rdns: "org.example.second",
    },
  ];

  for (const response of [null, "3"]) {
    resetEthereumProviderSessionsForTests();
    const browser = new FakeEip6963Window(providers, [response]);
    await withBrowserWindow(browser, async () => {
      await expect(
        beginEthereumProviderForEndpoint({}, tileEndpoint, {
          focused: true,
          userActivated: true,
          sessionId,
          ...owner,
        }),
      ).rejects.toMatchObject({ code: "USER_INTERACTION_REQUIRED" });
    });
  }
});

test("browser-wallet discovery never falls back to window.ethereum", async () => {
  installWalletDeclaration();
  const legacyCalls: string[] = [];
  const legacyProvider = mockProvider(({ method }) => legacyCalls.push(method));
  const browser = new FakeEip6963Window([], [], legacyProvider);

  await withBrowserWindow(browser, async () => {
    await expect(
      beginEthereumProviderForEndpoint({}, tileEndpoint, {
        focused: true,
        userActivated: true,
        sessionId,
        ...owner,
      }),
    ).rejects.toThrow("No EIP-6963 browser wallet is available");
  });

  expect(browser.requestProviderCount).toBe(1);
  expect(browser.promptCalls).toEqual([]);
  expect(legacyCalls).toEqual([]);
});

function installWalletDeclaration(): void {
  useAppsStore.setState({
    list: {
      wallet: registryApp({
        id: "wallet",
        name: "Wallet",
        version: 100,
        capabilities: {
          ethereum_provider: {
            api: 1,
            chains: [1],
            methods: [
              "eth_requestAccounts",
              "eth_chainId",
              "eth_sendTransaction",
            ],
          },
        },
      }),
    },
  });
}

function descriptor(provider: Eip1193Provider) {
  return {
    provider,
    name: "Example wallet",
    rdns: "org.example.wallet",
  };
}

function mockProvider(
  onRequest: (request: { method: string; params?: unknown }) => void = () => {},
): Eip1193Provider {
  return {
    async request(request) {
      onRequest(request);
      switch (request.method) {
        case "eth_requestAccounts":
          return [account];
        case "eth_chainId":
          return "0x1";
        case "eth_sendTransaction":
          return transactionHash;
        default:
          throw new Error(`Unexpected provider method ${request.method}`);
      }
    },
  };
}

class FakeEip6963Window extends EventTarget {
  readonly promptCalls: Array<{
    message: string | undefined;
    defaultValue: string | undefined;
  }> = [];
  requestProviderCount = 0;

  constructor(
    providers: readonly Eip1193ProviderDescriptor[],
    private readonly promptResponses: Array<string | null> = [],
    readonly ethereum?: Eip1193Provider,
  ) {
    super();
    this.addEventListener("eip6963:requestProvider", () => {
      this.requestProviderCount += 1;
      for (const { provider, name, rdns } of providers) {
        this.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: {
              info: { name, rdns },
              provider,
            },
          }),
        );
      }
    });
  }

  prompt(
    message?: string,
    defaultValue?: string,
  ): string | null {
    this.promptCalls.push({ message, defaultValue });
    return this.promptResponses.shift() ?? null;
  }
}

async function withBrowserWindow<T>(
  browser: FakeEip6963Window,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: browser as unknown as Window,
  });
  try {
    return await run();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      delete (globalThis as typeof globalThis & { window?: Window }).window;
    }
  }
}
