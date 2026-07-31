const INVITE_PREFIX = "NC1-";
export const MAX_INVITE_CODE_LENGTH = 512;
const GAME_ID_PATTERN = /^[a-f0-9]{32}(?:_[1-9][0-9]{0,94})?$/;
const PRINCIPAL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])?$/;

export type ChessInvite = {
  version: 1;
  hostPrincipal: string;
  gameId: string;
};

type InvitePayload = {
  v: 1;
  h: string;
  g: string;
};

export function createGameId(random: Crypto = crypto): string {
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function encodeInvite(invite: ChessInvite): string {
  const hostPrincipal = normalizePrincipal(invite.hostPrincipal);
  const gameId = normalizeGameId(invite.gameId);
  const payload: InvitePayload = { v: 1, h: hostPrincipal, g: gameId };
  return `${INVITE_PREFIX}${base64UrlEncode(JSON.stringify(payload))}`;
}

export function decodeInvite(value: string): ChessInvite {
  if (value.length > MAX_INVITE_CODE_LENGTH) {
    throw new Error("The invite code is too long");
  }
  const compact = value.trim().replace(/\s+/g, "");
  if (!compact.startsWith(INVITE_PREFIX)) {
    throw new Error("This is not a Neutron Chess invite code");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(compact.slice(INVITE_PREFIX.length)));
  } catch {
    throw new Error("The invite code is damaged or incomplete");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The invite code is invalid");
  }
  const payload = parsed as Partial<InvitePayload>;
  if (payload.v !== 1 || typeof payload.h !== "string" || typeof payload.g !== "string") {
    throw new Error("The invite code version is not supported");
  }
  return {
    version: 1,
    hostPrincipal: normalizePrincipal(payload.h),
    gameId: normalizeGameId(payload.g),
  };
}

export function normalizePrincipal(value: string): string {
  const principal = value.trim().toLowerCase();
  if (
    principal.length < 5 ||
    principal.length > 80 ||
    !PRINCIPAL_PATTERN.test(principal) ||
    principal.includes("--")
  ) {
    throw new Error("The invite contains an invalid Neutron principal");
  }
  return principal;
}

export function normalizeGameId(value: string): string {
  const gameId = value.trim().toLowerCase();
  if (!GAME_ID_PATTERN.test(gameId)) {
    throw new Error("The invite contains an invalid game id");
  }
  return gameId;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
