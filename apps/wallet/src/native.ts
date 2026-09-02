import { Actor, HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import {
  decodeIcrcAccount,
  encodeIcrcAccount,
} from "neutron-tools/src/icrc_account.js";
import { icHost } from "neutron-tools/src/runtime.js";
import type { CatalogNativeRoute } from "./catalog.ts";
import { bytesToHex } from "./icrc_account.ts";

type EthereumMinterInfo = {
  minter_address: [] | [string];
  deposit_with_subaccount_helper_contract_address: [] | [string];
  eth_helper_contract_address: [] | [string];
  erc20_helper_contract_address: [] | [string];
  smart_contract_address: [] | [string];
  supported_ckerc20_tokens:
    | []
    | [
        Array<{
          ckerc20_token_symbol: string;
          erc20_contract_address: string;
          ledger_canister_id: Principal;
        }>,
      ];
};

type EthereumMinter = {
  get_minter_info(): Promise<EthereumMinterInfo>;
};

type SolanaMinter = {
  get_deposit_address(args: {
    owner: [] | [Principal];
    subaccount: [];
  }): Promise<string>;
};

export type PublicNativeDeposit = {
  address: string;
  kind: "address" | "contract";
  helperMode: "subaccount" | "legacy" | null;
  minterAddress: string | null;
  tokenContract: string | null;
};

const agents = new Map<string, Promise<HttpAgent>>();

export function icrcDepositAddress(owner: string): string {
  return encodeIcrcAccount(decodeIcrcAccount(owner));
}

export function ethereumPrincipalWord(owner: string): string {
  const bytes = Principal.fromText(owner).toUint8Array();
  if (bytes.length > 29) throw new Error("Principal is too long for Ethereum");
  const word = new Uint8Array(32);
  word[0] = bytes.length;
  word.set(bytes, 1);
  return `0x${bytesToHex(word)}`;
}

export function defaultSubaccountWord(): string {
  return `0x${"00".repeat(32)}`;
}

export async function queryPublicNativeDeposit({
  ledger,
  owner,
  route,
  href = window.location.href,
}: {
  ledger: string;
  owner: string;
  route: CatalogNativeRoute;
  href?: string;
}): Promise<PublicNativeDeposit | null> {
  if (route.kind === "cketh" || route.kind === "ckerc20") {
    const agent = await queryAgent(href);
    const minter = Actor.createActor<EthereumMinter>(ckethMinterIdl, {
      agent,
      canisterId: route.minter,
    });
    const info = await minter.get_minter_info();
    const modern = first(info.deposit_with_subaccount_helper_contract_address);
    const legacy =
      (route.kind === "ckerc20"
        ? first(info.erc20_helper_contract_address)
        : first(info.eth_helper_contract_address)) ??
      first(info.smart_contract_address);
    const address = modern ?? legacy;
    if (!address) throw new Error("The ckETH minter has no deposit contract");

    let tokenContract: string | null = null;
    if (route.kind === "ckerc20") {
      const supported = first(info.supported_ckerc20_tokens) ?? [];
      const token = supported.find(
        (candidate) => candidate.ledger_canister_id.toText() === ledger,
      );
      if (!token) {
        throw new Error("This token is not supported by the current ckETH minter");
      }
      tokenContract = token.erc20_contract_address;
    }
    return {
      address,
      kind: "contract",
      helperMode: modern ? "subaccount" : "legacy",
      minterAddress: first(info.minter_address),
      tokenContract,
    };
  }

  if (route.kind === "cksol") {
    const agent = await queryAgent(href);
    const minter = Actor.createActor<SolanaMinter>(cksolMinterIdl, {
      agent,
      canisterId: route.minter,
    });
    const address = await minter.get_deposit_address({
      owner: [Principal.fromText(owner)],
      subaccount: [],
    });
    if (!address) throw new Error("The ckSOL minter returned no deposit address");
    return {
      address,
      kind: "address",
      helperMode: null,
      minterAddress: null,
      tokenContract: null,
    };
  }

  return null;
}

export function queryTransport(href: string): { host: string; local: boolean } {
  const url = new URL(href);
  const local =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1";
  const localHost = `${url.protocol}//localhost${url.port ? `:${url.port}` : ""}`;
  return {
    host: icHost({ local, ...(local ? { localHost } : {}) }),
    local,
  };
}

async function queryAgent(href: string): Promise<HttpAgent> {
  const transport = queryTransport(href);
  let pending = agents.get(transport.host);
  if (!pending) {
    pending = createAgent(transport);
    agents.set(transport.host, pending);
  }
  return pending;
}

async function createAgent({
  host,
  local,
}: {
  host: string;
  local: boolean;
}): Promise<HttpAgent> {
  const agent = await HttpAgent.create({ host });
  if (local) await agent.fetchRootKey();
  return agent;
}

const ckethMinterIdl: Parameters<typeof Actor.createActor>[0] = ({ IDL }) => {
  const token = IDL.Record({
    ckerc20_token_symbol: IDL.Text,
    erc20_contract_address: IDL.Text,
    ledger_canister_id: IDL.Principal,
  });
  const info = IDL.Record({
    minter_address: IDL.Opt(IDL.Text),
    deposit_with_subaccount_helper_contract_address: IDL.Opt(IDL.Text),
    eth_helper_contract_address: IDL.Opt(IDL.Text),
    erc20_helper_contract_address: IDL.Opt(IDL.Text),
    smart_contract_address: IDL.Opt(IDL.Text),
    supported_ckerc20_tokens: IDL.Opt(IDL.Vec(token)),
  });
  return IDL.Service({
    get_minter_info: IDL.Func([], [info], ["query"]),
  });
};

const cksolMinterIdl: Parameters<typeof Actor.createActor>[0] = ({ IDL }) => {
  const account = IDL.Record({
    owner: IDL.Opt(IDL.Principal),
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  return IDL.Service({
    get_deposit_address: IDL.Func([account], [IDL.Text], ["query"]),
  });
};

function first<T>(value: [] | [T]): T | null {
  return value.length === 1 ? value[0] : null;
}
