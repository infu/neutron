// Exact public Wallet315 contracts used by the checked-upgrade qualification.
// These projections do not expose or patch its managed-memory representation.
import { IDL } from "@dfinity/candid";
export const blob = IDL.Vec(IDL.Nat8);
export const optionalText = IDL.Opt(IDL.Text);
export const account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(blob) });
export const variant = (...names: string[]) => IDL.Variant(Object.fromEntries(names.map((name) => [name, IDL.Null])));
export const result = (type: IDL.Type) => IDL.Variant({ ok: type, err: IDL.Text });
export const method = (args: [] | [IDL.Type, ...IDL.Type[]], reply: IDL.Type, query = false) => IDL.Func(args, [reply], query ? ["query"] : []);
const source = IDL.Variant({ external: IDL.Null, evm: IDL.Null, evm_agent: IDL.Record({ app_id: IDL.Text, installation_uid: IDL.Text }) });
const stepKind = variant("reset_approval", "approval", "deposit");
const bridgeQuote = IDL.Record({
  chain_id: IDL.Nat, ledger: IDL.Principal, minter: IDL.Principal,
  helper_address: IDL.Text, helper_mode: variant("subaccount", "legacy"),
  minter_address: IDL.Text, token_address: optionalText, recipient: IDL.Principal,
  principal_word: IDL.Text, subaccount_word: IDL.Text,
});
export const bridgeIntent = IDL.Record({
  id: blob, quote: bridgeQuote, source, account: IDL.Text, amount: IDL.Nat,
  subaccount: IDL.Opt(blob),
  steps: IDL.Vec(IDL.Record({ kind: stepKind, state: variant("ready", "unknown", "submitted", "confirmed", "failed"), operation_id: optionalText, transaction_hash: optionalText, error: optionalText })),
  revision: IDL.Nat, created_at: IDL.Int, updated_at: IDL.Int, event_cursor: IDL.Nat64,
  accepted_deposit: IDL.Opt(IDL.Record({ log_index: IDL.Nat, block_number: IDL.Nat, event_index: IDL.Nat64 })),
  mint: IDL.Opt(IDL.Record({ ledger_block_index: IDL.Nat, event_index: IDL.Nat64, verified_ledger: IDL.Bool })),
  error: optionalText,
});
export const bridgeMethods = {
  prepare: method([IDL.Record({ id: blob, ledger: IDL.Principal, source, account: IDL.Text, amount: IDL.Nat, subaccount: IDL.Opt(blob) })], result(bridgeIntent)),
  claim: method([IDL.Record({ id: blob, revision: IDL.Nat, step: stepKind, operation_id: optionalText })], result(bridgeIntent)),
  record: method([IDL.Record({ id: blob, revision: IDL.Nat, step: stepKind, state: variant("submitted", "confirmed", "failed", "unknown"), transaction_hash: optionalText, error: optionalText })], result(bridgeIntent)),
  status: method([blob], result(bridgeIntent), true),
  refresh: method([IDL.Record({ id: blob, event_page_length: IDL.Nat64 })], result(bridgeIntent)),
  list: method([IDL.Record({ ledger: IDL.Opt(IDL.Principal), after: IDL.Opt(blob), limit: IDL.Nat })], IDL.Record({ records: IDL.Vec(bridgeIntent), next: IDL.Opt(blob) }), true),
};
const destinationFields = {
  internet_computer: account, bitcoin_mainnet: IDL.Text, dogecoin_mainnet: IDL.Text,
  ethereum_mainnet: IDL.Text, solana_mainnet: IDL.Text,
};
const destination = IDL.Variant(destinationFields);
const contactDestination = IDL.Variant({ ...destinationFields, neutron: IDL.Principal });
const addressFields = { address_label: optionalText, destination: contactDestination, preferred: IDL.Bool };
const contact = IDL.Record({ id: IDL.Nat, revision: IDL.Nat, addresses: IDL.Vec(IDL.Record({ id: IDL.Nat, ...addressFields })) });
export const contactMethods = {
  save: method([IDL.Record({ id: IDL.Opt(IDL.Nat), expected_revision: IDL.Opt(IDL.Nat), kind: variant("person", "self"), name: IDL.Text, notes: IDL.Text, addresses: IDL.Vec(IDL.Record({ id: IDL.Opt(IDL.Nat), ...addressFields })) })], IDL.Reserved),
  get: method([IDL.Record({ id: IDL.Nat })], IDL.Opt(contact), true),
};
const receipt = IDL.Record({ ledger: IDL.Principal, native: IDL.Bool, contact_id: IDL.Nat, address_id: IDL.Nat, amount: IDL.Nat, fee: IDL.Nat, block_index: IDL.Nat, secondary_block_index: IDL.Opt(IDL.Nat), duplicate: IDL.Bool });
const settlement = IDL.Record({ checked_at: IDL.Int, status: IDL.Variant({ pending: IDL.Text, submitted: IDL.Record({ transaction_hash: IDL.Text, message: IDL.Text }), confirmed: IDL.Record({ transaction_hash: IDL.Text }), failed: IDL.Text, unknown: IDL.Text }) });
export const transferOperation = IDL.Record({
  request_id: blob, ledger: IDL.Principal, amount: IDL.Nat, native: IDL.Bool, destination: IDL.Text,
  created_at_ns: IDL.Nat64, message: optionalText, settlement: IDL.Opt(settlement),
  status: IDL.Variant({ pending: IDL.Null, succeeded: receipt, rejected: IDL.Text }),
});
export const transferRequest = IDL.Record({
  request_id: blob,
  transfer: IDL.Record({ ledger: IDL.Principal, network: variant(...Object.keys(destinationFields)), contact_id: IDL.Nat, contact_revision: IDL.Nat, address_id: IDL.Nat, expected_destination: destination, amount: IDL.Nat }),
  withdrawal_quote: IDL.Opt(IDL.Record({ asset_fee: IDL.Nat, gas: IDL.Opt(IDL.Record({ ledger: IDL.Principal, minter: IDL.Principal, budget: IDL.Nat, ledger_fee: IDL.Nat })) })),
});
export const transferMethods = {
  prepare: method([transferRequest], result(transferOperation)),
  resume: method([blob], result(transferOperation)),
  status: method([blob], result(transferOperation), true),
  pending: method([IDL.Null], IDL.Vec(transferOperation), true),
  acknowledge: method([blob], result(transferOperation)),
  refresh: method([blob], result(transferOperation)),
};
const eventSource = IDL.Record({ transaction_hash: IDL.Text, log_index: IDL.Nat });
const depositFields = { transaction_hash: IDL.Text, block_number: IDL.Nat, log_index: IDL.Nat, from_address: IDL.Text, value: IDL.Nat, principal: IDL.Principal, subaccount: IDL.Opt(blob) };
export const minterEvent = IDL.Record({ timestamp: IDL.Nat64, payload: IDL.Variant({
  AcceptedDeposit: IDL.Record(depositFields),
  AcceptedErc20Deposit: IDL.Record({ ...depositFields, erc20_contract_address: IDL.Text }),
  MintedCkEth: IDL.Record({ event_source: eventSource, mint_block_index: IDL.Nat }),
  MintedCkErc20: IDL.Record({ event_source: eventSource, erc20_contract_address: IDL.Text, mint_block_index: IDL.Nat }),
  InvalidDeposit: IDL.Record({ event_source: eventSource, reason: IDL.Text }),
  QuarantinedDeposit: IDL.Record({ event_source: eventSource }), FutureUnknown: IDL.Text,
}) });
export const fixtureConfig = IDL.Record({ symbol: IDL.Text, decimals: IDL.Nat8, fee: IDL.Nat, balance: IDL.Nat, lose_transfer_reply: IDL.Bool, lose_withdrawal_reply: IDL.Bool, native_status: variant("pending", "submitted", "confirmed"), events: IDL.Vec(minterEvent) });
export const fixtureProbe = IDL.Record({ transfer_args: IDL.Vec(blob), approve_args: IDL.Vec(blob), withdrawal_args: IDL.Vec(blob), transfer_calls: IDL.Nat, transfer_effects: IDL.Nat, approve_calls: IDL.Nat, approve_effects: IDL.Nat, withdrawal_calls: IDL.Nat, withdrawal_effects: IDL.Nat, withdrawal_blocks: IDL.Vec(IDL.Nat) });
export const icrcTransferArgs = IDL.Record({ from_subaccount: IDL.Opt(blob), to: account, amount: IDL.Nat, fee: IDL.Opt(IDL.Nat), memo: IDL.Opt(blob), created_at_time: IDL.Opt(IDL.Nat64) });
