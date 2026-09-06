import { expect } from "bun:test";
import { IDL } from "@dfinity/candid";

export type CallApp = (
  appId: string,
  name: string,
  method: IDL.FuncClass,
  args: unknown[],
) => Promise<unknown>;

export type FixtureCaller = {
  app_id: string;
  installation_uid: bigint;
  endpoint: string;
};

const optionalText = IDL.Opt(IDL.Text);
const blob = IDL.Vec(IDL.Nat8);
const caller = IDL.Record({
  app_id: IDL.Text,
  installation_uid: IDL.Nat64,
  endpoint: IDL.Text,
});
const identity = IDL.Record({ caller, request_id: IDL.Text });
const accessEntry = IDL.Record({
  address: IDL.Text,
  storageKeys: IDL.Vec(IDL.Text),
});
const transactionRequest = IDL.Record({
  to: IDL.Text,
  value: IDL.Text,
  data: IDL.Text,
  gas_limit: optionalText,
  max_fee_per_gas: optionalText,
  max_priority_fee_per_gas: optionalText,
  gas_price: optionalText,
  transaction_type: optionalText,
  access_list: IDL.Vec(accessEntry),
});
const intent = IDL.Record({
  account_id: IDL.Text,
  chain_id: IDL.Nat,
  operation: IDL.Variant({
    transaction: transactionRequest,
    personal_message: IDL.Record({ message: IDL.Text }),
    typed_data: IDL.Record({ json: IDL.Text }),
    replacement: IDL.Record({
      operation_id: IDL.Nat,
      cancel: IDL.Bool,
      max_fee_per_gas: IDL.Text,
      max_priority_fee_per_gas: IDL.Text,
    }),
  }),
});
const account = IDL.Record({
  id: IDL.Text,
  slot: IDL.Text,
  address: IDL.Text,
  public_key: blob,
  key_fingerprint: blob,
  namespace_version: IDL.Nat,
});
const asset = IDL.Record({
  chain_id: IDL.Nat,
  address: IDL.Text,
  symbol: IDL.Text,
  decimals: IDL.Nat,
});
const snapshot = IDL.Record({
  accounts: IDL.Vec(account),
  assets: IDL.Vec(asset),
  networks: IDL.Vec(IDL.Record({
    chain_id: IDL.Nat,
    name: IDL.Text,
    native_symbol: IDL.Text,
    explorer_url: IDL.Text,
    testnet: IDL.Bool,
    finality_description: IDL.Text,
  })),
  lifecycle: IDL.Text,
});
const operation = IDL.Record({
  operation_id: IDL.Nat,
  request_id: IDL.Text,
  account_id: IDL.Text,
  chain_id: IDL.Nat,
  caller,
  kind: IDL.Text,
  status: IDL.Text,
  address: IDL.Text,
  transaction_hash: optionalText,
  signature: optionalText,
  message: optionalText,
  review_revision: IDL.Nat,
  review: IDL.Opt(IDL.Record({
    nonce: IDL.Text,
    gas_limit: IDL.Text,
    max_fee_per_gas: optionalText,
    max_priority_fee_per_gas: optionalText,
    gas_price: optionalText,
    balance: IDL.Text,
    simulation: IDL.Text,
    observed_at: IDL.Int,
  })),
  receipt_json: optionalText,
  finality: optionalText,
  created_at: IDL.Int,
  updated_at: IDL.Int,
  intent,
  prepared_transaction: IDL.Opt(IDL.Record({
    to: optionalText,
    value: IDL.Text,
    data: IDL.Text,
    access_list: IDL.Vec(accessEntry),
    chain_id: IDL.Nat,
    nonce: IDL.Text,
    gas_limit: IDL.Text,
    transaction_type: IDL.Text,
    max_fee_per_gas: optionalText,
    max_priority_fee_per_gas: optionalText,
    gas_price: optionalText,
  })),
});
const result = (value: IDL.Type) => IDL.Variant({ ok: value, err: IDL.Text });
const snapshotMethod = IDL.Func([IDL.Null], [result(snapshot)], ["query"]);
const historyMethod = IDL.Func(
  [IDL.Record({ offset: IDL.Nat, limit: IDL.Nat })],
  [result(IDL.Record({ operations: IDL.Vec(operation), total: IDL.Nat }))],
  ["query"],
);
const statusMethod = IDL.Func(
  [IDL.Record({ identity, refresh: IDL.Bool })],
  [result(operation)],
  [],
);

const beginFields = {
  id: IDL.Text,
  account_id: IDL.Text,
  chain_id: IDL.Nat,
  recipient: IDL.Text,
  quote_json: IDL.Text,
  approval_request_id: optionalText,
  approval_request_json: optionalText,
  swap_request_id: IDL.Text,
  swap_request_json: IDL.Text,
};
const swap = IDL.Record({
  ...beginFields,
  approval_operation_json: optionalText,
  swap_operation_json: optionalText,
  phase: IDL.Text,
  revision: IDL.Nat,
  created_at: IDL.Int,
  updated_at: IDL.Int,
});
const swapListMethod = IDL.Func([IDL.Null], [IDL.Vec(swap)], ["query"]);
const swapGetMethod = IDL.Func([IDL.Text], [IDL.Opt(swap)], ["query"]);

function ok(value: unknown): Record<string, unknown> {
  expect(value).toBeObject();
  expect(value).toHaveProperty("ok");
  expect(value).not.toHaveProperty("err");
  return (value as { ok: Record<string, unknown> }).ok;
}

