import { expect } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import {
  DirectPocketIcCalls, kitchenSinkUpgradeMethods, walletUpgradeCommandId,
  walletUpgradeFundingRequest, walletUpgradeMethods,
} from "../legacy_kernel_upgrade.pocketic.test.ts";
import type { CallApp } from "./new_apps.ts";

const ICP = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
const principal = (value: number) => Principal.selfAuthenticating(new Uint8Array(32).fill(value));

export async function seedExistingApps(callApp: CallApp, direct: DirectPocketIcCalls, canister: Principal, owner: Principal): Promise<() => Promise<void>> {
  const kitchen = kitchenSinkUpgradeMethods();
  expect(await callApp("kitchensink", "save_profile", kitchen.saveProfile, [[
    "EVM upgrade Ada", "ada+evm@example.test", "Retain this production predecessor profile", false,
  ]])).toBe("Saved EVM upgrade Ada <ada+evm@example.test>");
  await callApp("kitchensink", "bump_counter", kitchen.bumpCounter, [731n]);
  const profile = await callApp("kitchensink", "read_profile", kitchen.readProfile, [null]);
  const counter = await callApp("kitchensink", "read_counter", kitchen.readCounter, [null]) as bigint;

  const wallet = walletUpgradeMethods();
  await callApp("wallet", "wallet_set_ledgers", wallet.setLedgers, [[ICP]]);
  await callApp("wallet", "wallet_refresh_balances", wallet.refreshBalances, [null]);
  const funded = await callApp("wallet", "wallet_snapshot", wallet.snapshot, [null]);
  expect(funded).toMatchObject({ configured: true, ledgers: [{ principal: ICP, balance: [200_000_000n] }] });

  const requests = [0, 1, 2].map((index) => ({
    ...walletUpgradeFundingRequest(0x51 + index, principal(141 + index), 120_001n + BigInt(index)),
    valid_until_ns: BigInt(Date.now() + 540_000) * 1_000_000n,
  }));
  for (const request of requests) {
    expect(await callApp("wallet", "wallet_funding_prepare_v1", wallet.fundingPrepare, [request]))
      .toMatchObject({ ok: { prepared: { command_id: walletUpgradeCommandId(request) } } });
  }
  // The same established concurrent ingress pattern as the legacy Wallet
  // qualification gives one durable accepted/pending command and one receipt.
  const submitted = await Promise.all(requests.slice(1).map((request) => direct.submitActorCall(
    canister, owner, physicalAppMethodName("wallet", "wallet_funding_execute_v1"), wallet.fundingExecute,
    [{ command_id: walletUpgradeCommandId(request) }],
  )));
  const dispatched = await Promise.all(submitted.map((call) => direct.awaitActorCall(call))) as Record<string, unknown>[];
  expect(dispatched.some((result) => "pending" in result)).toBe(true);
  expect(dispatched.some((result) => "transferred" in result)).toBe(true);
  const commands = await Promise.all(requests.map(async (request) => ({
    request,
    before: await callApp("wallet", "wallet_funding_prepare_v1", wallet.fundingPrepare, [request]),
  })));
  await callApp("wallet", "wallet_refresh_balances", wallet.refreshBalances, [null]);
  const snapshot = await callApp("wallet", "wallet_snapshot", wallet.snapshot, [null]);
  type History = {
    ledgers: Array<{ transaction_count: bigint; adjustment_count: bigint }>;
  };
  let history = await callApp("wallet", "wallet_history_status", wallet.historyStatus, [null]) as History;
  const historyCount = (value: History) => value.ledgers.reduce((total, ledger) => total + ledger.transaction_count, 0n);
  for (let attempt = 0; historyCount(history) === 0n && attempt < 20; attempt += 1) {
    await callApp("wallet", "wallet_history_sync", wallet.historySync, [null]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    history = await callApp("wallet", "wallet_history_status", wallet.historyStatus, [null]) as History;
  }
  expect(historyCount(history)).toBeGreaterThan(0n);

  return async () => {
    expect(await callApp("kitchensink", "read_profile", kitchen.readProfile, [null])).toEqual(profile);
    const after = await callApp("kitchensink", "read_counter", kitchen.readCounter, [null]) as bigint;
    // Kitchen's declared start task may increment once at each activation.
    // Preserve the seeded lower bound; a reset would be far below it.
    expect(after).toBeGreaterThanOrEqual(counter);
    expect(after).toBeLessThanOrEqual(counter + 4n);
    expect(await callApp("wallet", "wallet_snapshot", wallet.snapshot, [null])).toEqual(snapshot);
    const historyAfter = await callApp("wallet", "wallet_history_status", wallet.historyStatus, [null]) as typeof history;
    expect(historyAfter.ledgers.reduce((total, ledger) => total + ledger.transaction_count, 0n))
      .toBeGreaterThanOrEqual(history.ledgers.reduce((total, ledger) => total + ledger.transaction_count, 0n));
    for (const { request, before } of commands) {
      expect(await callApp("wallet", "wallet_funding_prepare_v1", wallet.fundingPrepare, [{
        ...request, caller: { ...request.caller, endpoint: "app:wallet_upgrade_fixture:replacement" },
      }])).toEqual(before);
      const conflict = await callApp("wallet", "wallet_funding_prepare_v1", wallet.fundingPrepare, [{
        ...request, intent: { direct: { ...request.intent.direct, amount_atoms: request.intent.direct.amount_atoms + 1n } },
      }]) as { err?: string };
      expect(conflict.err).toContain("conflicts with another intent");
    }
  };
}

const kinds = ["backend_calls", "randomness", "https_outcalls", "chain_key_signing", "wallet_custody_signing", "stable_store", "vetkeys", "scheduled_tasks", "connections", "persistent_browser_storage", "dedicated_resident_origin", "http_routes", "certified_read_routes", "certified_assets", "public_ingress"];
const kindType = IDL.Variant(Object.fromEntries(kinds.map((kind) => [kind, IDL.Null])));
const scopeType = IDL.Record({ app_id: IDL.Text, installation_uid: IDL.Nat64 });
const usageType = IDL.Record({ total: IDL.Nat64, succeeded: IDL.Nat64, denied: IDL.Nat64, failed: IDL.Nat64, rate_limited: IDL.Nat64, busy: IDL.Nat64, revoked: IDL.Nat64 });
const capabilityType = IDL.Record({ scope: scopeType, kind: kindType, resource_id: IDL.Text, enabled: IDL.Bool, toggleable: IDL.Bool, usage: usageType });
const pageMethod = IDL.Func([IDL.Record({ after: IDL.Opt(IDL.Text), limit: IDL.Nat })], [IDL.Record({ entries: IDL.Vec(capabilityType), next: IDL.Opt(IDL.Text) })], ["query"]);
type Capability = { scope: { app_id: string; installation_uid: bigint }; kind: Record<string, null>; resource_id: string; enabled: boolean; toggleable: boolean; usage: Record<string, bigint> };
export { pageMethod as upgradeCapabilityPageMethod };
export type { Capability };

export async function seedKernelState(callApp: CallApp, direct: DirectPocketIcCalls, canister: Principal, owner: Principal): Promise<() => Promise<void>> {
  const callKernel = (name: string, method: IDL.FuncClass, args: unknown[]) => direct.actorCall(canister, owner, name, method, args);
  const capabilities = async (): Promise<Capability[]> => {
    const rows: Capability[] = [];
    let after: [] | [string] = [];
    do {
      const page = await callKernel("kernel_capabilities_page", pageMethod, [{ after, limit: 100n }]) as { entries: Capability[]; next: [] | [string] };
      rows.push(...page.entries);
      after = page.next;
    } while (after.length !== 0);
    return rows;
  };
  const randomMethod = IDL.Func([IDL.Null], [IDL.Text], []);
  expect(await callApp("kitchensink", "random_bytes", randomMethod, [null])).toMatch(/^0x[0-9a-f]{64}$/);
  const random = (await capabilities()).find((row) => row.scope.app_id === "kitchensink" && "randomness" in row.kind);
  if (!random) throw new Error("Kitchen Sink randomness capability was not installed");
  const setEnabled = IDL.Func([IDL.Record({ app_id: IDL.Text, installation_uid: IDL.Nat64, kind: IDL.Variant({ randomness: IDL.Null }), resource_id: IDL.Text, enabled: IDL.Bool })], [capabilityType], []);
  await callKernel("kernel_capability_set_enabled", setEnabled, [{ ...random.scope, kind: random.kind, resource_id: random.resource_id, enabled: false }]);
  await callApp("kitchensink", "random_bytes", randomMethod, [null]);
  const disabled = (await capabilities()).find((row) => row.scope.app_id === "kitchensink" && "randomness" in row.kind)!;
  expect(disabled.enabled).toBe(false);
  expect(disabled.usage.succeeded).toBeGreaterThan(0n);
  expect(disabled.usage.revoked).toBeGreaterThan(0n);

  const keyMethod = IDL.Func([IDL.Null], [IDL.Record({ ok: IDL.Bool, error: IDL.Text, public_key_hex: IDL.Text, key_fingerprint_hex: IDL.Text, signing_domain_hex: IDL.Text, namespace_version: IDL.Nat })], []);
  const assertionKey = await callApp("kitchensink", "chain_key_public_key", keyMethod, [null]);
  expect(assertionKey).toMatchObject({ ok: true, error: "", namespace_version: 1n });

  return async () => {
    expect(await direct.isAuthorized(canister, owner)).toBe(true);
    const after = (await capabilities()).find((row) => row.scope.app_id === "kitchensink" && "randomness" in row.kind);
    expect(after).toEqual(disabled);
    expect(await callApp("kitchensink", "chain_key_public_key", keyMethod, [null])).toEqual(assertionKey);
  };
}
