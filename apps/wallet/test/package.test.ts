import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import { generateAppMethodSchemaArtifact } from "neutron-scripts/src/method_schema.js";
import { normalizeToolDescriptor } from "neutron-tools/src/app.ts";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import {
  filterCatalog,
  parseCatalogPriceAsset,
  type CatalogLedger,
} from "../src/catalog.ts";
import { formatTokenAmount, parseTokenAmount } from "../src/format.ts";
import {
  WALLET_FUNDING_PRESENT_TOOL,
  WALLET_FUNDING_REJECT_METHOD,
  WALLET_FUNDING_ROOT_TOOL,
  WALLET_FUNDING_TOOL,
  walletFundingInputSchema,
  walletFundingOutputSchema,
} from "../src/funding.ts";
import {
  walletProjectionEmptyInputSchema,
  walletProjectionSchema,
} from "../src/wallet_projection.ts";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);
const catalogUrl = new URL("../backend/Catalog.mo", import.meta.url);
const memoryUrl = new URL("../backend/memory/wallet/v1.mo", import.meta.url);
const commandMemoryUrl = new URL(
  "../backend/memory/wallet_commands/v1.mo",
  import.meta.url,
);
const frontendUrl = new URL("../src/index.tsx", import.meta.url);
const mainFrontendUrl = new URL("../src/main.tsx", import.meta.url);
const mountFrontendUrl = new URL("../src/mount.tsx", import.meta.url);
const serviceUrl = new URL("../src/service.ts", import.meta.url);
const trayFrontendUrl = new URL("../src/tray.tsx", import.meta.url);
const packageUrl = new URL("../wallet.v0.3.7.neutron", import.meta.url);