export async function assertNewAppsFresh(callApp: CallApp): Promise<void> {
  const fresh = ok(await callApp("evm_wallet", "evm_wallet_snapshot_v1", snapshotMethod, [null]));
  expect(fresh.accounts).toEqual([]);
  expect((fresh.assets as unknown[]).length).toBe(2);
  expect((fresh.networks as Array<{ chain_id: bigint }>).map((network) => network.chain_id))
    .toEqual([1n, 42161n, 11155111n]);
  expect(ok(await callApp("evm_wallet", "evm_wallet_history_v1", historyMethod, [{ offset: 0n, limit: 10n }])))
    .toEqual({ operations: [], total: 0n });
  expect(await callApp("uniswap", "uniswap_list_v1", swapListMethod, [null])).toEqual([]);
}

/**
 * Exercise public production APIs only. PocketIC supplies a local threshold
 * public key; preparing a personal message performs no RPC or signing. The
 * retained prepared command is work still awaiting owner approval.
 */
export async function seedAndCaptureNewApps(
  callApp: CallApp,
  fixtureCaller: FixtureCaller,
): Promise<() => Promise<void>> {
  const trackedAsset = {
    chain_id: 42161n,
    address: "0x3333333333333333333333333333333333333333",
    symbol: "UPGRADE",
    decimals: 7n,
  };
  ok(await callApp("evm_wallet", "evm_wallet_asset_set_v1", IDL.Func([asset], [result(snapshot)], []), [trackedAsset]));
  const requestIdentity = { caller: fixtureCaller, request_id: "11111111111111111111111111111111" };
  const request = {
    identity: requestIdentity,
    intent: {
      account_id: "main",
      chain_id: 42161n,
      operation: { personal_message: { message: "0x7175616c696679" } },
    },
  };
  const prepared = ok(await callApp("evm_wallet", "evm_wallet_prepare_v1", IDL.Func(
    [IDL.Record({ identity, intent })], [result(operation)], [],
  ), [request]));
  expect(prepared).toMatchObject({
    operation_id: 1n,
    request_id: requestIdentity.request_id,
    caller: fixtureCaller,
    account_id: "main",
    chain_id: 42161n,
    kind: "message",
    status: "prepared",
    review_revision: 1n,
    signature: [],
    transaction_hash: [],
    prepared_transaction: [],
    intent: request.intent,
  });
  expect(prepared.address).toMatch(/^0x[0-9a-f]{40}$/);
  const walletBefore = ok(await callApp("evm_wallet", "evm_wallet_snapshot_v1", snapshotMethod, [null]));
  expect(walletBefore.assets).toContainEqual(trackedAsset);
  const accounts = walletBefore.accounts as Array<Record<string, unknown>>;
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({ id: "main", slot: "main", address: prepared.address });
  expect((accounts[0]!.public_key as Uint8Array).length).toBe(33);
  expect((accounts[0]!.key_fingerprint as Uint8Array).length).toBe(32);
  const historyBefore = ok(await callApp("evm_wallet", "evm_wallet_history_v1", historyMethod, [{ offset: 0n, limit: 10n }]));
  expect(historyBefore).toEqual({ operations: [prepared], total: 1n });

  // The journal intentionally treats JSON as opaque immutable data. These
  // local qualification records test durability, never claim a real quote or
  // execute through the browser controller.
  const swapInput = {
    id: "checked-upgrade-swap",
    account_id: "main",
    chain_id: 42161n,
    recipient: prepared.address,
    quote_json: '{"qualification":true,"amountIn":"1000000","minimumOut":"990000"}',
    approval_request_id: ["22222222222222222222222222222222"],
    approval_request_json: ['{"requestId":"22222222222222222222222222222222","chainId":"42161","accountId":"main"}'],
    swap_request_id: "33333333333333333333333333333333",
    swap_request_json: '{"requestId":"33333333333333333333333333333333","chainId":"42161","accountId":"main"}',
  };
  expect(ok(await callApp("uniswap", "uniswap_begin_v1", IDL.Func([IDL.Record(beginFields)], [result(swap)], []), [swapInput])))
    .toMatchObject({ ...swapInput, phase: "queued", revision: 0n });
  const swapPending = ok(await callApp("uniswap", "uniswap_update_v1", IDL.Func([IDL.Record({
    id: IDL.Text,
    expected_revision: IDL.Nat,
    stage: IDL.Text,
    request_id: IDL.Text,
    account_id: IDL.Text,
    chain_id: IDL.Nat,
    operation_json: optionalText,
    phase: IDL.Text,
  })], [result(swap)], []), [{
    id: swapInput.id,
    expected_revision: 0n,
    stage: "approval",
    request_id: swapInput.approval_request_id[0],
    account_id: swapInput.account_id,
    chain_id: swapInput.chain_id,
    operation_json: [],
    phase: "approval_requested",
  }]));
  expect(swapPending).toMatchObject({
    ...swapInput,
    phase: "approval_requested",
    revision: 1n,
    approval_operation_json: [],
    swap_operation_json: [],
  });
  expect(await callApp("uniswap", "uniswap_get_v1", swapGetMethod, [swapInput.id])).toEqual([swapPending]);

  return async () => {
    expect(ok(await callApp("evm_wallet", "evm_wallet_snapshot_v1", snapshotMethod, [null]))).toEqual(walletBefore);
    expect(ok(await callApp("evm_wallet", "evm_wallet_status_v1", statusMethod, [{ identity: requestIdentity, refresh: false }]))).toEqual(prepared);
    expect(ok(await callApp("evm_wallet", "evm_wallet_history_v1", historyMethod, [{ offset: 0n, limit: 10n }]))).toEqual(historyBefore);
    expect(await callApp("uniswap", "uniswap_get_v1", swapGetMethod, [swapInput.id])).toEqual([swapPending]);
    expect(await callApp("uniswap", "uniswap_list_v1", swapListMethod, [null])).toEqual([swapPending]);
  };
}
