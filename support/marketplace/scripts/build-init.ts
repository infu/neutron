// All rights reserved. See ../LICENSE.
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { readFile, writeFile } from "node:fs/promises";

const Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
const FeeSchedule = IDL.Record({
  version: IDL.Nat, updateBase: IDL.Nat, updateByte: IDL.Nat,
  storageByteYear: IDL.Nat, purchase: IDL.Nat, withdraw: IDL.Nat,
  grant: IDL.Nat, xrc: IDL.Nat,
});
export const MarketplaceInit = IDL.Record({
  reservations: IDL.Opt(IDL.Vec(IDL.Record({ appId: IDL.Text, publisher: IDL.Principal, title: IDL.Text }))),
  admins: IDL.Vec(IDL.Principal),
  auditors: IDL.Vec(IDL.Principal),
  tokens: IDL.Vec(IDL.Record({
    ledger: IDL.Principal, symbol: IDL.Text, decimals: IDL.Nat8,
    fee: IDL.Nat, rateSymbol: IDL.Text, burnAccount: IDL.Opt(Account),
  })),
  xrc: IDL.Principal,
  fees: FeeSchedule,
  referralTerms: IDL.Record({
    version: IDL.Nat, discountBps: IDL.Nat, affiliateBps: IDL.Nat, developerBps: IDL.Nat,
  }),
});

function record(value: unknown, label: string, fields: readonly string[], optionalFields: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.some((key) => !fields.includes(key) && !optionalFields.includes(key)) || fields.some((key) => !Object.hasOwn(object, key))) {
    throw new Error(`${label} must contain exactly: ${fields.join(", ")}`);
  }
  return object;
}

function natural(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string`);
  }
  return BigInt(value);
}

function principal(value: unknown, label: string): Principal {
  if (typeof value !== "string") throw new Error(`${label} must be principal text`);
  try {
    return Principal.fromText(value);
  } catch {
    throw new Error(`${label} must be valid principal text; replace the example placeholder`);
  }
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be nonempty text`);
  return value;
}

export function encodeMarketplaceInit(input: unknown): Uint8Array {
  const config = record(input, "init", ["admins", "auditors", "tokens", "xrc", "fees", "referralTerms"], ["reservations"]);
  const reserved = new Map<string, string>();
  const reservations = config.reservations == null ? [] : [list(config.reservations, "reservations").map((item, index) => {
    const label = `reservations[${index}]`;
    const row = record(item, label, ["appId", "publisher", "title"]);
    const appId = text(row.appId, `${label}.appId`);
    if (appId.length < 4 || appId.length > 30 || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(appId)) {
      throw new Error(`${label}.appId must use the existing 4–30 character Neutron app ID format`);
    }
    const publisher = principal(row.publisher, `${label}.publisher`);
    const bytes = publisher.toUint8Array();
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 1) throw new Error(`${label}.publisher must be a Neutron canister principal`);
    const title = text(row.title, `${label}.title`);
    if (title.trim().length === 0) throw new Error(`${label}.title must be nonempty text`);
    const previous = reserved.get(appId);
    if (previous !== undefined && previous !== publisher.toText()) throw new Error(`Reservation ${appId} has conflicting publishers`);
    reserved.set(appId, publisher.toText());
    return { appId, publisher, title };
  })];
  const admins = list(config.admins, "admins").map((value) => principal(value, "admin"));
  // Administrative writes are sent by the configured Neutron canister, not
  // directly by its browser or the CLI identity used to install this protocol.
  if (admins.length === 0 || admins.some((value) => {
    const bytes = value.toUint8Array();
    return bytes.length === 0 || bytes[bytes.length - 1] !== 1;
  })) {
    throw new Error("At least one admin Neutron canister principal is required; browser and CLI identities cannot perform these administrative updates");
  }
  const auditors = list(config.auditors, "auditors").map((value) => principal(value, "auditor"));
  if (auditors.some((value) => value.isAnonymous())) throw new Error("Auditors must not be anonymous");
  const tokens = list(config.tokens, "tokens").map((input, index) => {
    const label = `tokens[${index}]`;
    const token = record(input, label, ["ledger", "symbol", "decimals", "fee", "rateSymbol", "burnAccount"]);
    if (!Number.isInteger(token.decimals) || Number(token.decimals) < 0 || Number(token.decimals) > 255) {
      throw new Error(`${label}.decimals must be an integer within Nat8`);
    }
    let burnAccount: [] | [{ owner: Principal; subaccount: [] | [Uint8Array] }] = [];
    if (token.burnAccount !== null) {
      const account = record(token.burnAccount, `${label}.burnAccount`, ["owner", "subaccountHex"]);
      let subaccount: [] | [Uint8Array] = [];
      if (account.subaccountHex !== null) {
        if (typeof account.subaccountHex !== "string" || !/^[0-9a-fA-F]{64}$/u.test(account.subaccountHex)) {
          throw new Error(`${label}.burnAccount.subaccountHex must be null or exactly 32 bytes of hex`);
        }
        subaccount = [Uint8Array.from(Buffer.from(account.subaccountHex, "hex"))];
      }
      burnAccount = [{ owner: principal(account.owner, `${label}.burnAccount.owner`), subaccount }];
    }
    return {
      ledger: principal(token.ledger, `${label}.ledger`),
      symbol: text(token.symbol, `${label}.symbol`),
      decimals: Number(token.decimals), fee: natural(token.fee, `${label}.fee`),
      rateSymbol: text(token.rateSymbol, `${label}.rateSymbol`), burnAccount,
    };
  });
  const feeKeys = ["version", "updateBase", "updateByte", "storageByteYear", "purchase", "withdraw", "grant", "xrc"];
  const feeInput = record(config.fees, "fees", feeKeys);
  const fees = Object.fromEntries(feeKeys.map((key) => {
    const value = natural(feeInput[key], `fees.${key}`);
    if (value === 0n) throw new Error(`fees.${key} must be positive`);
    return [key, value];
  }));
  const termKeys = ["version", "discountBps", "affiliateBps", "developerBps"];
  const termInput = record(config.referralTerms, "referralTerms", termKeys);
  const referralTerms = Object.fromEntries(termKeys.map((key) => [key, natural(termInput[key], `referralTerms.${key}`)]));
  return new Uint8Array(IDL.encode([MarketplaceInit], [{
    admins, auditors, tokens, xrc: principal(config.xrc, "xrc"), fees, referralTerms, reservations,
  }]));
}

if (import.meta.main) {
  async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let input: string | undefined;
    let output: string | undefined;
    for (let i = 0; i < args.length; i += 1) {
      const flag = args[i];
      if (flag !== "--input" && flag !== "--output") throw new Error(`Unknown init argument: ${flag}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`A value is required for ${flag}`);
      if (flag === "--input") input = value;
      else output = value;
    }
    if (!input || !output) throw new Error("Usage: build-init.ts --input init.json --output init.bin");
    const bytes = encodeMarketplaceInit(JSON.parse(await readFile(input, "utf8")));
    await writeFile(output, bytes, { flag: "wx" });
    console.log(`Wrote binary Candid init arguments to ${output}`);
  }
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
