import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import {
  BTC_CHECKER_CANISTER_ID,
  BTC_CHECKER_WASM_ARTIFACT,
  CKBTC_MINTER_CANISTER_ID,
  CKBTC_MINTER_WASM_ARTIFACT,
  CKETH_MINTER_CANISTER_ID,
  CKETH_MINTER_WASM_ARTIFACT,
  EVM_RPC_CANISTER_ID,
  EVM_RPC_WASM_ARTIFACT,
  encodeBtcCheckerInitArgs,
  encodeCkBtcMinterInitArgs,
  encodeCkEthMinterInitArgs,
  encodeCkEthMinterUpgradeArgs,
  encodeEvmRpcInitArgs,
  ensureLocalNativeChainFixtures,
  formatSatoshis,
  localNativeChainFixtureIds,
  principalWord,
  resolveNativeChainArtifacts,
  type LocalNativeFixtureClient,
  type NativeLedgerFixture,
  type PreparedNativeChainArtifacts,
} from "../src/local_chain_fixtures.ts";

const CKBTC: NativeLedgerFixture = {
  key: "ckbtc",
  canisterId: "mxzaz-hqaaa-aaaar-qaada-cai",
  indexCanisterId: "n5wcd-faaaa-aaaar-qaaea-cai",
  name: "ckBTC",
  symbol: "ckBTC",
  decimals: 8,
  fee: 10n,
};

const CKETH: NativeLedgerFixture = {
  key: "cketh",
  canisterId: "ss2fx-dyaaa-aaaar-qacoq-cai",
  indexCanisterId: "s3zol-vqaaa-aaaar-qacpa-cai",
  name: "ckETH",
  symbol: "ckETH",
  decimals: 18,
  fee: 2_000_000_000_000n,
};

