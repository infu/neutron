import {
  listBackendCallReservations,
  requestBackendCallReservations,
  type BackendCallReservationsRequest,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/app";
import {
  CANISTER_METHOD_MAX_LENGTH,
  physicalPublicIngressMethodName,
} from "neutron-tools/src/physical_names.js";
import {
  encodeMailPrepareRecipientRequest,
  type MailBackendPreparedRecipient,
  type MailPrepareRecipientRequest,
} from "./backend.ts";
import { MAIL_MAX_ENVELOPE_BYTES } from "./protocol.ts";
import {
  MAIL_CONTEXT_PUBLIC_KEY_BYTES,
  MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
} from "./vetkeys_adapter.ts";

export const MAIL_DELIVERY_ACCESS_METHODS = [
  physicalPublicIngressMethodName("mail", "mail_v1", "update"),
] as const;

export type MailDeliveryAccessMethod =
  (typeof MAIL_DELIVERY_ACCESS_METHODS)[number];

export type MailDeliveryReservationState = {
  complete: boolean;
  ownedMethods: MailDeliveryAccessMethod[];
  missingMethods: MailDeliveryAccessMethod[];
};

export type MailDeliveryReservationList = () => Promise<JsonValue>;

export type MailDeliveryReservationRequest = (
  request: BackendCallReservationsRequest,
) => Promise<JsonValue>;

export type MailDeliveryAccessRequest = JsonObject & {
  recipient: MailPrepareRecipientRequest["recipient"];
  permitRequestId: string;
};

export type MailDeliveryAccessPreparation = JsonObject & {
  request: MailDeliveryAccessRequest;
  prepared: JsonObject & {
    permitId: string;
    recipient: string;
    contactId: string | null;
    contactRevision: string | null;
    bookRevision: string;
    expiresAtNs: string;
    publicInfoHash: string;
    keyInfo: JsonObject & {
      protocolVersion: 1;
      suite: 1;
      deliveryKeyEpoch: string;
      contextPublicKey: string;
      effectiveIbeIdentity: string;
      recipientKeyFingerprint: string;
      maxEnvelopeBytes: typeof MAIL_MAX_ENVELOPE_BYTES;
    };
  };
};

export function projectMailDeliveryAccessRequest(
  request: MailPrepareRecipientRequest,
): MailDeliveryAccessRequest {
  encodeMailPrepareRecipientRequest(request);
  return {
    recipient: { ...request.recipient },
    permitRequestId: encodeHex(request.permitRequestId),
  };
}

export function parseMailDeliveryAccessRequest(
  value: unknown,
): MailPrepareRecipientRequest {
  const record = exactObject(value, "Mail delivery access request");
  exactKeys(record, ["recipient", "permitRequestId"]);
  const recipient = exactObject(record.recipient, "Mail delivery access recipient");
  const kind = recipient.kind;
  let normalized: MailPrepareRecipientRequest["recipient"];
  if (kind === "direct") {
    exactKeys(recipient, ["kind", "principal"]);
    normalized = { kind, principal: requiredString(recipient.principal) };
  } else if (kind === "contact") {
    exactKeys(recipient, ["kind", "principal", "contactId", "expectedContactRevision"]);
    normalized = {
      kind,
      principal: requiredString(recipient.principal),
      contactId: requiredString(recipient.contactId),
      expectedContactRevision: requiredString(recipient.expectedContactRevision),
    };
  } else {
    invalid("Mail delivery access recipient");
  }
  const request = {
    recipient: normalized,
    permitRequestId: decodeHex(record.permitRequestId, 16, true),
  };
  encodeMailPrepareRecipientRequest(request);
  return request;
}

export function parseMailDeliveryReservationState(
  value: unknown,
): MailDeliveryReservationState {
  const response = exactObject(value, "Mail delivery reservation response");
  exactKeys(response, ["reservations"]);
  if (!Array.isArray(response.reservations)) {
    invalid("Mail delivery reservation response");
  }

  const scopes = new Set<string>();
  const owned = new Set<MailDeliveryAccessMethod>();
  for (const candidate of response.reservations) {
    const reservation = exactObject(candidate, "Mail delivery reservation");
    exactKeys(reservation, [
      "id",
      "appId",
      "installationUid",
      "scopeKind",
      "principal",
      "method",
      "createdAt",
      "createdBy",
    ]);
    requiredDecimal(reservation.id);
    if (reservation.appId !== "mail") invalid("Mail delivery reservation owner");
    requiredDecimal(reservation.installationUid);
    requiredDecimal(reservation.createdAt);
    requiredString(reservation.createdBy);

    const kind = reservation.scopeKind;
    const principal = reservation.principal;
    const method = reservation.method;
    let scope: string;
    if (kind === "principal") {
      scope = `principal:${requiredString(principal)}`;
      if (method !== null) invalid("Mail delivery reservation scope");
    } else if (kind === "method") {
      const normalizedMethod = requiredMethod(method);
      scope = `method:${normalizedMethod}`;
      if (principal !== null) invalid("Mail delivery reservation scope");
      if (isMailDeliveryAccessMethod(normalizedMethod)) {
        owned.add(normalizedMethod);
      }
    } else if (kind === "exact") {
      scope = `exact:${requiredString(principal)}:${requiredMethod(method)}`;
    } else {
      invalid("Mail delivery reservation scope");
    }
    if (scopes.has(scope)) invalid("Mail delivery reservation duplicate");
    scopes.add(scope);
  }

  const ownedMethods = MAIL_DELIVERY_ACCESS_METHODS.filter((method) =>
    owned.has(method)
  );
  const missingMethods = MAIL_DELIVERY_ACCESS_METHODS.filter((method) =>
    !owned.has(method)
  );
  return {
    complete: missingMethods.length === 0,
    ownedMethods,
    missingMethods,
  };
}

export async function readMailDeliveryReservationState(
  list: MailDeliveryReservationList = listBackendCallReservations,
): Promise<MailDeliveryReservationState> {
  return parseMailDeliveryReservationState(await list());
}

export async function ensureMailDeliveryReservations(
  list: MailDeliveryReservationList = listBackendCallReservations,
  request: MailDeliveryReservationRequest = requestBackendCallReservations,
): Promise<MailDeliveryReservationState> {
  const current = await readMailDeliveryReservationState(list);
  if (current.complete) return current;

  const value = await request({
    actions: current.missingMethods.map((method) => ({
      kind: "reserve" as const,
      scope: { kind: "method" as const, method },
    })),
  });
  const updated = parseMailDeliveryReservationState(value);
  if (!updated.complete) {
    throw new Error("Mail delivery methods were not reserved");
  }
  return updated;
}

export function projectMailDeliveryAccessPreparation(
  request: MailPrepareRecipientRequest,
  prepared: MailBackendPreparedRecipient,
): MailDeliveryAccessPreparation {
  const projection: MailDeliveryAccessPreparation = {
    request: projectMailDeliveryAccessRequest(request),
    prepared: {
      permitId: encodeHex(prepared.permitId),
      recipient: prepared.recipient,
      contactId: prepared.contactId,
      contactRevision: prepared.contactRevision,
      bookRevision: prepared.bookRevision,
      expiresAtNs: prepared.expiresAtNs,
      publicInfoHash: encodeHex(prepared.publicInfoHash),
      keyInfo: {
        protocolVersion: 1,
        suite: 1,
        deliveryKeyEpoch: prepared.keyInfo.deliveryKeyEpoch,
        contextPublicKey: encodeHex(prepared.keyInfo.contextPublicKey),
        effectiveIbeIdentity: encodeHex(prepared.keyInfo.effectiveIbeIdentity),
        recipientKeyFingerprint: encodeHex(prepared.keyInfo.recipientKeyFingerprint),
        maxEnvelopeBytes: MAIL_MAX_ENVELOPE_BYTES,
      },
    },
  };
  parseMailDeliveryAccessPreparation(projection);
  return projection;
}

export function parseMailDeliveryAccessPreparation(value: unknown): {
  request: MailPrepareRecipientRequest;
  prepared: MailBackendPreparedRecipient;
} {
  const record = exactObject(value, "Mail delivery access preparation");
  exactKeys(record, ["request", "prepared"]);
  const request = parseMailDeliveryAccessRequest(record.request);
  const source = exactObject(record.prepared, "Mail prepared delivery access");
  exactKeys(source, [
    "permitId", "recipient", "contactId", "contactRevision", "bookRevision",
    "expiresAtNs", "publicInfoHash", "keyInfo",
  ]);
  const key = exactObject(source.keyInfo, "Mail prepared delivery key");
  exactKeys(key, [
    "protocolVersion", "suite", "deliveryKeyEpoch", "contextPublicKey",
    "effectiveIbeIdentity", "recipientKeyFingerprint", "maxEnvelopeBytes",
  ]);
  if (key.protocolVersion !== 1 || key.suite !== 1 ||
    key.maxEnvelopeBytes !== MAIL_MAX_ENVELOPE_BYTES) invalid("Mail prepared delivery key");
  const prepared: MailBackendPreparedRecipient = {
    permitId: decodeHex(source.permitId, 32, true),
    recipient: requiredString(source.recipient),
    contactId: nullableString(source.contactId),
    contactRevision: nullableString(source.contactRevision),
    bookRevision: requiredDecimal(source.bookRevision),
    expiresAtNs: requiredDecimal(source.expiresAtNs),
    publicInfoHash: decodeHex(source.publicInfoHash, 32, true),
    keyInfo: {
      protocolVersion: 1,
      suite: 1,
      deliveryKeyEpoch: requiredPositiveDecimal(key.deliveryKeyEpoch),
      contextPublicKey: decodeHex(key.contextPublicKey, MAIL_CONTEXT_PUBLIC_KEY_BYTES, true),
      effectiveIbeIdentity: decodeHex(
        key.effectiveIbeIdentity,
        MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
        true,
      ),
      recipientKeyFingerprint: decodeHex(key.recipientKeyFingerprint, 32, true),
      maxEnvelopeBytes: MAIL_MAX_ENVELOPE_BYTES,
    },
  };
  assertPreparedMatches(request, prepared);
  return { request, prepared };
}

function assertPreparedMatches(
  request: MailPrepareRecipientRequest,
  prepared: MailBackendPreparedRecipient,
): void {
  const recipient = request.recipient;
  if (
    prepared.recipient !== recipient.principal ||
    (recipient.kind === "direct" &&
      (prepared.contactId !== null || prepared.contactRevision !== null || prepared.bookRevision !== "0")) ||
    (recipient.kind === "contact" &&
      (prepared.contactId !== recipient.contactId ||
        prepared.contactRevision !== recipient.expectedContactRevision ||
        prepared.bookRevision === "0"))
  ) invalid("Mail prepared delivery binding");
}

function exactObject(value: unknown, label: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) invalid(label);
  return value as Record<string, JsonValue>;
}

