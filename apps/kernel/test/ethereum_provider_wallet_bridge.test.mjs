import { afterEach, expect, test } from "bun:test";
import {
  beginEthereumProviderForEndpoint,
  requestEthereumProviderForEndpoint,
  resetEthereumProviderSessionsForTests,
} from "../src/ethereum_provider/service.ts";
import { useAppsStore } from "../src/reducer/apps.ts";
import { registryApp } from "./app_registry_fixture.ts";
import {
  bridgeTransaction,
  executeBridgeDeposit,
} from "../../wallet/src/bridge.ts";

const account = `0x${"11".repeat(20)}`;
const helper = `0x${"22".repeat(20)}`;
const minter = `0x${"33".repeat(20)}`;
const hash = `0x${"ab".repeat(32)}`;
const sessionId = "abcdef0123456789abcdef0123456789";
const owner = { ownerAuthorized: true, ownerPrincipal: "owner-principal" };
const endpoint = {
  endpointId: "app:wallet:tile:wallet:instance:bridge",
  source: {},
  origin: "null",
  sessionId: "bridge-endpoint-session",
  appScope: { appId: "wallet", installationUid: "101" },
  context: {
    role: "tile",
    appId: "wallet",
    tileId: "wallet",
    instanceId: "bridge",
    workspace: 1,
  },
};

afterEach(() => {
  resetEthereumProviderSessionsForTests();
  useAppsStore.setState({ list: {} });
});

for (const interruptReceipt of [false, true]) {
  test(`Wallet ETH deposit uses the real Kernel broker and never resends on continuation (interrupted receipt: ${interruptReceipt})`, async () => {
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
                "eth_getCode",
                "eth_call",
                "eth_sendTransaction",
                "eth_getTransactionReceipt",
              ],
            },
          },
        }),
      },
    });
    const initial = depositIntent();
    const store = bridgeStore(initial);
    let accountRequests = 0;
    let sends = 0;
    let receiptFailed = false;
    const browserWallet = {
      async request({ method, params }) {
        switch (method) {
          case "eth_requestAccounts":
            accountRequests += 1;
            return [account];
          case "eth_chainId":
            return "0x1";
          case "eth_getCode":
            return "0x6001";
          case "eth_call":
            return `0x${minter.slice(2).padStart(64, "0")}`;
          case "eth_sendTransaction":
            sends += 1;
            expect(params).toEqual([bridgeTransaction(initial, "deposit")]);
            expect(store.saved().steps[2]?.state).toBe("unknown");
            return hash;
          case "eth_getTransactionReceipt":
            expect(params).toEqual([hash]);
            if (interruptReceipt && !receiptFailed) {
              receiptFailed = true;
              throw new Error("Temporary receipt lookup failure");
            }
            return { status: "0x1" };
          default:
            throw new Error(`Unexpected provider method ${method}`);
        }
      },
    };
    await beginEthereumProviderForEndpoint({}, endpoint, {
      focused: true,
      userActivated: true,
      provider: { provider: browserWallet, name: "Browser wallet", rdns: null },
      sessionId,
      now: 1_000,
      ...owner,
    });
    const provider = {
      request: ({ method, params }) => requestEthereumProviderForEndpoint(
        { sessionId, method, ...(params === undefined ? {} : { params }) },
        endpoint,
        { focused: true, now: 1_001, ...owner },
      ),
    };

    // The UI connects before preparing the durable intent. Both bridge
    // layers then independently recheck the saved source account.
    await expect(provider.request({ method: "eth_requestAccounts" })).resolves.toEqual([account]);
    const firstExecution = executeBridgeDeposit({ intent: initial, client: store.client, provider });
    if (interruptReceipt) {
      await expect(firstExecution).rejects.toThrow("Temporary receipt lookup failure");
      expect(store.saved().steps[2]).toMatchObject({ state: "submitted", transactionHash: hash });
    } else {
      expect((await firstExecution).steps[2]).toMatchObject({ state: "confirmed", transactionHash: hash });
    }
    expect(accountRequests).toBe(3);
    expect(sends).toBe(1);

    const continued = await executeBridgeDeposit({ intent: store.saved(), client: store.client, provider });
    expect(continued.steps[2]).toMatchObject({ state: "confirmed", transactionHash: hash });
    expect(accountRequests).toBe(4);
    expect(sends).toBe(1);
  });
}

function depositIntent() {
  return {
    id: "01".repeat(16),
    quote: {
      chainId: "1",
      ledger: "ss2fx-dyaaa-aaaar-qacoq-cai",
      minter: "sv3dd-oaaaa-aaaar-qacoa-cai",
      helperAddress: helper,
      helperMode: "subaccount",
      minterAddress: minter,
      tokenAddress: null,
      recipient: "aaaaa-aa",
      principalWord: `0x${"00".repeat(32)}`,
      subaccountWord: `0x${"00".repeat(32)}`,
    },
    source: "external",
    account,
    amount: "12",
    revision: "0",
    createdAt: "1",
    updatedAt: "1",
    eventCursor: "42",
    acceptedDeposit: null,
    mint: null,
    error: null,
    steps: ["reset_approval", "approval", "deposit"].map((kind) => ({
      kind,
      state: "ready",
      operationId: null,
      transactionHash: null,
      error: null,
    })),
  };
}

function bridgeStore(initial) {
  let saved = structuredClone(initial);
  const client = {
    dismissed: async () => [],
    dismiss: async () => structuredClone(saved),
    effectiveHash: async () => null,
    recordReplacement: async () => { throw new Error("No replacement in this browser fixture"); },
    quote: async () => structuredClone(saved.quote),
    prepare: async () => structuredClone(saved),
    list: async () => [structuredClone(saved)],
    status: async () => structuredClone(saved),
    refresh: async () => structuredClone(saved),
    async claim(old, kind, operationId) {
      expect(old.revision).toBe(saved.revision);
      const step = saved.steps.find((item) => item.kind === kind);
      expect(step.state).toBe("ready");
      step.state = "unknown";
      step.operationId = operationId;
      saved.revision = String(BigInt(saved.revision) + 1n);
      return structuredClone(saved);
    },
    async record(old, kind, state, transactionHash, error = null) {
      expect(old.revision).toBe(saved.revision);
      Object.assign(saved.steps.find((item) => item.kind === kind), { state, transactionHash, error });
      saved.revision = String(BigInt(saved.revision) + 1n);
      return structuredClone(saved);
    },
  };
  return { client, saved: () => structuredClone(saved) };
}