describe("real local chain-key fixture definitions", () => {
  test("pin canonical protocol IDs and every downloaded Wasm", () => {
    for (const canisterId of Object.values(localNativeChainFixtureIds())) {
      expect(Principal.fromText(canisterId).toText()).toBe(canisterId);
    }
    expect(localNativeChainFixtureIds()).toEqual({
      btc_checker: BTC_CHECKER_CANISTER_ID,
      ckbtc_minter: CKBTC_MINTER_CANISTER_ID,
      cketh_minter: CKETH_MINTER_CANISTER_ID,
      evm_rpc: EVM_RPC_CANISTER_ID,
    });
    for (const artifact of [
      BTC_CHECKER_WASM_ARTIFACT,
      CKBTC_MINTER_WASM_ARTIFACT,
      CKETH_MINTER_WASM_ARTIFACT,
      EVM_RPC_WASM_ARTIFACT,
    ]) {
      expect(artifact.url).toStartWith("https://");
      expect(artifact.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test("uses stable binary Candid constructor arguments", () => {
    const cases: Array<[Uint8Array, number, string]> = [
      [
        encodeBtcCheckerInitArgs(),
        177,
        "afc335314322dce62466a21c9b1a8678b5c49182dfc76727ec18c97eedff6b5c",
      ],
      [
        encodeCkBtcMinterInitArgs(),
        324,
        "e5439aaf87f19e1e2e62be89df91eea49eefbb020b97456dd610679bb070d74c",
      ],
      [
        encodeEvmRpcInitArgs(),
        145,
        "5daae8aa52c8f8bf353f725a50214d71a87cb56b044c5c07565a94b1244515dc",
      ],
      [
        encodeCkEthMinterInitArgs(),
        231,
        "666fea7b170c15e170b2d81e9792d427161f7912ce2230e5513046db56a0a17d",
      ],
    ];
    for (const [bytes, length, digest] of cases) {
      expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("DIDL");
      expect(bytes).toHaveLength(length);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
    }
    expect(() => encodeCkEthMinterInitArgs(-1n)).toThrow(
      "ckETH last scraped block cannot be negative",
    );
    expect(new TextDecoder().decode(encodeCkEthMinterUpgradeArgs().slice(0, 4)))
      .toBe("DIDL");
  });

  test("encodes chain deposit values deterministically", () => {
    const principal = Principal.fromText("efadq-gl777-77774-aaaba-cai");
    const bytes = Buffer.from(principalWord(principal).slice(2), "hex");
    expect(bytes).toHaveLength(32);
    expect(bytes[0]).toBe(principal.toUint8Array().length);
    expect(formatSatoshis(1n)).toBe("0.00000001");
    expect(formatSatoshis(1_000_000_001n)).toBe("10.00000001");
  });

  test("keeps checksum-verified helper bytecode in the provision package", async () => {
    const bytes = (
      await readFile(
        path.resolve(import.meta.dir, "../assets/CkEthDeposit.bin"),
        "utf8",
      )
    ).trim();
    expect(
      createHash("sha256").update(Buffer.from(bytes, "hex")).digest("hex"),
    ).toBe(
      "400d83fd3b960a5cefb5453cc715a617c62b49238224d3cdda44b17d607744ac",
    );
  });
});

test("cold native setup installs protocols around their real minting ledgers", async () => {
  const calls: string[] = [];
  const identity = Ed25519KeyIdentity.generate(
    new Uint8Array(32).fill(7),
  );
  const artifacts = preparedArtifacts();
  const client: LocalNativeFixtureClient = {
    async ensureCanister(canisterId) {
      calls.push(`create:${canisterId}`);
      return { moduleHashHex: null };
    },
    async ensureInstalled({ label, arg }) {
      expect(new TextDecoder().decode(arg.slice(0, 4))).toBe("DIDL");
      calls.push(`install:${label}`);
    },
    async installWasm({ canisterId, mode, arg }) {
      expect(new TextDecoder().decode(arg.slice(0, 4))).toBe("DIDL");
      calls.push(`${mode}:${canisterId}`);
    },
    async verifyLedgerPair({ fixture, expectedMinter }) {
      calls.push(`verify:${fixture.key}:${expectedMinter}`);
    },
    async ckethMinterAddress() {
      return "0x0000000000000000000000000000000000000002";
    },
    async ckethSmartContractAddress() {
      return calls.some((call) => call.startsWith("upgrade:"))
        ? "0x0000000000000000000000000000000000000003"
        : "N/A";
    },
    async evmRpcNodesInSubnet() {
      return 1;
    },
    async ckbtcAddress() {
      return "bcrt1qfixture";
    },
    async ckbtcUpdateBalance() {},
    async ledgerBalance() {
      return 0n;
    },
  };

  const fixtureIds = await ensureLocalNativeChainFixtures(
    {
      gatewayUrl: "http://localhost:8000/",
      expectedRootKeyBase64: "AQ==",
      cacheDirectory: "/repo/.neutron/cache/fixtures",
      identity,
      fixtures: [CKBTC, CKETH],
      ledgerArtifacts: {
        ledger: { wasm: new Uint8Array([5]), moduleHashHex: "5".repeat(64) },
        index: { wasm: new Uint8Array([6]), moduleHashHex: "6".repeat(64) },
      },
      encodeLedgerInitArgs: () => didl(7),
      encodeIndexInitArgs: () => didl(8),
      logger: { log() {} },
    },
    {
      createClient: async () => client,
      resolveArtifacts: async () => artifacts,
      advanceFinality: async () => {
        calls.push("anvil:finalize");
      },
      finalizedBlockNumber: async () => 123n,
      ensureDepositHelper: async ({ minterAddress }) => {
        expect(minterAddress).toBe(
          "0x0000000000000000000000000000000000000002",
        );
        return {
          address: "0x0000000000000000000000000000000000000003",
          changed: true,
        };
      },
    },
  );

  expect(fixtureIds).toEqual(localNativeChainFixtureIds());
  expect(calls).toContain("install:Bitcoin checker");
  expect(calls).toContain("install:EVM RPC");
  expect(calls).toContain("install:ckBTC minter");
  expect(calls).toContain("install:ckETH minter");
  expect(calls).toContain(`verify:ckbtc:${CKBTC_MINTER_CANISTER_ID}`);
  expect(calls).toContain(`verify:cketh:${CKETH_MINTER_CANISTER_ID}`);
  expect(calls).toContain(`upgrade:${CKETH_MINTER_CANISTER_ID}`);
  expect(calls).toContain("anvil:finalize");
});

test("native artifact resolver rejects unpinned bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-native-artifact-"));
  try {
    await expect(
      resolveNativeChainArtifacts({
        cacheDirectory: root,
        logger: { log() {} },
        fetcher: (async () =>
          new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("checksum mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function preparedArtifacts(): PreparedNativeChainArtifacts {
  return {
    btcChecker: { wasm: new Uint8Array([1]), moduleHashHex: "1".repeat(64) },
    ckbtcMinter: { wasm: new Uint8Array([2]), moduleHashHex: "2".repeat(64) },
    ckethMinter: { wasm: new Uint8Array([3]), moduleHashHex: "3".repeat(64) },
    evmRpc: { wasm: new Uint8Array([4]), moduleHashHex: "4".repeat(64) },
  };
}

function didl(byte: number): Uint8Array {
  return new Uint8Array([68, 73, 68, 76, byte]);
}