function exactKeys(value: Record<string, JsonValue>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) invalid("Mail delivery access value");
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) invalid("Mail delivery access text");
  return value;
}

function requiredMethod(value: unknown): string {
  const method = requiredString(value);
  if (
    method.length > CANISTER_METHOD_MAX_LENGTH ||
    !/^[a-zA-Z0-9_]+$/u.test(method)
  ) {
    invalid("Mail delivery reservation method");
  }
  return method;
}

function isMailDeliveryAccessMethod(
  value: string,
): value is MailDeliveryAccessMethod {
  return (MAIL_DELIVERY_ACCESS_METHODS as readonly string[]).includes(value);
}

function nullableString(value: unknown): string | null {
  return value === null ? null : requiredString(value);
}

function requiredDecimal(value: unknown): string {
  const text = requiredString(value);
  if (!/^(0|[1-9][0-9]*)$/u.test(text) || text.length > 24) invalid("Mail delivery access decimal");
  return text;
}

function requiredPositiveDecimal(value: unknown): string {
  const text = requiredDecimal(value);
  if (text === "0") invalid("Mail delivery access positive decimal");
  return text;
}

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value: unknown, length: number, nonzero: boolean): Uint8Array {
  if (typeof value !== "string" || value.length !== length * 2 || !/^[0-9a-f]+$/u.test(value)) {
    invalid("Mail delivery access bytes");
  }
  const bytes = Uint8Array.from({ length }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  );
  if (nonzero && !bytes.some(Boolean)) invalid("Mail delivery access bytes");
  return bytes;
}

function invalid(label: string): never {
  throw new Error(`Invalid ${label}`);
}
