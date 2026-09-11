import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { loadNeutronCanisterId, type SelfCallValue } from "neutron-tools/app";
import { candidIcrcAccountFromText, parsePrincipal } from "./icrc_account.ts";
import type { WalletFundingRequest } from "./funding.ts";
import { createDirectHistoryQuery } from "./history_reads.ts";
import { abortableHistoryQuery, type HistoryQuery } from "./history_transaction.ts";

export type FundingFacts = {
  owner: string;
  metadata: SelfCallValue;
  fee: string;
  allowance: SelfCallValue | null;
};
export type TokenFacts = {
  owner: string;
  metadata: SelfCallValue;
  fee: string;
  balance: string;
};

type MetadataValue = { Nat: bigint } | { Int: bigint } | { Text: string } | { Blob: Uint8Array };
type Metadata = Array<[string, MetadataValue]>;
type Allowance = { allowance: bigint; expires_at: [] | [bigint] };

const accountType = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
const metadataType = IDL.Vec(IDL.Tuple(IDL.Text, IDL.Variant({ Nat: IDL.Nat, Int: IDL.Int, Text: IDL.Text, Blob: IDL.Vec(IDL.Nat8) })));
const allowanceArgsType = IDL.Record({ account: accountType, spender: accountType });
const allowanceType = IDL.Record({ allowance: IDL.Nat, expires_at: IDL.Opt(IDL.Nat64) });

/** Public ledger observations for a review. The existing verified query
 * transport is anonymous and constructs only query methods. These facts never
 * authorize spending; Wallet checks them and re-reads before execution.
 */
export function createFundingReader({
  query = createDirectHistoryQuery(),
  loadOwner = loadNeutronCanisterId,
}: {
  query?: HistoryQuery;
  loadOwner?: () => Promise<string>;
} = {}) {
  query = abortableHistoryQuery(query);

  async function read(ledgerText: string, route: WalletFundingRequest["route"] | null, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const ledger = parsePrincipal(ledgerText, "Wallet token ledger").toText();
    const owner = parsePrincipal(await loadOwner(), "Wallet owner").toText();
    signal?.throwIfAborted();
    const account = { owner: Principal.fromText(owner), subaccount: [] };
    const common = { canister: ledger, ...(signal ? { signal } : {}) };
    let third: Promise<unknown>;
    if (route?.kind === "allowance") {
      const spender = candidIcrcAccountFromText(route.spender, "Wallet allowance spender");
      third = query({ ...common, method: "icrc2_allowance", argTypes: [allowanceArgsType], resultType: allowanceType,
        args: [{ account, spender: { owner: Principal.fromText(spender.owner), subaccount: spender.subaccount === null ? [] : [spender.subaccount] } }] });
    } else if (route === null) {
      third = query({ ...common, method: "icrc1_balance_of", argTypes: [accountType], resultType: IDL.Nat, args: [account] });
    } else third = Promise.resolve(null);
    const [metadata, fee, extra] = await Promise.all([
      query({ ...common, method: "icrc1_metadata", argTypes: [], resultType: metadataType, args: [] }),
      query({ ...common, method: "icrc1_fee", argTypes: [], resultType: IDL.Nat, args: [] }),
      third,
    ]);
    signal?.throwIfAborted();
    return { owner, metadata: compactMetadata(metadata as Metadata), fee: (fee as bigint).toString(), extra };
  }

  return {
    async readFundingFacts(request: WalletFundingRequest, signal?: AbortSignal): Promise<FundingFacts> {
      const { extra, ...facts } = await read(request.ledger, request.route, signal);
      const allowance = extra as Allowance | null;
      return { ...facts, allowance: allowance === null ? null : {
        allowance: allowance.allowance.toString(), expires_at: allowance.expires_at[0]?.toString() ?? null,
      } };
    },
    async readTokenFacts(ledger: string, signal?: AbortSignal): Promise<TokenFacts> {
      const { extra, ...facts } = await read(ledger, null, signal);
      return { ...facts, balance: (extra as bigint).toString() };
    },
  };
}

function compactMetadata(metadata: Metadata): SelfCallValue {
  return metadata.filter(([key]) => key === "icrc1:name" || key === "icrc1:symbol" || key === "icrc1:decimals")
    .map(([key, value]) => [key, "Nat" in value ? { Nat: value.Nat.toString() }
      : "Int" in value ? { Int: value.Int.toString() }
      : "Text" in value ? { Text: value.Text } : { Blob: value.Blob }]);
}

const reader = createFundingReader();
export const readFundingFacts = reader.readFundingFacts;
export const readTokenFacts = reader.readTokenFacts;
