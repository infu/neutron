import {
  callTool,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import {
  isContactKind,
  isNetwork,
  type Contact,
  type ContactAddress,
  type ContactDestination,
  type ContactSummary,
  type ResolvePage,
  type SaveContactInput,
  type SaveContactResult,
  type SearchPage,
} from "./model.ts";

export class ContactsClient {
  constructor(private readonly target: MsgBusEndpointId) {}

  async search(args: JsonObject): Promise<SearchPage> {
    return parseSearchPage(await this.call("search", args));
  }

  async get(id: string, includeNotes = true): Promise<Contact | null> {
    const value = await this.call("get", { id, includeNotes });
    return value === null ? null : parseContact(value);
  }

  async resolve(args: JsonObject): Promise<ResolvePage> {
    return parseResolvePage(await this.call("resolve", args));
  }

  async save(input: SaveContactInput): Promise<SaveContactResult> {
    return parseSaveResult(await this.call("save", input as JsonObject));
  }

  async remove(id: string, expectedRevision: string) {
    const record = object(await this.call("remove", { id, expectedRevision }), "remove result");
    return {
      id: decimal(record.id, "contact id"),
      revision: decimal(record.revision, "book revision"),
    };
  }

  private call(name: string, arguments_: JsonObject): Promise<JsonValue> {
    return callTool({ target: this.target, name, arguments: arguments_ }, 60);
  }
}

function parseSearchPage(value: JsonValue): SearchPage {
  const record = object(value, "search page");
  if (!Array.isArray(record.contacts)) throw new Error("Invalid contact list");
  return {
    revision: decimal(record.revision, "book revision"),
    contacts: record.contacts.map(parseSummary),
    total: decimal(record.total, "contact total"),
    nextOffset: nullableDecimal(record.nextOffset, "next offset"),
  };
}

function parseResolvePage(value: JsonValue): ResolvePage {
  const record = object(value, "resolve page");
  if (!Array.isArray(record.destinations)) throw new Error("Invalid destination list");
  return {
    revision: decimal(record.revision, "book revision"),
    destinations: record.destinations.map(parseCandidate),
    total: decimal(record.total, "destination total"),
    nextOffset: nullableDecimal(record.nextOffset, "next offset"),
  };
}

function parseSaveResult(value: JsonValue): SaveContactResult {
  const record = object(value, "save result");
  if (!Array.isArray(record.duplicateContactIds)) {
    throw new Error("Invalid duplicate destination result");
  }
  return {
    revision: decimal(record.revision, "book revision"),
    contact: parseContact(record.contact),
    duplicateContactIds: record.duplicateContactIds.map((id) =>
      decimal(id, "duplicate contact id"),
    ),
  };
}

function parseSummary(value: JsonValue): ContactSummary {
  const record = object(value, "contact summary");
  if (!Array.isArray(record.networks) || !record.networks.every(isNetwork)) {
    throw new Error("Invalid contact networks");
  }
  return {
    id: decimal(record.id, "contact id"),
    revision: decimal(record.revision, "contact revision"),
    kind: kind(record.kind),
    name: string(record.name, "contact name"),
    addressCount: decimal(record.addressCount, "address count"),
    networks: record.networks,
    updatedAt: integer(record.updatedAt, "updated time"),
  };
}

function parseContact(value: JsonValue | undefined): Contact {
  const record = object(value, "contact");
  if (!Array.isArray(record.addresses)) throw new Error("Invalid contact addresses");
  return {
    id: decimal(record.id, "contact id"),
    revision: decimal(record.revision, "contact revision"),
    kind: kind(record.kind),
    name: string(record.name, "contact name"),
    notes: string(record.notes, "contact notes", true),
    addresses: record.addresses.map(parseAddress),
    createdAt: integer(record.createdAt, "created time"),
    updatedAt: integer(record.updatedAt, "updated time"),
  };
}

function parseCandidate(value: JsonValue): ContactDestination {
  const record = object(value, "contact destination");
  return {
    contactId: decimal(record.contactId, "contact id"),
    contactRevision: decimal(record.contactRevision, "contact revision"),
    contactKind: kind(record.contactKind),
    contactName: string(record.contactName, "contact name"),
    address: parseAddress(record.address),
  };
}

function parseAddress(value: JsonValue | undefined): ContactAddress {
  const record = object(value, "contact address");
  const destination = object(record.destination, "contact destination");
  if (!isNetwork(destination.network)) throw new Error("Invalid destination network");
  if (typeof record.preferred !== "boolean") throw new Error("Invalid preferred flag");
  return {
    id: decimal(record.id, "address id"),
    label: nullableString(record.label, "address label"),
    preferred: record.preferred,
    destination:
      destination.network === "neutron"
        ? {
            network: destination.network,
            principal: string(destination.principal, "Neutron principal"),
          }
        : destination.network === "internet_computer"
        ? {
            network: destination.network,
            account: string(destination.account, "ICRC account"),
          }
        : {
            network: destination.network,
            address: string(destination.address, "address"),
          },
  };
}

function object(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function kind(value: unknown) {
  if (!isContactKind(value)) throw new Error("Invalid contact kind");
  return value;
}

function string(value: unknown, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label, true);
}

function decimal(value: unknown, label: string): string {
  const parsed = integerBigInt(value, label);
  if (parsed < 0n) throw new Error(`Invalid ${label}`);
  return parsed.toString();
}

function nullableDecimal(value: unknown, label: string): string | null {
  return value === null ? null : decimal(value, label);
}

function integer(value: unknown, label: string): string {
  return integerBigInt(value, label).toString();
}

function integerBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^-?[0-9]+$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return BigInt(value);
}
