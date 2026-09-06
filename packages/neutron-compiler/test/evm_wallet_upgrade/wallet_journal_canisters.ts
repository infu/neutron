import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import type { DirectPocketIcCalls, DirectPocketIcClient } from "../legacy_kernel_upgrade.pocketic.test.ts";
import { compileLocalFixture, installLocalFixture } from "./actor_fixtures.ts";
import { fixtureConfig, fixtureProbe } from "./wallet_journal_types.ts";

export const USDC_LEDGER = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
export const ETH_LEDGER = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
export const MINTER = Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai");
export const GAS_BUDGET = 130_000_000_000_000n;
export type Probe = {
  transfer_args: Uint8Array[]; approve_args: Uint8Array[]; withdrawal_args: Uint8Array[];
  transfer_calls: bigint; transfer_effects: bigint; approve_calls: bigint; approve_effects: bigint;
  withdrawal_calls: bigint; withdrawal_effects: bigint; withdrawal_blocks: bigint[];
};
export type Config = {
  symbol: string; decimals: number; fee: bigint; balance: bigint;
  lose_transfer_reply: boolean; lose_withdrawal_reply: boolean;
  native_status: Record<string, null>; events: unknown[];
};
export const compileJournalCanisterFixture = () => compileLocalFixture(new URL("./wallet_journal_fixture.mo", import.meta.url).pathname);

/** Isolated test actors at the route's canonical principals, never live IC calls. */
export async function installJournalCanisters(client: DirectPocketIcClient, instanceId: number, direct: DirectPocketIcCalls, deployer: Principal, wasm: Uint8Array) {
  for (const target of [USDC_LEDGER, ETH_LEDGER, MINTER]) await installLocalFixture(client, instanceId, deployer, wasm, target);
  const configurations = new Map<string, Config>([USDC_LEDGER, ETH_LEDGER, MINTER].map((target) => [target.toText(), {
    symbol: target.toText() === ETH_LEDGER.toText() ? "ckETH" : "ckUSDC", decimals: target.toText() === ETH_LEDGER.toText() ? 18 : 6,
    fee: 10n, balance: 1_000_000_000_000_000_000_000_000n, lose_transfer_reply: false, lose_withdrawal_reply: false, native_status: { submitted: null }, events: [],
  }]));
  const configure = async (target: Principal, patch: Partial<Config> = {}) => {
    const configuration = { ...configurations.get(target.toText())!, ...patch };
    configurations.set(target.toText(), configuration);
    await direct.actorCall(target, deployer, "fixture_configure", IDL.Func([fixtureConfig], [], []), [configuration]);
  };
  const probe = (target: Principal) => direct.actorCall(target, deployer, "fixture_probe", IDL.Func([], [fixtureProbe], ["query"]), []) as Promise<Probe>;
  for (const target of [USDC_LEDGER, ETH_LEDGER, MINTER]) await configure(target);
  return { configure, probe };
}
export type JournalCanisters = Awaited<ReturnType<typeof installJournalCanisters>>;
