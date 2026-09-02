import {
  isJsonObject,
  loadNeutronCanisterId,
  querySelf,
  updateSelf,
  type SelfCallObject,
  type SelfCallValue,
} from "neutron-tools/app";
import {
  decodeIcrcAccount,
  encodeIcrcAccount,
} from "neutron-tools/src/icrc_account.js";
import {
  normalizeAddressLabel,
  normalizeContactName,
  normalizeDestination,
  validateNotes,
  type DestinationInput,
} from "./address.ts";
import {
  isContactKind,
  isNetwork,
  type Contact,
  type ContactAddress,
  type ContactAddressDraft,
  type ContactDestination,
  type ContactKind,
  type Destination,
  type Network,
  type ResolvePage,
  type SaveContactInput,
  type SaveContactResult,
  type SearchPage,
} from "./model.ts";

export async function getContactsRevision(): Promise<string> {
  const result = requiredObject(
    await querySelf<SelfCallValue>("contacts_revision", [null]),
    "contacts revision",
  );
  return requiredNat(result.revision, "contacts revision");
}

export async function searchContacts(input: {
  query?: string;
  kind?: ContactKind | null;
  network?: Network | null;
  offset?: string;
  limit?: number;
} = {}): Promise<SearchPage> {
  const query = input.query?.trim() ?? "";
  if ([...query].length > 120) throw new Error("Search is longer than 120 characters");
  const result = await querySelf<SelfCallValue>("contacts_search", [
    {
      search_text: query,
      ...(input.kind ? { kind: kindVariant(input.kind) } : {}),
      ...(input.network
        ? { destination_kind: networkVariant(input.network) }
        : {}),
      offset: natural(input.offset ?? "0", "offset"),
      limit: boundedLimit(input.limit),
    },
  ]);
  return parseSearchPage(result);
}

export async function getContact(id: string): Promise<Contact | null> {
  const result = await querySelf<SelfCallValue>("contacts_get", [
    { id: natural(id, "contact id") },
  ]);
  return result === null ? null : parseContact(result);
}

export async function resolveContacts(input: {
  contactId?: string | null;
  query?: string;
  networks: Network[];
  offset?: string;
  limit?: number;
}): Promise<ResolvePage> {
  if (input.networks.length === 0) {
    throw new Error("Choose at least one destination network");
  }
  const networks = [...new Set(input.networks)];
  if (networks.length !== input.networks.length || networks.some((item) => !isNetwork(item))) {
    throw new Error("Destination networks are invalid");
  }
  const result = await querySelf<SelfCallValue>("contacts_resolve", [
    {
      ...(input.contactId
        ? { contact_id: natural(input.contactId, "contact id") }
        : {}),
      search_text: input.query?.trim() ?? "",
      destination_kinds: networks.map(networkVariant),
      offset: natural(input.offset ?? "0", "offset"),
      limit: boundedLimit(input.limit),
    },
  ]);
  return parseResolvePage(result);
}

export async function saveContact(
  input: SaveContactInput,
): Promise<SaveContactResult> {
  if (!isContactKind(input.kind)) throw new Error("Contact kind is invalid");
  const selfCanister = input.addresses?.some(
    (address) => address.destination.network === "neutron",
  )
    ? await loadNeutronCanisterId()
    : null;
  const addresses = normalizeDraftAddresses(input.addresses ?? [], selfCanister);
  const result = await updateSelf<SelfCallValue>("contacts_save", [
    {
      ...(input.id ? { id: natural(input.id, "contact id") } : {}),
      ...(input.expectedRevision
        ? {
            expected_revision: natural(
              input.expectedRevision,
              "expected revision",
            ),
          }
        : {}),
      kind: kindVariant(input.kind),
      name: normalizeContactName(input.name),
      notes: validateNotes(input.notes ?? ""),
      addresses: addresses.map(encodeAddress),
    },
  ]);
  const value = requiredObject(result, "save result");
  if (!Array.isArray(value.duplicate_contact_ids)) {
    throw new Error("Invalid duplicate contact list");
  }
  return {
    revision: requiredNat(value.book_revision, "book revision"),
    contact: parseContact(value.contact),
    duplicateContactIds: value.duplicate_contact_ids.map((id) =>
      requiredNat(id, "duplicate contact id"),
    ),
  };
}

export async function removeContact(input: {
  id: string;
  expectedRevision: string;
}): Promise<{ id: string; revision: string }> {
  const result = await updateSelf<SelfCallValue>("contacts_remove", [
    {
      id: natural(input.id, "contact id"),
      expected_revision: natural(input.expectedRevision, "expected revision"),
    },
  ]);
  const value = requiredObject(result, "remove result");
  return {
    id: requiredNat(value.id, "contact id"),
    revision: requiredNat(value.book_revision, "book revision"),
  };
}

