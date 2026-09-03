import {
  isJsonObject,
  type JsonObject,
  type SelfCallObject,
} from "neutron-tools/app";
import {
  candidIcrcAccountFromText,
  parseCandidIcrcAccount,
} from "./icrc_account.ts";

export type ContactKind = "person" | "self";
export type DestinationNetwork =
  | "internet_computer"
  | "bitcoin_mainnet"
  | "dogecoin_mainnet"
  | "ethereum_mainnet"
  | "solana_mainnet";

export type WalletDestination =
  | {
      network: "internet_computer";
      account: string;
    }
  | {
      network: Exclude<DestinationNetwork, "internet_computer">;
      address: string;
    };

export type WalletContactDestination = {
  contactId: string;
  contactRevision: string;
  contactKind: ContactKind;
  contactName: string;
  addressId: string;
  label: string | null;
  preferred: boolean;
  destination: WalletDestination;
  route: "icrc" | "native";
};

export type WalletContactDestinationsPage = {
  ledger: string;
  revision: string;
  destinations: WalletContactDestination[];
  total: string;
  nextOffset: string | null;
};

export const destinationLabels: Record<DestinationNetwork, string> = {
  internet_computer: "Internet Computer",
  bitcoin_mainnet: "Bitcoin",
  dogecoin_mainnet: "Dogecoin",
  ethereum_mainnet: "Ethereum",
  solana_mainnet: "Solana",
};

export function parseWalletContactDestinations(
  value: unknown,
): WalletContactDestinationsPage {
  const record = requiredObject(value, "wallet destination page");
  if (!Array.isArray(record.destinations)) {
    throw new Error("Invalid wallet destination list");
  }
  return {
    ledger: requiredString(record.ledger, "destination ledger"),
    revision: requiredNat(record.book_revision, "contacts revision"),
    destinations: record.destinations.map(parseCandidate),
    total: requiredNat(record.total, "destination total"),
    nextOffset: optionalNat(record.next_offset, "next offset"),
  };
}

export function walletDestinationText(destination: WalletDestination): string {
  if (destination.network === "internet_computer") {
    return destination.account;
  }
  return destination.address;
}

export function walletDestinationVariant(
  destination: WalletDestination,
): SelfCallObject {
  return destination.network === "internet_computer"
    ? {
        internet_computer: candidIcrcAccountFromText(
          destination.account,
          "IC account",
        ),
      }
    : { [destination.network]: destination.address };
}

function parseCandidate(value: unknown): WalletContactDestination {
  const record = requiredObject(value, "wallet contact destination");
  const address = requiredObject(record.address, "contact address");
  if (typeof address.preferred !== "boolean") throw new Error("Invalid preferred flag");
  const [route] = variant(record.route, "wallet route");
  if (route !== "icrc" && route !== "native") throw new Error("Invalid wallet route");
  return {
    contactId: requiredNat(record.contact_id, "contact id"),
    contactRevision: requiredNat(record.contact_revision, "contact revision"),
    contactKind: parseKind(record.contact_kind),
    contactName: requiredString(record.contact_name, "contact name"),
    addressId: requiredNat(address.id, "address id"),
    label: optionalString(address.address_label, "address label"),
    preferred: address.preferred,
    destination: parseDestination(address.destination),
    route,
  };
}

function parseDestination(value: unknown): WalletDestination {
  const [network, payload] = variant(value, "contact destination");
  if (network === "internet_computer") {
    return {
      network,
      account: parseCandidIcrcAccount(payload, "IC account"),
    };
  }
  if (
    network !== "bitcoin_mainnet" &&
    network !== "dogecoin_mainnet" &&
    network !== "ethereum_mainnet" &&
    network !== "solana_mainnet"
  ) {
    throw new Error("Invalid contact destination network");
  }
  return { network, address: requiredString(payload, "contact address") };
}

function parseKind(value: unknown): ContactKind {
  const [kind] = variant(value, "contact kind");
  if (kind !== "person" && kind !== "self") throw new Error("Invalid contact kind");
  return kind;
}

function variant(value: unknown, label: string): [string, unknown] {
  const record = requiredObject(value, label);
  const entries = Object.entries(record);
  if (entries.length !== 1) throw new Error(`Invalid ${label}`);
  return entries[0]!;
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}

function requiredNat(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function optionalNat(value: unknown, label: string): string | null {
  return value === undefined || value === null
    ? null
    : requiredNat(value, label);
}

function optionalString(value: unknown, label: string): string | null {
  return value === undefined || value === null
    ? null
    : requiredString(value, label);
}
