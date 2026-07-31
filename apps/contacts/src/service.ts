import {
  exposeTool,
  isJsonObject,
  isJsonValue,
  publishAppStateChange,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/app";
import {
  getContact,
  removeContact,
  resolveContacts,
  saveContact,
  searchContacts,
} from "./contacts.ts";
import { isContactKind, isNetwork, NETWORKS, type ContactAddressDraft } from "./model.ts";

const STATE_TOPIC = "contacts";

const decimalSchema: JsonObject = {
  type: "string",
  pattern: "^0$|^[1-9][0-9]*$",
};
const nullableDecimalSchema: JsonObject = {
  oneOf: [decimalSchema, { type: "null" }],
};
const networkSchema: JsonObject = { type: "string", enum: [...NETWORKS] };
const kindSchema: JsonObject = { type: "string", enum: ["person", "self"] };
const destinationSchema: JsonObject = {
  oneOf: [
    {
      type: "object",
      required: ["network", "principal"],
      properties: {
        network: { const: "neutron" },
        principal: { type: "string", minLength: 3, maxLength: 63 },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["network", "account"],
      properties: {
        network: { const: "internet_computer" },
        account: { type: "string", minLength: 3, maxLength: 140 },
      },
      additionalProperties: false,
    },
    ...NETWORKS.filter(
      (network) => network !== "internet_computer" && network !== "neutron",
    ).map(
      (network) => ({
        type: "object",
        required: ["network", "address"],
        properties: {
          network: { const: network },
          address: { type: "string", minLength: 1, maxLength: 128 },
        },
        additionalProperties: false,
      }),
    ),
  ],
};
const addressSchema: JsonObject = {
  type: "object",
  required: ["id", "label", "destination", "preferred"],
  properties: {
    id: decimalSchema,
    label: { type: ["string", "null"] },
    destination: destinationSchema,
    preferred: { type: "boolean" },
  },
  additionalProperties: false,
};
const contactSchema: JsonObject = {
  type: "object",
  required: [
    "id",
    "revision",
    "kind",
    "name",
    "notes",
    "addresses",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: decimalSchema,
    revision: decimalSchema,
    kind: kindSchema,
    name: { type: "string" },
    notes: { type: "string" },
    addresses: { type: "array", items: addressSchema, maxItems: 20 },
    createdAt: { type: "string", pattern: "^-?[0-9]+$" },
    updatedAt: { type: "string", pattern: "^-?[0-9]+$" },
  },
  additionalProperties: false,
};
const summarySchema: JsonObject = {
  type: "object",
  required: ["id", "revision", "kind", "name", "addressCount", "networks", "updatedAt"],
  properties: {
    id: decimalSchema,
    revision: decimalSchema,
    kind: kindSchema,
    name: { type: "string" },
    addressCount: decimalSchema,
    networks: { type: "array", items: networkSchema, uniqueItems: true },
    updatedAt: { type: "string", pattern: "^-?[0-9]+$" },
  },
  additionalProperties: false,
};
const candidateSchema: JsonObject = {
  type: "object",
  required: ["contactId", "contactRevision", "contactKind", "contactName", "address"],
  properties: {
    contactId: decimalSchema,
    contactRevision: decimalSchema,
    contactKind: kindSchema,
    contactName: { type: "string" },
    address: addressSchema,
  },
  additionalProperties: false,
};

exposeTool(
  "search",
  {
    title: "Search Contacts",
    description: "Find contacts by name or destination.",
    inputSchema: objectSchema([], {
      query: { type: "string", maxLength: 120 },
      kind: kindSchema,
      network: networkSchema,
      offset: decimalSchema,
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }),
    outputSchema: objectSchema(
      ["revision", "contacts", "total", "nextOffset"],
      {
        revision: decimalSchema,
        contacts: { type: "array", items: summarySchema },
        total: decimalSchema,
        nextOffset: { oneOf: [decimalSchema, { type: "null" }] },
      },
    ),
    annotations: { "neutron:effects": ["read"] },
  },
  async (args) =>
    asJson(
      await searchContacts({
        ...(optionalString(args.query) !== undefined
          ? { query: optionalString(args.query)! }
          : {}),
        ...(optionalKind(args.kind) !== undefined
          ? { kind: optionalKind(args.kind)! }
          : {}),
        ...(optionalNetwork(args.network) !== undefined
          ? { network: optionalNetwork(args.network)! }
          : {}),
        ...(optionalString(args.offset) !== undefined
          ? { offset: optionalString(args.offset)! }
          : {}),
        ...(optionalInteger(args.limit) !== undefined
          ? { limit: optionalInteger(args.limit)! }
          : {}),
      }),
    ),
);

exposeTool(
  "get",
  {
    title: "Get Contact",
    description: "Read one contact by id.",
    inputSchema: objectSchema(["id"], {
      id: decimalSchema,
      includeNotes: { type: "boolean" },
    }),
    outputSchema: { oneOf: [contactSchema, { type: "null" }] },
    annotations: { "neutron:effects": ["read"] },
  },
  async (args) => {
    const contact = await getContact(requiredString(args.id, "id"));
    if (contact && args.includeNotes !== true) contact.notes = "";
    return asJson(contact);
  },
);

exposeTool(
  "resolve",
  {
    title: "Resolve Contact Destinations",
    description: "Find destinations for explicit networks.",
    inputSchema: objectSchema(["networks"], {
      contactId: decimalSchema,
      query: { type: "string", maxLength: 120 },
      networks: {
        type: "array",
        minItems: 1,
        maxItems: NETWORKS.length,
        uniqueItems: true,
        items: networkSchema,
      },
      offset: decimalSchema,
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }),
    outputSchema: objectSchema(
      ["revision", "destinations", "total", "nextOffset"],
      {
        revision: decimalSchema,
        destinations: { type: "array", items: candidateSchema },
        total: decimalSchema,
        nextOffset: { oneOf: [decimalSchema, { type: "null" }] },
      },
    ),
    annotations: { "neutron:effects": ["read"] },
  },
  async (args) =>
    asJson(
      await resolveContacts({
        networks: requiredNetworks(args.networks),
        ...(optionalString(args.contactId) !== undefined
          ? { contactId: optionalString(args.contactId)! }
          : {}),
        ...(optionalString(args.query) !== undefined
          ? { query: optionalString(args.query)! }
          : {}),
        ...(optionalString(args.offset) !== undefined
          ? { offset: optionalString(args.offset)! }
          : {}),
        ...(optionalInteger(args.limit) !== undefined
          ? { limit: optionalInteger(args.limit)! }
          : {}),
      }),
    ),
);

exposeTool(
  "save",
  {
    title: "Save Contact",
    description: "Create or completely replace a contact.",
    inputSchema: objectSchema(["kind", "name", "addresses"], {
      id: nullableDecimalSchema,
      expectedRevision: nullableDecimalSchema,
      kind: kindSchema,
      name: { type: "string", minLength: 1, maxLength: 120 },
      notes: { type: "string", maxLength: 8192 },
      addresses: {
        type: "array",
        maxItems: 20,
        items: objectSchema(["destination", "preferred"], {
          id: nullableDecimalSchema,
          label: { type: ["string", "null"], maxLength: 64 },
          destination: destinationSchema,
          preferred: { type: "boolean" },
        }),
      },
    }),
    outputSchema: objectSchema(
      ["revision", "contact", "duplicateContactIds"],
      {
        revision: decimalSchema,
        contact: contactSchema,
        duplicateContactIds: { type: "array", items: decimalSchema },
      },
    ),
    annotations: { "neutron:effects": ["write"] },
  },
  async (args) => {
    const result = await saveContact({
      kind: requiredKind(args.kind),
      name: requiredString(args.name, "name"),
      notes: optionalString(args.notes) ?? "",
      addresses: requiredAddressDrafts(args.addresses),
      ...(optionalNullableString(args.id) !== null
        ? { id: optionalNullableString(args.id)! }
        : {}),
      ...(optionalNullableString(args.expectedRevision) !== null
        ? { expectedRevision: optionalNullableString(args.expectedRevision)! }
        : {}),
    });
    await publishRevision(result.revision);
    return asJson(result);
  },
);

exposeTool(
  "remove",
  {
    title: "Remove Contact",
    description: "Remove one contact at its current revision.",
    inputSchema: objectSchema(["id", "expectedRevision"], {
      id: decimalSchema,
      expectedRevision: decimalSchema,
    }),
    outputSchema: objectSchema(["id", "revision"], {
      id: decimalSchema,
      revision: decimalSchema,
    }),
    annotations: { "neutron:effects": ["write"] },
  },
  async (args) => {
    const result = await removeContact({
      id: requiredString(args.id, "id"),
      expectedRevision: requiredString(args.expectedRevision, "expectedRevision"),
    });
    await publishRevision(result.revision);
    return asJson(result);
  },
);

async function publishRevision(revision: string): Promise<void> {
  try {
    await publishAppStateChange(STATE_TOPIC, revision);
  } catch {
    // Mutation succeeded; polling remains the fallback if notification fails.
  }
}

function requiredAddressDrafts(value: JsonValue | undefined): ContactAddressDraft[] {
  if (!Array.isArray(value)) throw new Error("addresses must be an array");
  return value.map((item) => {
    const record = requiredObject(item, "address");
    if (typeof record.preferred !== "boolean") {
      throw new Error("address preferred must be a boolean");
    }
    const destination = requiredObject(record.destination, "destination");
    const network = requiredNetwork(destination.network);
    return {
      id: optionalNullableString(record.id),
      label: optionalNullableString(record.label),
      preferred: record.preferred,
      destination:
        network === "neutron"
          ? {
              network,
              principal: requiredString(destination.principal, "principal"),
            }
          : network === "internet_computer"
          ? {
              network,
              account: requiredString(destination.account, "account"),
            }
          : {
              network,
              address: requiredString(destination.address, "address"),
            },
    };
  });
}

function objectSchema(required: string[], properties: JsonObject): JsonObject {
  return { type: "object", required, properties, additionalProperties: false };
}

function requiredObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function requiredString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

function optionalNullableString(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("Expected a string or null");
  return value;
}

function optionalInteger(value: JsonValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Expected an integer");
  }
  return value;
}

function requiredKind(value: JsonValue | undefined) {
  if (!isContactKind(value)) throw new Error("kind must be person or self");
  return value;
}

function optionalKind(value: JsonValue | undefined) {
  return value === undefined ? undefined : requiredKind(value);
}

function requiredNetwork(value: JsonValue | undefined) {
  if (!isNetwork(value)) throw new Error("Unknown destination network");
  return value;
}

function optionalNetwork(value: JsonValue | undefined) {
  return value === undefined ? undefined : requiredNetwork(value);
}

function requiredNetworks(value: JsonValue | undefined) {
  if (!Array.isArray(value)) throw new Error("networks must be an array");
  return value.map(requiredNetwork);
}

function asJson(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new Error("Contacts returned non-JSON data");
  return value;
}
