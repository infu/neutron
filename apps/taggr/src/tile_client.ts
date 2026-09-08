// Tile-side access to the resident background.
//
// A tile frame is credentialless: its storage partition does not survive a
// reload, so it cannot hold the Taggr key and does not make network calls. It
// drives the background over the same-app message bus instead, which needs no
// owner consent, and parses Taggr's raw JSON with the same `model.ts` parsers
// the background uses.

import { callTool, loadTileContext, type JsonObject, type JsonValue } from "neutron-tools/app";
import { setTaggrTransport, type AddPostInput } from "./taggr_api.ts";
import { TaggrParseError, type TaggrDomain } from "./model.ts";

export type TileSettings = {
  canister: string;
  /** The hostname in use, resolved by the background if none was pinned. */
  domain: string;
  /** False when the domain follows the deployment rather than an owner choice. */
  domainPinned: boolean;
  /** Every domain the deployment registered, for the picker. */
  domains: TaggrDomain[];
  /** The principal this installation posts under. */
  principal: string;
  /** True once the key in use is the one this app's canister memory holds. */
  stored: boolean;
  /** Why it is not, in the owner's words, or null. */
  storageError: string | null;
  /** "ic" or "local", derived by the background from its own host. */
  network: string;
};

const target = (): `app:${string}:background` => {
  const appId = loadTileContext().app ?? "taggr";
  return `app:${appId}:background`;
};

/** Reads can be slow on a cold background; writes go through consensus. */
const CALL_TIMEOUT_SECONDS = 90;

/** Registration waits on Wallet's own review, which is a human decision. */
const WALLET_TIMEOUT_SECONDS = 240;

const call = async (
  name: string,
  args: JsonObject = {},
  timeout = CALL_TIMEOUT_SECONDS,
): Promise<JsonValue> =>
  callTool({ target: target(), name, arguments: args }, { timeout });

const record = (value: JsonValue, label: string): Record<string, JsonValue> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaggrParseError(`The Taggr background returned an unexpected ${label}`);
  }
  return value as Record<string, JsonValue>;
};

const text = (value: JsonValue, key: string, label: string): string => {
  const entry = record(value, label)[key];
  if (typeof entry !== "string") {
    throw new TaggrParseError(`The Taggr background returned an unexpected ${label}`);
  }
  return entry;
};

/** Routes every `taggr_api` call through the background. */
export const installTileTransport = (): void => {
  setTaggrTransport({
    query: async (method, payload) =>
      text(await call("ui_read", { method, payload }), "json", "read reply"),
    update: async (method, payload) =>
      text(await call("ui_write", { method, payload }), "json", "write reply"),
    addPost: async (input: AddPostInput) => {
      const reply = record(
        await call("ui_add_post", {
          body: input.body,
          parentPostId: input.parent ?? null,
          realm: input.realm ?? null,
        }),
        "publish reply",
      );
      const postId = reply.postId;
      if (typeof postId !== "number" || !Number.isSafeInteger(postId)) {
        throw new TaggrParseError("Taggr returned an unexpected post id");
      }
      return postId;
    },
  });
};

/** The background sends the scope flattened; rebuild the parsed shape here. */
const parseDomainList = (value: JsonValue): TaggrDomain[] => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const domain = record(entry, "domain");
    const kind = domain.scope;
    const realms = Array.isArray(domain.realms)
      ? domain.realms.filter((realm): realm is string => typeof realm === "string")
      : [];
    return {
      name: text(entry, "name", "domain"),
      maxDownvotes: typeof domain.maxDownvotes === "number" ? domain.maxDownvotes : 0,
      owner: typeof domain.owner === "number" ? domain.owner : null,
      scope:
        kind === "whitelist"
          ? { kind: "whitelist", realms }
          : kind === "journal"
            ? { kind: "journal", userId: 0 }
            : { kind: "blacklist", realms },
    };
  });
};

export const loadTileSettings = async (): Promise<TileSettings> => {
  const reply = await call("ui_settings");
  return {
    canister: text(reply, "canister", "settings"),
    domain: text(reply, "domain", "settings"),
    domainPinned: record(reply, "settings").domainPinned === true,
    domains: parseDomainList(record(reply, "settings").domains ?? []),
    principal: text(reply, "principal", "settings"),
    network: text(reply, "network", "settings"),
    stored: record(reply, "settings").stored === true,
    storageError:
      typeof record(reply, "settings").storageError === "string"
        ? (record(reply, "settings").storageError as string)
        : null,
  };
};

export const configure = async (input: {
  canister: string;
  domain: string | null;
}): Promise<TileSettings> => {
  await call("ui_configure", { canister: input.canister, domain: input.domain });
  return loadTileSettings();
};

export const validateHandle = async (name: string): Promise<string | null> => {
  const reply = record(await call("ui_validate_username", { name }), "handle check");
  return typeof reply.error === "string" ? reply.error : null;
};

export const register = async (name: string, invite: string): Promise<boolean> => {
  const reply = record(await call("ui_register", { name, invite }), "registration");
  return reply.registered === true;
};

export type RegistrationQuote = {
  /** Price of one kilo-credit in e8s, as Taggr fixed it on the invoice. */
  amountAtoms: string;
  paid: boolean;
  /** The ICRC account Wallet would pay. */
  account: string;
};

export const registrationQuote = async (): Promise<RegistrationQuote> => {
  const reply = record(await call("ui_registration_quote"), "registration quote");
  return {
    amountAtoms: text(reply, "amountAtoms", "registration quote"),
    paid: reply.paid === true,
    account: text(reply, "account", "registration quote"),
  };
};

/**
 * Opens Wallet to pay the Taggr invoice and then creates the account. Wallet
 * owns the review and the transfer; this call returns once it has settled.
 */
export const registerWithIcp = async (name: string): Promise<boolean> => {
  const reply = record(
    await call("ui_register_with_icp", { name }, WALLET_TIMEOUT_SECONDS),
    "registration",
  );
  return reply.registered === true;
};

/**
 * The exported string *is* the Taggr account. The background restricts this to
 * this app's own tile; the tile shows it once and never stores it.
 */
export const exportIdentity = async (): Promise<string> =>
  text(await call("ui_identity", { action: "export" }), "backup", "identity export");

export const importIdentity = async (backup: string): Promise<string> =>
  text(await call("ui_identity", { action: "import", backup }), "principal", "identity import");

export const resetIdentity = async (): Promise<string> =>
  text(await call("ui_identity", { action: "reset" }), "principal", "identity reset");
