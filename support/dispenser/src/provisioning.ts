import type { Actor, ActorMethod } from "@dfinity/agent";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { Principal as IcpSdkPrincipal } from "@icp-sdk/core/principal";
import { AccountIdentifier, SubAccount } from "@icp-sdk/canisters/ledger/icp";
import { encodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import {
  appendInternalHandoffFragment,
  captureRepositorySetupFragment,
  clearPendingRepositorySetup,
  REPOSITORY_LIMITS,
  type RepositoryHistory,
  type RepositoryLocation,
  type RepositorySetupReference,
  type RepositoryStorage,
} from "neutron-tools/repository";
import { neutronUrl as runtimeNeutronUrl } from "neutron-tools/src/runtime.js";

export type PrincipalLike = string | Principal;

export type CandidResult<T> = { ok: T } | { err: string };

export type ProvisioningStage =
  | { awaiting_payment: null }
  | { transferring: null }
  | { notifying_cmc: null }
  | { created: null }
  | { installed: null }
  | { controlled: null }
  | { assets_seeded: null }
  | { activated: null }
  | { complete: null };

export type ProvisioningStatus = {
  stage: ProvisioningStage;
  canister_id: [] | [Principal];
};

export type DispenserActor = {
  find: ActorMethod<[], [] | [Principal]>;
  provision: ActorMethod<[Uint8Array], CandidResult<Principal>>;
  status: ActorMethod<[], ProvisioningStatus>;
};

export type ProvisioningSecrets = {
  identity: Ed25519KeyIdentity;
  activationToken: string;
};

export type LocalStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type ProvisioningCrypto = Pick<Crypto, "getRandomValues" | "subtle">;

export type ProviderSetupCapture = {
  setup: RepositorySetupReference | null;
  expiresAt: number | null;
  error: string | null;
};

type InterfaceFactory = Parameters<typeof Actor.createActor>[0];

export const dispenserIdl: InterfaceFactory = ({ IDL: candid }) => {
  const Result = candid.Variant({ ok: candid.Principal, err: candid.Text });
  const Stage = candid.Variant({
    awaiting_payment: candid.Null,
    transferring: candid.Null,
    notifying_cmc: candid.Null,
    created: candid.Null,
    installed: candid.Null,
    controlled: candid.Null,
    assets_seeded: candid.Null,
    activated: candid.Null,
    complete: candid.Null,
  });
  return candid.Service({
    find: candid.Func([], [candid.Opt(candid.Principal)], ["query"]),
    provision: candid.Func([candid.Vec(candid.Nat8)], [Result], []),
    status: candid.Func(
      [],
      [
        candid.Record({
          stage: Stage,
          canister_id: candid.Opt(candid.Principal),
        }),
      ],
      ["query"],
    ),
  });
};

const ACTIVATION_BYTES = 32;
const ACTIVATION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STORAGE_VERSION = 1;

export function provisioningStorageKey(dispenserCanisterId: string): string {
  return `neutron.dispenser.provisioning.v1:${Principal.fromText(
    dispenserCanisterId,
  ).toText()}`;
}

export function loadOrCreateProvisioningSecrets({
  storage,
  dispenserCanisterId,
  cryptoSource = globalThis.crypto,
}: {
  storage: LocalStorageLike;
  dispenserCanisterId: string;
  cryptoSource?: ProvisioningCrypto;
}): ProvisioningSecrets {
  const key = provisioningStorageKey(dispenserCanisterId);
  const stored = storage.getItem(key);
  if (stored !== null) {
    try {
      const value = JSON.parse(stored) as {
        version?: unknown;
        identity?: unknown;
        activationToken?: unknown;
      };
      if (
        value.version !== STORAGE_VERSION ||
        !Array.isArray(value.identity) ||
        value.identity.length !== 2 ||
        typeof value.identity[0] !== "string" ||
        typeof value.identity[1] !== "string" ||
        typeof value.activationToken !== "string"
      ) {
        throw new Error("record shape is invalid");
      }
      const identity = Ed25519KeyIdentity.fromParsedJson(
        value.identity as [string, string],
      );
      return {
        identity,
        activationToken: validateActivationToken(value.activationToken),
      };
    } catch (cause) {
      throw new Error(
        "The saved dispenser private key or activation code is invalid. It was left untouched so a funded provisioning address is not silently replaced.",
        { cause },
      );
    }
  }

  const identitySeed = randomBytes(cryptoSource, ACTIVATION_BYTES);
  const activationBytes = randomBytes(cryptoSource, ACTIVATION_BYTES);
  const identity = Ed25519KeyIdentity.generate(identitySeed);
  const activationToken = encodeActivationToken(activationBytes);
  // Persist both secrets before exposing the deposit address. A refresh must
  // reproduce the same signed caller and the same one-time ownership link.
  storage.setItem(
    key,
    JSON.stringify({
      version: STORAGE_VERSION,
      identity: identity.toJSON(),
      activationToken,
    }),
  );
  return { identity, activationToken };
}

export async function activationHash(
  token: string,
  cryptoSource: ProvisioningCrypto = globalThis.crypto,
): Promise<Uint8Array> {
  const tokenBytes = Uint8Array.from(
    decodeActivationToken(validateActivationToken(token)),
  );
  const digest = await cryptoSource.subtle.digest("SHA-256", tokenBytes.buffer);
  return new Uint8Array(digest);
}

export function encodeActivationToken(bytes: Uint8Array): string {
  if (bytes.byteLength !== ACTIVATION_BYTES) {
    throw new Error("Activation code entropy must be exactly 32 bytes");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeActivationToken(token: string): Uint8Array {
  validateActivationToken(token);
  const base64 = token.replace(/-/g, "+").replace(/_/g, "/") + "=";
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.byteLength !== ACTIVATION_BYTES ||
    encodeActivationToken(bytes) !== token
  ) {
    throw new Error("Activation code is not canonical");
  }
  return bytes;
}

export function validateActivationToken(token: string): string {
  if (!ACTIVATION_PATTERN.test(token)) {
    throw new Error(
      "Activation code must be an unpadded base64url encoding of 32 bytes",
    );
  }
  return token;
}

export function provisioningStageName(stage: ProvisioningStage): string {
  return Object.keys(stage)[0] ?? "awaiting_payment";
}

export function principalText(value: PrincipalLike): string {
  return typeof value === "string" ? value : value.toText();
}

export function unwrapOpt<T>(value: [] | [T]): T | null {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error("Invalid Candid opt response");
  }
  return value.length === 0 ? null : value[0]!;
}

export function unwrapResult<T>(result: CandidResult<T>): T {
  if (!isRecord(result) || Object.keys(result).length !== 1) {
    throw new Error("Invalid Candid result response");
  }
  if ("ok" in result) return result.ok as T;
  if ("err" in result && typeof result.err === "string") {
    throw new Error(result.err);
  }
  throw new Error("Invalid Candid result response");
}

export function neutronUrl(
  canisterId: PrincipalLike,
  {
    local = false,
    localHost,
  }: {
    local?: boolean;
    localHost?: string;
  } = {},
): string {
  return runtimeNeutronUrl({
    canisterId: principalText(canisterId),
    local,
    ...(localHost === undefined ? {} : { localHost }),
  });
}

export function depositAccountIdentifier({
  dispenserCanisterId,
  userPrincipal,
}: {
  dispenserCanisterId: string;
  userPrincipal: Principal;
}): string {
  const { owner, subaccount } = depositAccountParts({
    dispenserCanisterId,
    userPrincipal,
  });
  return AccountIdentifier.fromPrincipal({
    principal: owner,
    subAccount: subaccount,
  }).toHex();
}

export function depositIcrcAccountText({
  dispenserCanisterId,
  userPrincipal,
}: {
  dispenserCanisterId: string;
  userPrincipal: Principal;
}): string {
  const { owner, subaccount } = depositAccountParts({
    dispenserCanisterId,
    userPrincipal,
  });
  return encodeIcrcAccount({
    owner,
    subaccount: subaccount.toUint8Array(),
  });
}

function depositAccountParts({
  dispenserCanisterId,
  userPrincipal,
}: {
  dispenserCanisterId: string;
  userPrincipal: Principal;
}): { owner: IcpSdkPrincipal; subaccount: SubAccount } {
  const owner = IcpSdkPrincipal.fromText(dispenserCanisterId);
  const ledgerUser = IcpSdkPrincipal.fromText(userPrincipal.toText());
  return {
    owner,
    subaccount: SubAccount.fromPrincipal(ledgerUser),
  };
}

export function neutronHandoffUrl({
  base,
  setup,
  activationToken,
}: {
  base: string;
  setup: RepositorySetupReference | null;
  activationToken: string;
}): string {
  const handoff = setup ? appendInternalHandoffFragment(base, setup) : base;
  const url = new URL(handoff);
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.set("activate", validateActivationToken(activationToken));
  url.hash = fragment.toString();
  return url.href;
}

export function captureProviderSetupHandoff({
  location,
  history,
  storage,
  now = Date.now(),
}: {
  location: RepositoryLocation;
  history: RepositoryHistory;
  storage: RepositoryStorage;
  now?: number;
}): ProviderSetupCapture {
  const result = captureRepositorySetupFragment({
    mode: "provider",
    location,
    storage,
    history,
    now,
  });

  if (result.status === "captured") {
    if (!result.stripped) {
      clearProviderSetupBestEffort(storage);
      return {
        setup: null,
        expiresAt: null,
        error:
          "The setup handoff could not be removed from the address bar. Close this tab and open the setup link again.",
      };
    }
    return {
      setup: result.reference,
      expiresAt: now + REPOSITORY_LIMITS.pendingSetupLifetimeMs,
      error: null,
    };
  }
  if (result.status === "storage_error") {
    return {
      setup: result.reference,
      expiresAt: now + REPOSITORY_LIMITS.pendingSetupLifetimeMs,
      error:
        "Temporary setup storage is unavailable. The setup link remains in the address bar; keep this dispenser tab open until Neutron is launched.",
    };
  }
  if (result.status === "invalid") {
    if (!result.stripped) {
      clearProviderSetupBestEffort(storage);
      return {
        setup: null,
        expiresAt: null,
        error:
          "The invalid setup handoff could not be removed from the address bar. Close this tab before continuing.",
      };
    }
    if (result.retireError !== undefined) {
      return {
        setup: null,
        expiresAt: null,
        error:
          "The invalid setup link was removed, but an earlier temporary setup could not be retired. Close this tab before continuing.",
      };
    }
    return { setup: null, expiresAt: null, error: result.error.message };
  }
  return { setup: null, expiresAt: null, error: null };
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clearProviderSetupBestEffort(storage: RepositoryStorage): void {
  try {
    clearPendingRepositorySetup(storage);
  } catch {
    // The rejected handoff is never returned to the UI.
  }
}

function randomBytes(
  cryptoSource: ProvisioningCrypto,
  size: number,
): Uint8Array {
  const bytes = new Uint8Array(size);
  cryptoSource.getRandomValues(bytes);
  if (bytes.byteLength !== size) {
    throw new Error(`Web Crypto did not produce ${size} bytes`);
  }
  return bytes;
}