async function manifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("Wallet declares managed memory and generic backend calls", async () => {
  const value = await manifest();
  expect(validate_neutron_conf(value).errors).toEqual([]);
  expect(value).toMatchObject({
    format: 3,
    id: "wallet",
    version: 307,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    background: {
      path: "service.html",
      description: expect.any(String),
    },
    tray: {
      title: "Wallet",
      path: "tray.html",
      icon: "static/icon.svg",
    },
    backend: {
      capabilities: {
        backend_calls: { api: 1 },
      },
    },
    dependencies: {
      contacts: {
        app: "contacts",
        min_version: 100,
        functions: ["contacts_discover_v1"],
      },
    },
    capabilities: {
      preapproved_self_calls: {
        api: 1,
        methods: [
          "wallet_snapshot",
          "wallet_catalog",
          "wallet_contact_destinations",
          "wallet_refresh_metadata",
          "wallet_refresh_balances",
          "wallet_refresh_deposits",
          "wallet_history_page",
          "wallet_history_status",
          "wallet_history_sources",
          "wallet_history_sync",
          "wallet_transfer",
          "wallet_funding_prepare_v1",
          "wallet_funding_execute_v1",
          "wallet_funding_reject_v1",
          "wallet_allowances_page_v1",
        ],
      },
      backend_calls: {
        api: 1,
        reservation_scopes: ["principal", "exact"],
        max_concurrency: 20,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
      ethereum_provider: {
        api: 1,
        chains: [1],
        methods: [
          "eth_requestAccounts",
          "eth_chainId",
          "wallet_switchEthereumChain",
          "eth_call",
          "eth_getCode",
          "eth_sendTransaction",
          "eth_getTransactionReceipt",
        ],
      },
      scheduled_tasks: {
        api: 1,
        tasks: [
          {
            id: "ledger_history",
            method: "wallet_history_tick",
            interval_seconds: 43_200,
            run_on_start: true,
            max_backend_calls: 100,
          },
        ],
      },
    },
    memory: {
      wallet: { version: 1 },
      wallet_commands: { version: 1 },
    },
  });
  expect(value).not.toHaveProperty("init_arg");
  expect(value.func).toHaveProperty("wallet_catalog");
  expect(value.func).toHaveProperty("wallet_set_ledgers");
  expect(value.func).toHaveProperty("wallet_contact_destinations");
  expect(value.func).toHaveProperty("wallet_transfer");
  expect(value.func).toHaveProperty("wallet_funding_prepare_v1");
  expect(value.func).toHaveProperty("wallet_funding_execute_v1");
  expect(value.func).toHaveProperty("wallet_funding_reject_v1");
  expect(value.func).toHaveProperty("wallet_allowances_page_v1");
  expect(value.func).toHaveProperty("wallet_refresh_deposits");
  expect(value.func?.wallet_history_tick).toEqual({
    type: "internal",
    async: "async*",
    arg: ["task_capabilities"],
  });
  expect(value.func).not.toHaveProperty("wallet_add_ledger");
  expect(value.func).not.toHaveProperty("wallet_remove_ledger");
  expect(value.background).not.toHaveProperty("storage");
  expect(value.capabilities?.backend_calls?.install_reservations).toHaveLength(
    15,
  );
  expect(
    value.capabilities?.backend_calls?.install_reservations?.map(
      ({ kind, principal, method }) =>
        `${kind}:${principal ?? ""}:${method ?? ""}`,
    ),
  ).toEqual([
    "principal:ryjl3-tyaaa-aaaaa-aaaba-cai:",
    "exact:qhbym-qaaaa-aaaaa-aaafq-cai:get_account_transactions",
    "principal:mxzaz-hqaaa-aaaar-qaada-cai:",
    "exact:n5wcd-faaaa-aaaar-qaaea-cai:get_account_transactions",
    "exact:mqygn-kiaaa-aaaar-qaadq-cai:get_btc_address",
    "exact:mqygn-kiaaa-aaaar-qaadq-cai:update_balance",
    "exact:mqygn-kiaaa-aaaar-qaadq-cai:retrieve_btc_with_approval",
    "principal:xevnm-gaaaa-aaaar-qafnq-cai:",
    "exact:xrs4b-hiaaa-aaaar-qafoa-cai:get_account_transactions",
    "exact:sv3dd-oaaaa-aaaar-qacoa-cai:eip_1559_transaction_price",
    "exact:sv3dd-oaaaa-aaaar-qacoa-cai:withdraw_erc20",
    "exact:ss2fx-dyaaa-aaaar-qacoq-cai:icrc1_fee",
    "exact:ss2fx-dyaaa-aaaar-qacoq-cai:icrc2_approve",
    "exact:ss2fx-dyaaa-aaaar-qacoq-cai:icrc1_balance_of",
    "exact:s3zol-vqaaa-aaaar-qacpa-cai:get_account_transactions",
  ]);
});

test("Wallet method schemas preserve structured snapshots", async () => {
  const artifact = generateAppMethodSchemaArtifact(
    await manifest(),
    await readFile(backendUrl, "utf8"),
  );
  expect(artifact.methods.wallet_snapshot?.output).toMatchObject({
    type: "object",
    properties: {
      owner: expect.any(Object),
      configured: { type: "boolean" },
      ledgers: {
        type: "array",
        items: {
          properties: {
            native_deposit_progress: {
              type: "object",
              properties: {
                pending: { type: "array" },
                processing: { type: "array" },
                recent_minted: { type: "array" },
              },
            },
          },
        },
      },
    },
  });
  expect(artifact.methods.wallet_catalog?.output).toMatchObject({
    type: "array",
    items: {
      type: "object",
      properties: {
        principal: expect.any(Object),
        name: { type: "string" },
        symbol: { type: "string" },
        price_asset: expect.any(Object),
      },
    },
  });
  expect(artifact.methods.wallet_refresh_balances?.output).toMatchObject({
    type: "object",
    properties: {
      stale: expect.any(Object),
      snapshot: { type: "object" },
    },
  });
});

test("Wallet setup replaces one v1 ledger selection through one permission batch", async () => {
  const backend = await readFile(backendUrl, "utf8");
  const catalog = await readFile(catalogUrl, "utf8");
  const memory = await readFile(memoryUrl, "utf8");
  const commandMemory = await readFile(commandMemoryUrl, "utf8");
  const frontend = await readFile(frontendUrl, "utf8");

  expect(catalog).toContain("ryjl3-tyaaa-aaaaa-aaaba-cai");
  expect(catalog).toContain("mxzaz-hqaaa-aaaar-qaada-cai");
  expect(catalog).toContain("xevnm-gaaaa-aaaar-qafnq-cai");
  expect(catalog).toContain("public let defaultLedgers : [Text]");
  expect(backend).toContain("Catalog.defaultLedgers.vals()");
  expect(backend).toContain("if (mem.configured)");
  expect(memory).toContain("var configured : Bool");
  expect(memory).toContain("native_address : ?Text");
  expect(memory).toContain("native_deposit_progress : ?NativeDepositProgress");
  expect(memory).toMatch(/^import Map "mo:core\/Map";$/m);
  expect(memory).not.toMatch(/^import\s+\w+\s+"(?:\.{1,2}\/|\/)/m);
  expect(commandMemory).toMatch(/^import Map "mo:core\/Map";$/m);
  expect(commandMemory).not.toMatch(/^import\s+\w+\s+"(?:\.{1,2}\/|\/)/m);
  expect(frontend).toContain("requestBackendCallReservations({");
  expect(frontend).toContain('method: "wallet_set_ledgers"');
  expect(frontend).toContain('updateSelf("wallet_refresh_deposits"');
  expect(frontend).toContain("querySelf(");
  expect(frontend).toContain("updateSelf(method, args)");
  expect(frontend).not.toContain("callCanisterDialog");
  expect(frontend).not.toContain("wallet_add_ledger");
  expect(frontend).not.toContain("wallet_remove_ledger");
  expect(frontend).toContain("onTileViewRequest");
  expect(frontend).toContain('requested === "activity"');
  expect(frontend).toContain('requested === "approvals"');
  expect(frontend).toContain("/^(receive|deposit|send)");
  expect(frontend).toContain("Wallet alpha warning");
  expect(frontend).toContain(
    "Alpha - not battle tested, don't put more tokens than you can",
  );
});

test("Wallet tile and tray mount the same app and gate only focused capabilities", async () => {
  const service = await readFile(serviceUrl, "utf8");
  const frontend = await readFile(frontendUrl, "utf8");
  const main = await readFile(mainFrontendUrl, "utf8");
  const mount = await readFile(mountFrontendUrl, "utf8");
  const tray = await readFile(trayFrontendUrl, "utf8");

  expect(service).toContain("WALLET_PROJECTION_TOOLS.overview");
  expect(service).toContain("WALLET_PROJECTION_TOOLS.refresh");
  expect(service).toContain("WALLET_FUNDING_TOOL");
  expect(service).toContain("WALLET_FUNDING_ROOT_TOOL");
  expect(service).toContain("handleWalletFunding");
  expect(service).toContain('"neutron:audience": "agent_root"');
  expect(service).toContain('"neutron:consent": "provider_once"');
  expect(service).toContain('updateSelf("wallet_refresh_balances"');
  expect(service).toContain("setTrayState({ badge: null })");
  expect(service).toContain("publishAppStateChange(WALLET_PROJECTION_TOPIC");
  expect(service).not.toContain("wallet_transfer");
  expect(service).not.toContain("wallet_set_ledgers");
  expect(frontend).toContain("export function WalletApp");
  expect(frontend).toContain('surface === "tray"');
  expect(frontend).toContain('event.key !== "Escape"');
  expect(frontend).toContain("requestBackendCallReservations({");
  expect(frontend).toContain("copyToClipboard(value)");
  expect(frontend).toContain("connectEthereumProvider()");
  expect(frontend).toContain("Continue deposit in Wallet");
  expect(frontend).toContain("setProjectionRevision");
  expect(frontend).toContain("publishWalletInvalidation");
  expect(frontend).toContain("WALLET_FUNDING_PRESENT_TOOL");
  expect(frontend).toContain('"neutron:audience": "foreground_tile"');
  expect(frontend).toContain('data-tid="wallet-funding-dialog"');
  expect(frontend).toContain('data-tid="wallet-funding-accept"');
  expect(frontend).toContain('data-tid="wallet-funding-reject"');
  expect(frontend).toContain("<code>{review.ledger}</code>");
  expect(frontend).toContain('<code>{review.destination ?? "Unavailable"}</code>');
  expect(frontend).toContain("? approvalSpenderText(review.spender)");
  expect(frontend).toContain("Wallet is already reviewing another funding request");
  expect(frontend).toContain("{review.amountAtoms} atoms");
  expect(frontend).not.toContain("WALLET_FUNDING_PROMPT_LIMIT");
  expect(frontend).not.toContain("for a swap");
  expect(frontend).toContain('className="wallet-custom-ledger-entry"');
  expect(frontend).toContain("onClick={addCustomLedger}");
  expect(frontend).not.toContain("<form");
  expect(frontend).not.toContain("createRoot");
  expect(mount).toContain("createRoot(container).render");
  expect(mount).toContain("<WalletApp surface={surface} />");
  expect(main.trim()).toEndWith('mountWallet("tile");');
  expect(tray.trim()).toEndWith('mountWallet("tray");');
  expect(main).not.toContain("useEffect");
  expect(tray).not.toContain("useEffect");
});

test("Wallet resident tool schemas are closed and hardened", () => {
  expect(() =>
    normalizeToolDescriptor({
      name: "wallet_overview",
      inputSchema: walletProjectionEmptyInputSchema,
      outputSchema: walletProjectionSchema,
    }),
  ).not.toThrow();
  expect(() =>
    normalizeToolDescriptor({
      name: WALLET_FUNDING_TOOL,
      inputSchema: walletFundingInputSchema,
      outputSchema: walletFundingOutputSchema,
      annotations: { "neutron:consent": "provider_once" },
    }),
  ).not.toThrow();
  expect(() =>
    normalizeToolDescriptor({
      name: WALLET_FUNDING_PRESENT_TOOL,
      inputSchema: walletFundingInputSchema,
      outputSchema: walletFundingOutputSchema,
      annotations: {
        "neutron:audience": "foreground_tile",
        "neutron:visibility": "same_app",
      },
    }),
  ).not.toThrow();
  expect(() =>
    normalizeToolDescriptor({
      name: WALLET_FUNDING_ROOT_TOOL,
      inputSchema: walletFundingInputSchema,
      outputSchema: walletFundingOutputSchema,
      annotations: {
        "neutron:audience": "agent_root",
        "neutron:visibility": "same_app",
      },
    }),
  ).not.toThrow();
  expect(WALLET_FUNDING_REJECT_METHOD).toBe("wallet_funding_reject_v1");
});

test("Wallet formats arbitrary Nat balances without Number conversion", () => {
  expect(formatTokenAmount("123456789", 8)).toBe("1.23456789");
  expect(formatTokenAmount("100000000", 8)).toBe("1");
  expect(formatTokenAmount("123456789012345678901234", 0)).toBe(
    "123,456,789,012,345,678,901,234",
  );
});

test("Wallet parses decimal amounts to exact Nat units", () => {
  expect(parseTokenAmount("1.23456789", 8)).toBe("123456789");
  expect(parseTokenAmount(".5", 8)).toBe("50000000");
  expect(() => parseTokenAmount("0", 8)).toThrow("greater than zero");
  expect(() => parseTokenAmount("1.001", 2)).toThrow("2 decimal places");
  expect(() => parseTokenAmount("1e3", 8)).toThrow("valid token amount");
});

test("Wallet catalog search matches names, symbols, and canister ids", () => {
  const catalog: CatalogLedger[] = [
    {
      principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      index: "qhbym-qaaaa-aaaaa-aaafq-cai",
      historyKind: "icp",
      name: "Internet Computer",
      symbol: "ICP",
      priceAsset: "ICP",
      networks: ["internet_computer"],
      nativeRoute: null,
    },
    {
      principal: "mxzaz-hqaaa-aaaar-qaada-cai",
      index: "n5wcd-faaaa-aaaar-qaaea-cai",
      historyKind: "icrc",
      name: "Chain-key Bitcoin",
      symbol: "ckBTC",
      priceAsset: "BTC",
      networks: ["internet_computer", "bitcoin_mainnet"],
      nativeRoute: {
        kind: "ckbtc",
        originNetwork: "bitcoin_mainnet",
        minter: "mqygn-kiaaa-aaaar-qaadq-cai",
        contract: null,
        gasLedger: null,
        nativeActionsAvailable: false,
      },
    },
  ];

  expect(filterCatalog(catalog, " bitcoin ")).toEqual([catalog[1]!]);
  expect(filterCatalog(catalog, "CKBTC")).toEqual([catalog[1]!]);
  expect(filterCatalog(catalog, "ryjl3-tyaaa")).toEqual([catalog[0]!]);
  expect(filterCatalog(catalog, "missing")).toEqual([]);
});

test("Wallet catalog accepts omitted optional price assets", () => {
  expect(parseCatalogPriceAsset(undefined)).toBeNull();
  expect(parseCatalogPriceAsset(null)).toBeNull();
  expect(parseCatalogPriceAsset("BTC")).toBe("BTC");
  expect(() => parseCatalogPriceAsset("ckBTC")).toThrow(
    "Invalid wallet catalog price asset",
  );
});

test("Wallet package contains the tile, schema, and Motoko roots", async () => {
  const unpacked = unpackNeutronPackage(await readFile(packageUrl));
  expect(Object.keys(unpacked)).toEqual(
    expect.arrayContaining([
      "neutron.json",
      "schema.json",
      "web/index.html",
      "web/main.css",
      "web/main.js",
      "web/service.html",
      "web/service.js",
      "web/static/icon.svg",
      "web/tray.html",
      "web/tray.css",
      "web/tray.js",
    ]),
  );
  const prepared = preparePackageInstall(unpacked);
  expect(prepared.manifest.background?.path).toBe("service.html");
  expect(prepared.manifest.tray?.path).toBe("tray.html");
  expect(prepared.manifest.capabilities?.backend_calls).toBeDefined();
  expect(prepared.files.some((file) => file.path.startsWith("mo/"))).toBe(true);
});