export function normalizeDraftAddresses(
  addresses: ContactAddressDraft[],
  selfCanister?: string | null,
): ContactAddressDraft[] {
  if (addresses.length > 20) throw new Error("A contact can have at most 20 addresses");
  const destinations = new Set<string>();
  const preferred = new Set<Network>();
  let neutronAddresses = 0;
  return addresses.map((address) => {
    const destination = normalizeDestination(
      address.destination as DestinationInput,
      selfCanister,
    );
    const key = destinationKey(destination);
    if (destinations.has(key)) throw new Error("The contact contains a duplicate destination");
    destinations.add(key);
    if (destination.network === "neutron") {
      neutronAddresses += 1;
      if (neutronAddresses > 1) {
        throw new Error("A contact can have only one Neutron address");
      }
      if (address.preferred) {
        throw new Error("A Neutron address is not a preferred payment destination");
      }
    }
    if (address.preferred) {
      if (preferred.has(destination.network)) {
        throw new Error(`Only one preferred ${destination.network} address is allowed`);
      }
      preferred.add(destination.network);
    }
    return {
      id: address.id ? natural(address.id, "address id") : null,
      label: normalizeAddressLabel(address.label),
      destination,
      preferred: address.preferred,
    };
  });
}

export function destinationText(destination: Destination): string {
  if (destination.network === "neutron") {
    return destination.principal;
  }
  if (destination.network === "internet_computer") {
    return destination.account;
  }
  return destination.address;
}

function parseSearchPage(value: unknown): SearchPage {
  const record = requiredObject(value, "contacts search page");
  if (!Array.isArray(record.contacts)) throw new Error("Invalid contacts search page");
  return {
    revision: requiredNat(record.book_revision, "book revision"),
    contacts: record.contacts.map((item) => {
      const summary = requiredObject(item, "contact summary");
      if (!Array.isArray(summary.destination_kinds)) {
        throw new Error("Invalid contact networks");
      }
      return {
        id: requiredNat(summary.id, "contact id"),
        revision: requiredNat(summary.revision, "contact revision"),
        kind: parseKind(summary.kind),
        name: requiredString(summary.name, "contact name"),
        addressCount: requiredNat(summary.address_count, "address count"),
        networks: summary.destination_kinds.map(parseNetworkVariant),
        updatedAt: requiredInt(summary.updated_at, "updated time"),
      };
    }),
    total: requiredNat(record.total, "total contacts"),
    nextOffset: optionalNat(record.next_offset, "next offset"),
  };
}

function parseResolvePage(value: unknown): ResolvePage {
  const record = requiredObject(value, "contacts resolve page");
  if (!Array.isArray(record.destinations)) {
    throw new Error("Invalid contacts resolve page");
  }
  return {
    revision: requiredNat(record.book_revision, "book revision"),
    destinations: record.destinations.map(parseContactDestination),
    total: requiredNat(record.total, "total destinations"),
    nextOffset: optionalNat(record.next_offset, "next offset"),
  };
}

function parseContactDestination(value: unknown): ContactDestination {
  const record = requiredObject(value, "contact destination");
  return {
    contactId: requiredNat(record.contact_id, "contact id"),
    contactRevision: requiredNat(record.contact_revision, "contact revision"),
    contactKind: parseKind(record.contact_kind),
    contactName: requiredString(record.contact_name, "contact name"),
    address: parseAddress(record.address),
  };
}

function parseContact(value: unknown): Contact {
  const record = requiredObject(value, "contact");
  if (!Array.isArray(record.addresses)) throw new Error("Invalid contact addresses");
  return {
    id: requiredNat(record.id, "contact id"),
    revision: requiredNat(record.revision, "contact revision"),
    kind: parseKind(record.kind),
    name: requiredString(record.name, "contact name"),
    notes: requiredString(record.notes, "contact notes", true),
    addresses: record.addresses.map(parseAddress),
    createdAt: requiredInt(record.created_at, "created time"),
    updatedAt: requiredInt(record.updated_at, "updated time"),
  };
}

function parseAddress(value: unknown): ContactAddress {
  const record = requiredObject(value, "contact address");
  if (typeof record.preferred !== "boolean") throw new Error("Invalid preferred flag");
  return {
    id: requiredNat(record.id, "address id"),
    label: optionalString(record.address_label, "address label"),
    destination: parseDestination(record.destination),
    preferred: record.preferred,
  };
}

