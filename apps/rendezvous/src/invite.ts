export type RendezvousInviteV1 = { host: string; negotiationId: Uint8Array; capability: Uint8Array; expiresAtNs: string };
export type RendezvousAddressV1 = { host: string };
const ADDRESS_PREFIX = "RVC1-";
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) => { if (!/^[0-9a-f]{32}$/.test(value)) throw new Error("Invalid 128-bit invite field"); return Uint8Array.from(value.match(/../g)!.map((part) => Number.parseInt(part, 16))); };
const principalPattern = /^[a-z0-9]{1,5}(?:-[a-z0-9]{1,5})+$/;
export function encodeInvite(invite: RendezvousInviteV1): string {
  if (!principalPattern.test(invite.host) || invite.negotiationId.length !== 16 || invite.capability.length !== 16 || !/^[1-9][0-9]{0,19}$/.test(invite.expiresAtNs)) throw new Error("Invalid invite");
  return `rv1.${invite.host}.${hex(invite.negotiationId)}.${hex(invite.capability)}.${invite.expiresAtNs}`;
}
export function decodeInvite(value: string): RendezvousInviteV1 {
  if (value.length > 220 || value !== value.trim()) throw new Error("Invalid invite encoding");
  const parts = value.split("."); if (parts.length !== 5 || parts[0] !== "rv1" || !principalPattern.test(parts[1]) || !/^[1-9][0-9]{0,19}$/.test(parts[4])) throw new Error("Invalid invite encoding");
  const result = { host: parts[1], negotiationId: bytes(parts[2]), capability: bytes(parts[3]), expiresAtNs: parts[4] };
  if (encodeInvite(result) !== value) throw new Error("Non-canonical invite"); return result;
}

export function encodeAddress(address: RendezvousAddressV1): string {
  if (!principalPattern.test(address.host)) throw new Error("Invalid Rendezvous address");
  return `${ADDRESS_PREFIX}${base64UrlEncode(JSON.stringify({ v: 1, h: address.host }))}`;
}

export function decodeAddress(value: string): RendezvousAddressV1 {
  const compact = value.trim().replace(/\s+/g, "");
  if (compact.length > 180 || !compact.startsWith(ADDRESS_PREFIX)) throw new Error("This is not a Rendezvous address");
  let parsed: unknown;
  try { parsed = JSON.parse(base64UrlDecode(compact.slice(ADDRESS_PREFIX.length))); } catch { throw new Error("The Rendezvous address is damaged or incomplete"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Rendezvous address");
  const payload = parsed as { v?: unknown; h?: unknown };
  if (payload.v !== 1 || typeof payload.h !== "string" || !principalPattern.test(payload.h)) throw new Error("Invalid Rendezvous address");
  const result = { host: payload.h };
  if (encodeAddress(result) !== compact) throw new Error("Non-canonical Rendezvous address");
  return result;
}

export function resolvePeer(value: string): string {
  const compact = value.trim();
  if (compact.startsWith(ADDRESS_PREFIX)) return decodeAddress(compact).host;
  if (!principalPattern.test(compact)) throw new Error("Paste a Rendezvous address or valid Neutron principal");
  return compact;
}

function base64UrlEncode(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
