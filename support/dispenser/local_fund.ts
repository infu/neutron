import {
  Actor,
  AnonymousIdentity,
  HttpAgent,
  type ActorMethod,
} from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { AccountIdentifier } from "@icp-sdk/canisters/ledger/icp";
import { readFile } from "node:fs/promises";
import path from "node:path";

const dispenserRoot = import.meta.dir;
const repositoryRoot = path.resolve(dispenserRoot, "../..");
const sessionPath = path.join(repositoryRoot, "local.ndeploy.session.json");
const ledgerCanisterId = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const transferAmountE8s = 200_000_000n;
const transferFeeE8s = 10_000n;

const account = process.argv[2]?.trim().toLowerCase();
if (account === undefined || !/^[a-f0-9]{64}$/u.test(account)) {
  throw new Error(
    "Usage: npm --workspace dispenser run local:fund -- <64-character ICP account>",
  );
}
const accountBytes = AccountIdentifier.fromHex(account).toUint8Array();

const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
  runtime?: {
    kind?: unknown;
    gateway?: { url?: unknown };
    rootKeyBase64?: unknown;
  };
};
if (
  session.runtime?.kind !== "pocketic" ||
  typeof session.runtime.gateway?.url !== "string" ||
  typeof session.runtime.rootKeyBase64 !== "string"
) {
  throw new Error("The repository does not have a usable PocketIC session");
}

const agent = await HttpAgent.create({
  host: session.runtime.gateway.url,
  identity: new AnonymousIdentity(),
  verifyQuerySignatures: false,
});
const rootKey = await agent.fetchRootKey();
if (
  Buffer.from(rootKey).toString("base64") !==
  session.runtime.rootKeyBase64
) {
  throw new Error(
    "PocketIC gateway root key does not match the supervised local session",
  );
}
const ledger = Actor.createActor<LocalLedgerActor>(ledgerIdl, {
  agent,
  canisterId: ledgerCanisterId,
});
const result = await ledger.transfer({
  memo: 0n,
  amount: { e8s: transferAmountE8s },
  fee: { e8s: transferFeeE8s },
  from_subaccount: [],
  to: accountBytes,
  created_at_time: [],
});
if ("Err" in result) {
  throw new Error(
    `Local ICP transfer failed: ${JSON.stringify(
      result.Err,
      (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
    )}`,
  );
}
const balance = await ledger.account_balance({ account: accountBytes });
console.log(
  `Funded ${account} with 2 local test ICP (block ${result.Ok}, balance ${formatIcp(balance.e8s)} ICP)`,
);

type Tokens = { e8s: bigint };
type LocalLedgerActor = {
  transfer: ActorMethod<
    [
      {
        memo: bigint;
        amount: Tokens;
        fee: Tokens;
        from_subaccount: [] | [Uint8Array];
        to: Uint8Array;
        created_at_time: [] | [{ timestamp_nanos: bigint }];
      },
    ],
    | { Ok: bigint }
    | {
        Err:
          | { BadFee: { expected_fee: Tokens } }
          | { InsufficientFunds: { balance: Tokens } }
          | { TxTooOld: { allowed_window_nanos: bigint } }
          | { TxCreatedInFuture: null }
          | { TxDuplicate: { duplicate_of: bigint } };
      }
  >;
  account_balance: ActorMethod<[{ account: Uint8Array }], Tokens>;
};

function ledgerIdl({
  IDL: candid,
}: Parameters<IDL.InterfaceFactory>[0]): ReturnType<IDL.InterfaceFactory> {
  const tokens = candid.Record({ e8s: candid.Nat64 });
  const transferError = candid.Variant({
    BadFee: candid.Record({ expected_fee: tokens }),
    InsufficientFunds: candid.Record({ balance: tokens }),
    TxTooOld: candid.Record({ allowed_window_nanos: candid.Nat64 }),
    TxCreatedInFuture: candid.Null,
    TxDuplicate: candid.Record({ duplicate_of: candid.Nat64 }),
  });
  return candid.Service({
    transfer: candid.Func(
      [
        candid.Record({
          memo: candid.Nat64,
          amount: tokens,
          fee: tokens,
          from_subaccount: candid.Opt(candid.Vec(candid.Nat8)),
          to: candid.Vec(candid.Nat8),
          created_at_time: candid.Opt(
            candid.Record({ timestamp_nanos: candid.Nat64 }),
          ),
        }),
      ],
      [candid.Variant({ Ok: candid.Nat64, Err: transferError })],
      [],
    ),
    account_balance: candid.Func(
      [candid.Record({ account: candid.Vec(candid.Nat8) })],
      [tokens],
      ["query"],
    ),
  });
}

function formatIcp(e8s: bigint): string {
  const whole = e8s / 100_000_000n;
  const fraction = (e8s % 100_000_000n)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