export function parseDestination(value: unknown): Destination {
  const [network, payload] = variant(value, "contact destination");
  if (!isNetwork(network)) throw new Error("Unknown contact network");
  if (network === "neutron") {
    return normalizeDestination({
      network,
      principal: requiredString(payload, "Neutron principal"),
    });
  }
  if (network === "internet_computer") {
    return normalizeDestination({
      network,
      account: parseIcrcAccount(payload),
    });
  }
  return normalizeDestination({
    network,
    address: requiredString(payload, `${network} address`),
  });
}

function encodeAddress(address: ContactAddressDraft): SelfCallObject {
  return {
    ...(address.id ? { id: address.id } : {}),
    ...(address.label !== null ? { address_label: address.label } : {}),
    preferred: address.preferred,
    destination: encodeDestination(address.destination),
  };
}

export function encodeDestination(destination: Destination): SelfCallObject {
  if (destination.network === "neutron") {
    return { neutron: destination.principal };
  }
  if (destination.network === "internet_computer") {
    const account = decodeIcrcAccount(destination.account);
    return {
      internet_computer: {
        owner: account.owner.toText(),
        subaccount:
          account.subaccount === undefined
            ? null
            : Uint8Array.from(account.subaccount),
      },
    };
  }
  return { [destination.network]: destination.address };
}

function parseIcrcAccount(value: unknown): string {
  const record = requiredObject(value, "IC account");
  const hasSubaccount = Object.prototype.hasOwnProperty.call(
    record,
    "subaccount",
  );
  assertExactKeys(
    record,
    hasSubaccount ? ["owner", "subaccount"] : ["owner"],
    "IC account",
  );
  const ownerText = requiredString(record.owner, "IC account owner");

  let owner;
  try {
    owner = decodeIcrcAccount(ownerText);
  } catch {
    throw new Error("Invalid IC account owner");
  }
  if (
    owner.subaccount !== undefined ||
    owner.owner.toText() !== ownerText
  ) {
    throw new Error("Invalid IC account owner");
  }

  const rawSubaccount = record.subaccount;
  if (
    hasSubaccount &&
    rawSubaccount !== null &&
    !(rawSubaccount instanceof Uint8Array)
  ) {
    throw new Error("Invalid IC account subaccount");
  }
  if (
    rawSubaccount instanceof Uint8Array &&
    rawSubaccount.byteLength !== 32
  ) {
    throw new Error("Invalid IC account subaccount");
  }
  const subaccount =
    rawSubaccount instanceof Uint8Array
      ? Uint8Array.from(rawSubaccount)
      : undefined;
  return encodeIcrcAccount({
    owner: owner.owner,
    ...(subaccount === undefined ? {} : { subaccount }),
  });
}

function destinationKey(destination: Destination): string {
  return `${destination.network}:${destinationText(destination)}`;
}

function parseKind(value: unknown): ContactKind {
  const [tag] = variant(value, "contact kind");
  if (!isContactKind(tag)) throw new Error("Unknown contact kind");
  return tag;
}

function parseNetworkVariant(value: unknown): Network {
  const [tag] = variant(value, "destination kind");
  if (!isNetwork(tag)) throw new Error("Unknown destination kind");
  return tag;
}

function kindVariant(value: ContactKind): SelfCallObject {
  return { [value]: null };
}

function networkVariant(value: Network): SelfCallObject {
  return { [value]: null };
}

function variant(value: unknown, label: string): [string, unknown] {
  const record = requiredObject(value, label);
  const entries = Object.entries(record);
  if (entries.length !== 1) throw new Error(`Invalid ${label}`);
  return entries[0]!;
}

function optionalString(value: unknown, label: string): string | null {
  return value === undefined || value === null
    ? null
    : requiredString(value, label, true);
}

function optionalNat(value: unknown, label: string): string | null {
  return value === undefined || value === null
    ? null
    : requiredNat(value, label);
}

function requiredObject(value: unknown, label: string): SelfCallObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value as SelfCallObject;
}

function assertExactKeys(
  value: SelfCallObject,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function requiredString(value: unknown, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requiredNat(value: unknown, label: string): string {
  const parsed = requiredInteger(value, label);
  if (parsed < 0n) throw new Error(`Invalid ${label}`);
  return parsed.toString();
}

function requiredInt(value: unknown, label: string): string {
  return requiredInteger(value, label).toString();
}

function requiredInteger(value: unknown, label: string): bigint {
  if (
    (typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "bigint") ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    throw new Error(`Invalid ${label}`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function natural(value: string, label: string): string {
  return requiredNat(value, label);
}

function boundedLimit(value = 50): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error("Limit must be between 1 and 50");
  }
  return value.toString();
}
