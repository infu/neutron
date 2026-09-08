import { AnonymousIdentity, type Identity } from "@dfinity/agent";
import type { DelegationIdentity, ECDSAKeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { OC_CANISTERS } from "../oc/constants.ts";
import {
  CommunityClient,
  GroupClient,
  GroupIndexClient,
  IdentityCanisterClient,
  LocalUserIndexClient,
  randomMessageId,
  UserClient,
  UserIndexClient,
  type Variant,
} from "../oc/clients.ts";
import {
  buildDelegationIdentity,
  clearOcSession,
  clearPendingEmail,
  derPublicKey,
  loadOrCreateSessionKey,
  loadPendingEmail,
  nsToMs,
  restoreOcIdentity,
  savePendingEmail,
  saveOcSession,
} from "../oc/identity.ts";
import { keystoreIsDurable } from "../oc/keystore.ts";
import { decodeMsgpack } from "../oc/msgpack.ts";
import { SignInWithEmailClient } from "../oc/sie.ts";
import { OcTransport } from "../oc/transport.ts";
import {
  asBytes,
  canisterAvatarUrl,
  directChatVM,
  messagePreview,
  messagesFromEvents,
  num,
  pickPrimaryChannel,
  ocErrorCode,
  ocErrorMessage,
  parseUserSummariesV2,
  principalText,
  shortId,
  str,
  toBigInt,
  unreadFrom,
  userAvatarUrl,
  userCanisterId,
  variantIs,
  variantPayload,
  variantTag,
  variantValue,
  whoAmIFromCurrentUser,
} from "../oc/view.ts";
import {
  OC_NAV_TOPIC,
  OC_STATE_TOPIC,
  type ChatId,
  type ChatVM,
  type DirectoryEntryVM,
  type JoinResultVM,
  type MessageVM,
  type PendingNavVM,
  type ProfileVM,
  type SaveProfileResultVM,
  type SendResultVM,
  type SetAvatarResultVM,
  type ShowChatResultVM,
  type SignInCompleteVM,
  type SignInPollVM,
  type SignInStartVM,
  type SignInStateVM,
  type UserVM,
  type WhoAmIVM,
} from "../shared/protocol.ts";

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// A serde Option<number> off the wire: value | null. null/absent → null.
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

type Route =
  | { kind: "direct"; them: string; canister: string; latestEventIndex: number; latestMessageIndex: number | null }
  | { kind: "group"; groupId: string; latestEventIndex: number; latestMessageIndex: number | null }
  | { kind: "channel"; communityId: string; channelId: number; latestEventIndex: number; latestMessageIndex: number | null };

/** Rules text + the version(s) to pass as accepted on the next send. */
type RulesInfo = {
  text: string;
  groupVersion: number | null;
  communityVersion: number | null;
  channelVersion: number | null;
};

type Profile = {
  ocPrincipal: string;
  userId: string;
  username: string;
  userCanister: string;
  localUserIndex: string;
  avatarUrl: string | null;
};

type CachedUser = { name: string; avatarUrl: string | null };

export type EngineEvents = { publish(topic: string, revision: number): void };

const MESSAGE_ID_EXISTS_CODE = 287;
const CHAT_RULES_NOT_ACCEPTED_CODE = 283;
const COMMUNITY_RULES_NOT_ACCEPTED_CODE = 282;

export class OpenChatEngine {
  private readonly transport = new OcTransport();
  private readonly sie = new SignInWithEmailClient(this.transport);
  private readonly identityCanister = new IdentityCanisterClient(this.transport);
  private readonly userIndex = new UserIndexClient(this.transport);
  private readonly user = new UserClient(this.transport);
  private readonly group = new GroupClient(this.transport);
  private readonly community = new CommunityClient(this.transport);
  private readonly groupIndex = new GroupIndexClient(this.transport);
  private readonly lui = new LocalUserIndexClient(this.transport);
  private readonly anonymous = new AnonymousIdentity();

  private sessionKey: ECDSAKeyIdentity | null = null;
  private ocIdentity: DelegationIdentity | null = null;
  private pendingOcIdentity: DelegationIdentity | null = null; // authenticated but unregistered
  private profile: Profile | null = null;
  private signIn: SignInStateVM = { phase: "idle" };
  private sending = false;
  private registrationInitiated = false;
  private registrationAt = 0;
  private storedExpirationMs = 0; // expiry of the persisted session, for re-saves

  private chats: ChatVM[] = [];
  private routes = new Map<ChatId, Route>();
  // userId -> display name + avatar, so messages and DM rows show names/avatars.
  private userCache = new Map<string, CachedUser>();
  private revision = 0;
  private navRevision = 0;
  private pendingNav: { chatId: ChatId; title: string } | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sessionEpoch = 0;
  private authStorageChain: Promise<void> = Promise.resolve();
  private signInPollPromise: Promise<SignInPollVM> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private chatsLoaded = false;
  private refreshError: unknown = null;

  constructor(private readonly events: EngineEvents) {}

  // -- lifecycle -----------------------------------------------------------
  private startPromise: Promise<void> | null = null;

  /**
   * Start (or return the in-flight/completed start). Idempotent so both the
   * service entry and whenReady() share one restore pass.
   */
  start(): Promise<void> {
    if (!this.startPromise) {
      // On failure, drop the cached promise so a later whenReady() retries the
      // restore rather than being stuck logged-out on one transient IDB error.
      this.startPromise = this.doStart().catch((e: unknown) => {
        this.startPromise = null;
        throw e;
      });
    }
    return this.startPromise;
  }

  /**
   * Resolve once the initial session restore has finished. whoami and other
   * reads await this so a tile that queries during a resident restart never
   * sees a premature "logged out" (the bug where returning after idle showed
   * the sign-in screen until the tile was reopened).
   */
  async whenReady(): Promise<void> {
    await this.start();
  }

  /** Wait for the first chat snapshot in this session without refreshing on
   * every state subscription read (which would publish another state event). */
  async whenChatsReady(): Promise<void> {
    await this.whenReady();
    if (!this.profile || this.chatsLoaded) return;
    await this.refresh();
    if (this.profile && !this.chatsLoaded) {
      throw this.refreshError ?? new Error("OpenChat chats are not available yet");
    }
  }

  private storeForSession(epoch: number, action: () => Promise<void>): Promise<void> {
    const result = this.authStorageChain.then(async () => {
      if (epoch === this.sessionEpoch) await action();
    });
    this.authStorageChain = result.catch(() => undefined);
    return result;
  }

  private async doStart(): Promise<void> {
    const epoch = this.sessionEpoch;
    await this.transport.ready().catch(() => undefined);
    this.sessionKey = await loadOrCreateSessionKey();
    const restored = await restoreOcIdentity(this.sessionKey);
    if (epoch !== this.sessionEpoch) return;
    if (restored) {
      this.ocIdentity = restored.identity;
      this.storedExpirationMs = restored.session.expirationMs;
      const p = restored.session.profile;
      if (p.userId && p.username && p.localUserIndex) {
        this.profile = {
          ocPrincipal: p.ocPrincipal,
          userId: p.userId,
          username: p.username,
          userCanister: userCanisterId(p.userId),
          localUserIndex: p.localUserIndex,
          avatarUrl: p.avatarUrl ?? null,
        };
        this.seedSelf();
        console.log(
          `[openchat] session restored for @${p.username} (durable storage: ${keystoreIsDurable()})`,
        );
        void this.refresh();
        this.startPolling();
      } else {
        console.warn("[openchat] restored session missing profile fields; will need sign-in");
        this.ocIdentity = null;
      }
      return;
    }
    console.log(`[openchat] no stored session (durable storage: ${keystoreIsDurable()}); awaiting sign-in`);
    // Resume a sign-in that was mid-flight when the resident last ran, so the
    // tile can keep showing the code and finish confirmation.
    const pending = await loadPendingEmail();
    if (epoch !== this.sessionEpoch) return;
    if (pending && nsToMs(pending.expiration) > Date.now()) {
      this.signIn = { phase: "ready", email: pending.email, emailSent: true, code: pending.code };
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.refresh(), 5000);
  }

  private ocAuth(): Identity {
    if (!this.ocIdentity) throw new Error("Not signed in to OpenChat");
    return this.ocIdentity;
  }

  private bumpRevision(): void {
    this.revision += 1;
    this.events.publish(OC_STATE_TOPIC, this.revision);
  }

  // -- navigation (agent drives the tile like a user) ----------------------
  /**
   * Resolve a chat by id or natural query, stash it as the pending navigation
   * target, and signal the tile. The full chat id is held here rather than in
   * the bounded view token, so any chat (including community channels) works.
   */
  showChat(chatId?: string, query?: string): ShowChatResultVM {
    const target = this.resolveChat(chatId, query);
    if (!target) {
      return {
        ok: false,
        chatId: null,
        title: null,
        message: "No matching chat. Use list_chats to see available chats.",
      };
    }
    this.pendingNav = target;
    this.navRevision += 1;
    this.events.publish(OC_NAV_TOPIC, this.navRevision);
    return { ok: true, chatId: target.chatId, title: target.title, message: null };
  }

  /** The tile consumes (and clears) the pending navigation target. */
  takePendingNav(): PendingNavVM {
    const nav = this.pendingNav;
    this.pendingNav = null;
    return nav;
  }

  private resolveChat(chatId?: string, query?: string): { chatId: ChatId; title: string } | null {
    if (chatId) {
      const exact = this.chats.find((c) => c.id === chatId);
      if (exact) return { chatId: exact.id, title: exact.title };
      if (this.routes.has(chatId)) return { chatId, title: chatId };
    }
    const q = query?.trim().toLowerCase();
    if (q) {
      const byTitle =
        this.chats.find((c) => c.title.toLowerCase() === q) ??
        this.chats.find((c) => c.title.toLowerCase().includes(q)) ??
        this.chats.find((c) => c.id.toLowerCase().includes(q));
      if (byTitle) return { chatId: byTitle.id, title: byTitle.title };
    }
    return null;
  }

  // -- who am i ------------------------------------------------------------
  whoami(): WhoAmIVM {
    if (this.profile) {
      return {
        status: "logged_in",
        ocPrincipal: this.profile.ocPrincipal,
        userId: this.profile.userId,
        username: this.profile.username,
        avatarUrl: this.profile.avatarUrl,
        pendingEmail: null,
      };
    }
    return {
      status: this.pendingOcIdentity ? "awaiting_email" : "logged_out",
      ocPrincipal: null,
      userId: null,
      username: null,
      pendingEmail: null,
    };
  }

  // -- onboarding ----------------------------------------------------------
  /**
   * Accepts a sign-in request and sends the magic-link email in the background.
   * generate_magic_link is a slow IC update (it makes an HTTPS outcall to the
   * email service, which can take much longer than a normal call), so we never
   * block a single RPC on it — the tile polls signInStatus for the code.
   */
  signInStart(email: string): SignInStartVM {
    const trimmed = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      return { accepted: false, message: "Enter a valid email address" };
    }
    if (this.sending && this.signIn.phase === "ready" && this.signIn.email === trimmed) {
      return { accepted: true, message: null };
    }
    const epoch = ++this.sessionEpoch;
    this.pendingOcIdentity = null;
    this.pendingExpirationMs = 0;
    this.signInPollPromise = null;
    // Show the paste box immediately — the code and everything needed to finish
    // are in the emailed link, so the UI never waits on generate_magic_link's
    // reply. We fetch that reply (which carries the user_key) in the background.
    this.signIn = { phase: "ready", email: trimmed, emailSent: false, code: null };
    this.registrationInitiated = false;
    this.sending = true;
    void this.sendMagicLink(trimmed, epoch);
    return { accepted: true, message: null };
  }

  private async sendMagicLink(email: string, epoch: number): Promise<void> {
    try {
      await this.storeForSession(epoch, clearPendingEmail);
      const key = await this.requireSessionKey();
      if (epoch !== this.sessionEpoch) return;
      console.log("[openchat] generate_magic_link: sending…", email);
      const res = await withTimeout(
        this.sie.generateMagicLink(this.anonymous, email, derPublicKey(key)),
        150_000,
        "generate_magic_link",
      );
      if (epoch !== this.sessionEpoch) return;
      console.log("[openchat] generate_magic_link: result", res.kind);
      if (res.kind === "success") {
        await this.storeForSession(epoch, () => savePendingEmail({
          email,
          userKey: res.userKey,
          expiration: res.expiration,
          code: res.code,
          createdAtMs: Date.now(),
        }));
        if (epoch !== this.sessionEpoch) return;
        this.signIn = { phase: "ready", email, emailSent: true, code: res.code };
      } else if (res.kind === "blocked") {
        this.signIn = { phase: "error", message: `Blocked — try again in ${Number(res.durationMs) / 1000}s` };
      } else if (res.kind === "email_invalid") {
        this.signIn = { phase: "error", message: "Invalid email address" };
      } else {
        this.signIn = { phase: "error", message: res.error };
      }
    } catch (e) {
      if (epoch !== this.sessionEpoch) return;
      // The email may still have been sent; keep the paste box usable and let
      // the completion path wait for the (retried) user_key rather than dying.
      console.error("[openchat] generate_magic_link failed", e);
      this.signIn = { phase: "ready", email, emailSent: false, code: null };
    } finally {
      if (epoch === this.sessionEpoch) this.sending = false;
    }
  }

  signInStatus(): SignInStateVM {
    return this.signIn;
  }

  /**
   * Complete sign-in from the emailed link, pasted into our own UI. The link
   * carries everything handle_magic_link needs (m, s1, s2, and the code c), so
   * this finalizes the delegation without the user visiting the OpenChat site
   * or re-typing the code. The subsequent signInPoll then obtains the session.
   */
  async signInComplete(link: string): Promise<SignInCompleteVM> {
    const query = extractLinkQuery(link);
    if (!query) return { ok: false, message: "That doesn't look like a magic link" };
    // OpenChat's handle_magic_link requires a `c=<code>` param; the emailed link
    // only carries m/s1/s2 and keeps the code inside `m` (the OpenChat web page
    // makes the user type it). We read the code from `m` and append it.
    try {
      const finalQuery = /(^|&)c=/.test(query) ? query : appendCodeFromM(query);
      const res = await this.sie.handleMagicLink(this.anonymous, finalQuery);
      switch (res.kind) {
        case "success":
          return { ok: true, message: null };
        case "link_expired":
          return { ok: false, message: "The link expired — start again" };
        case "code_incorrect":
          return { ok: false, message: "The link's code did not match" };
        default:
          return { ok: false, message: res.message };
      }
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  signInPoll(username?: string): Promise<SignInPollVM> {
    if (this.profile) return Promise.resolve({ status: "logged_in", message: null });
    if (this.signInPollPromise) return this.signInPollPromise;
    const result = this.pollSignIn(username, this.sessionEpoch);
    this.signInPollPromise = result;
    void result.finally(() => {
      if (this.signInPollPromise === result) this.signInPollPromise = null;
    }).catch(() => undefined);
    return result;
  }

  private async pollSignIn(username: string | undefined, epoch: number): Promise<SignInPollVM> {
    const cancelled = (): SignInPollVM => ({ status: "pending", message: "Sign-in changed; use the current sign-in request" });
    const key = await this.requireSessionKey();
    if (epoch !== this.sessionEpoch) return cancelled();

    // Resolve the email delegation into an authenticated OpenChat identity once.
    if (!this.pendingOcIdentity && !this.ocIdentity) {
      const pending = await loadPendingEmail();
      if (epoch !== this.sessionEpoch) return cancelled();
      // generate_magic_link's reply (which carries the user_key) hasn't landed
      // yet; the email may already be in the inbox. Keep waiting on it.
      if (!pending) return { status: "pending", message: "Finishing setup…" };
      if (this.signIn.phase === "ready" && pending.email !== this.signIn.email) {
        return { status: "pending", message: "Finishing setup…" };
      }
      if (nsToMs(pending.expiration) <= Date.now())
        return { status: "expired", message: "The magic link expired" };

      const del = await this.sie.getDelegation(
        this.anonymous,
        pending.email,
        derPublicKey(key),
        pending.expiration,
      );
      if (epoch !== this.sessionEpoch) return cancelled();
      if (del.kind !== "success") return { status: "pending", message: "Waiting for email confirmation" };
      console.log("[openchat] email delegation obtained; minting OpenChat identity");

      const emailIdentity = buildDelegationIdentity(
        key,
        pending.userKey,
        del.delegationPubkey,
        del.expiration,
        del.signature,
      );
      const oc = await this.mintOpenChatIdentity(emailIdentity, key, epoch);
      if (epoch !== this.sessionEpoch) return cancelled();
      if (!oc) return { status: "error", message: "Could not obtain an OpenChat identity" };
      this.pendingOcIdentity = oc.identity;
      this.pendingExpirationMs = oc.expirationMs;
    }

    const authIdentity = this.ocIdentity ?? this.pendingOcIdentity!;

    // Is this OpenChat principal already a registered user?
    const current = await this.userIndex.currentUser(authIdentity);
    if (epoch !== this.sessionEpoch) return cancelled();
    console.log("[openchat] current_user:", variantIs(current, "Success") ? "registered" : variantTag(current) || "none");
    if (variantIs(current, "Success")) {
      await this.finishLogin(authIdentity, this.pendingExpirationMs, current, undefined, epoch);
      if (epoch !== this.sessionEpoch) return cancelled();
      return { status: "logged_in", message: null };
    }
    if (!variantIs(current, "UserNotFound")) {
      return { status: "error", message: responseError(current, "Could not check the OpenChat account") };
    }

    // New account: needs a username to register.
    if (!username) return { status: "pending", message: "username_required" };

    // Registration is asynchronous (the local index creates the user canister),
    // so register_user returns RegistrationInProgress until it finishes. Fire it
    // at most once (retry only after a long stall) and then just poll
    // current_user until it reports the account — never spam register_user.
    const now = Date.now();
    if (this.registrationInitiated && now - this.registrationAt < 60_000) {
      return { status: "pending", message: "Creating your account…" };
    }
    this.registrationInitiated = true;
    this.registrationAt = now;
    const lui = OC_CANISTERS.localUserIndex;
    const ocUserKey = new Uint8Array(authIdentity.getPublicKey().toDer());
    console.log("[openchat] register_user:", username);
    const reg = await this.lui.registerUser(authIdentity, lui, username, ocUserKey);
    if (epoch !== this.sessionEpoch) return cancelled();
    const tag = variantTag(reg);
    console.log("[openchat] register_user result:", tag || "?");
    if (tag === "Success" || tag === "RegistrationInProgress" || tag === "AlreadyRegistered") {
      // Underway or done — the next current_user poll finalizes login.
      return { status: "pending", message: "Creating your account…" };
    }
    this.registrationInitiated = false; // a real failure — allow another attempt
    return { status: "error", message: registerError(reg) };
  }

  private pendingExpirationMs = 0;

  private async mintOpenChatIdentity(
    emailIdentity: DelegationIdentity,
    key: ECDSAKeyIdentity,
    epoch: number,
  ): Promise<{ identity: DelegationIdentity; expirationMs: number } | null> {
    const sessionKeyDer = derPublicKey(key);
    const exists = await this.identityCanister.checkAuthPrincipal(emailIdentity);
    if (epoch !== this.sessionEpoch) return null;
    const publicKeyDer = new Uint8Array(emailIdentity.getPublicKey().toDer());

    const isNew = variantIs(exists, "NotFound");
    if (!isNew && !variantIs(exists, "Success")) {
      throw new Error(responseError(exists, "Could not check the OpenChat identity"));
    }
    console.log("[openchat] identity: existing account =", !isNew);
    const prepared = isNew
      ? await this.identityCanister.createIdentity(emailIdentity, publicKeyDer, sessionKeyDer)
      : await this.identityCanister.prepareDelegation(emailIdentity, sessionKeyDer);
    if (epoch !== this.sessionEpoch) return null;

    if (!variantIs(prepared, "Success")) {
      console.error("[openchat] identity: create/prepare failed:", variantTag(prepared));
      return null;
    }
    const success = variantPayload(prepared, "Success");
    // user_key is serde_bytes (msgpack bin); expiration is u64 which OpenChat
    // serializes as a string (with_large_ints_as_strings), so coerce it.
    const ocUserKey = asBytes(success.user_key);
    const expiration = toBigInt(success.expiration);
    if (!ocUserKey || expiration === null) {
      console.error("[openchat] identity: no user_key/expiration");
      return null;
    }

    const del = await this.identityCanister.getDelegation(emailIdentity, sessionKeyDer, expiration);
    if (epoch !== this.sessionEpoch) return null;
    const dr = variantPayload(del, "Success");
    const inner = rec(dr.delegation);
    const pubkey = asBytes(inner.pubkey);
    const signature = asBytes(dr.signature);
    const delegatedExpiration = toBigInt(inner.expiration);
    if (!pubkey || !signature || delegatedExpiration === null) {
      console.error("[openchat] identity: get_delegation not ready:", variantTag(del));
      return null;
    }

    const identity = buildDelegationIdentity(key, ocUserKey, pubkey, delegatedExpiration, signature);
    console.log("[openchat] identity: minted OC identity", identity.getPrincipal().toText());
    return { identity, expirationMs: nsToMs(delegatedExpiration) };
  }

  private async finishLogin(
    identity: DelegationIdentity,
    expirationMs: number,
    currentUser: Variant,
    fallbackUsername?: string,
    epoch = this.sessionEpoch,
  ): Promise<void> {
    if (epoch !== this.sessionEpoch) return;
    this.ocIdentity = identity;
    this.pendingOcIdentity = null;
    const who = whoAmIFromCurrentUser(currentUser);
    const ocPrincipal = identity.getPrincipal().toText();
    const userId = who.userId ?? ocPrincipal;
    // The user's own canister — equal to userId for ordinary accounts, derived
    // for indexed (shared-canister) ones. All own-canister calls address this.
    const userCanister = userCanisterId(userId);
    // initial_state carries the authoritative local_user_index id.
    let localUserIndex: string = OC_CANISTERS.localUserIndex;
    try {
      const initial = successPayload(await this.user.initialState(identity, userCanister), "Could not load OpenChat chats");
      if (epoch !== this.sessionEpoch) return;
      const lui = principalText(initial.local_user_index_canister_id);
      if (lui) localUserIndex = lui;
      await this.loadChats(initial, userCanister, epoch);
    } catch {
      /* refresh() will retry */
    }
    if (epoch !== this.sessionEpoch) return;
    const avatarUrl = who.avatarUrl ?? null;
    this.profile = {
      ocPrincipal,
      userId,
      username: who.username ?? fallbackUsername ?? "",
      userCanister,
      localUserIndex,
      avatarUrl,
    };
    this.seedSelf();
    // The login is complete the moment the profile is set; persistence is a
    // best-effort convenience and must never block or fail the transition.
    this.storedExpirationMs = expirationMs || Date.now() + 29 * 24 * 60 * 60 * 1000;
    this.startPolling();
    this.bumpRevision();
    try {
      await this.storeForSession(epoch, async () => {
        await saveOcSession({
          chain: identity.getDelegation().toJSON(),
          expirationMs: this.storedExpirationMs,
          profile: { ocPrincipal, userId, username: who.username ?? fallbackUsername ?? "", localUserIndex, avatarUrl },
        });
        await clearPendingEmail();
      });
    } catch (e) {
      console.error("[openchat] persisting session failed (non-fatal)", e);
    }
  }

  /** Re-persist the current session with the latest profile (e.g. after an
   *  avatar change) so it survives a resident restart. Best-effort. */
  private async persistProfile(): Promise<void> {
    if (!this.ocIdentity || !this.profile) return;
    const identity = this.ocIdentity;
    const profile = { ...this.profile };
    const expirationMs = this.storedExpirationMs;
    try {
      await this.storeForSession(this.sessionEpoch, () => saveOcSession({
        chain: identity.getDelegation().toJSON(),
        expirationMs: expirationMs || Date.now() + 29 * 24 * 60 * 60 * 1000,
        profile: {
          ocPrincipal: profile.ocPrincipal,
          userId: profile.userId,
          username: profile.username,
          localUserIndex: profile.localUserIndex,
          avatarUrl: profile.avatarUrl,
        },
      }));
    } catch (e) {
      console.error("[openchat] re-persisting profile failed (non-fatal)", e);
    }
  }

  /**
   * Set the signed-in user's avatar from a data URL (the tile canvas-resizes the
   * upload to a small square JPEG first). Enforces OpenChat's 800KB limit.
   */
  async setAvatar(dataUrl: string): Promise<SetAvatarResultVM> {
    if (!this.profile) return { ok: false, message: "Not signed in" };
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) return { ok: false, message: "That image couldn't be read" };
    if (parsed.bytes.length > 800 * 1024) {
      return { ok: false, message: "Image is too large (max 800KB). Try a smaller one." };
    }
    // 32-bit handle, exactly like OpenChat's own client (a small, cleanly
    // encoded msgpack int for the u128 Document.id); the backend serves /avatar/<id>.
    const id = BigInt(Math.floor(Math.random() * 0xffff_ffff));
    const resp = await this.user.setAvatar(this.ocAuth(), this.profile.userCanister, id, parsed.mime, parsed.bytes);
    const tag = variantTag(resp);
    if (tag !== "Success") {
      const message = tag === "Error" ? ocErrorMessage(variantValue(resp, "Error")) : tag || "Failed to set avatar";
      return { ok: false, message };
    }
    const url = userAvatarUrl(this.profile.userId, id);
    this.profile.avatarUrl = url;
    this.seedSelf();
    await this.persistProfile();
    this.bumpRevision();
    return { ok: true, message: null };
  }

  /** Seed the name/avatar cache with the signed-in user so their own messages
   *  render with their name + avatar (the `users` batch omits self). */
  private seedSelf(): void {
    if (this.profile?.userId) {
      this.userCache.set(this.profile.userId, {
        name: this.profile.username || shortId(this.profile.userId),
        avatarUrl: this.profile.avatarUrl,
      });
    }
  }

  /** Read the editable profile (username + display name + bio + avatar). */
  async getProfile(): Promise<ProfileVM> {
    if (!this.profile) return { username: "", displayName: null, bio: "", avatarUrl: null };
    let displayName: string | null = null;
    let bio = "";
    try {
      const cu = variantPayload(await this.userIndex.currentUser(this.ocAuth()), "Success");
      displayName = typeof cu.display_name === "string" ? cu.display_name : null;
    } catch {
      /* keep null */
    }
    try {
      bio = str(variantValue(await this.user.bio(this.ocAuth(), this.profile.userCanister), "Success"));
    } catch {
      /* keep empty */
    }
    return { username: this.profile.username, displayName, bio, avatarUrl: this.profile.avatarUrl };
  }

  /** Save any changed profile fields. Applies each independently and reports
   *  the specific failures OpenChat returns (e.g. username taken). */
  async saveProfile(fields: { username?: string; displayName?: string | null; bio?: string }): Promise<SaveProfileResultVM> {
    if (!this.profile) return { ok: false, message: "Not signed in" };
    const errors: string[] = [];

    const username = typeof fields.username === "string" ? fields.username.trim() : undefined;
    if (username && username !== this.profile.username) {
      const resp = await this.userIndex.setUsername(this.ocAuth(), username);
      if (variantTag(resp) === "Success") this.profile.username = username;
      else errors.push(usernameError(resp));
    }

    if (fields.displayName !== undefined) {
      const dn = fields.displayName && fields.displayName.trim() ? fields.displayName.trim() : null;
      const resp = await this.userIndex.setDisplayName(this.ocAuth(), dn);
      if (variantTag(resp) !== "Success") errors.push(displayNameError(resp));
    }

    if (fields.bio !== undefined) {
      const resp = await this.user.setBio(this.ocAuth(), this.profile.userCanister, fields.bio);
      if (variantTag(resp) !== "Success") {
        errors.push(variantTag(resp) === "Error" ? ocErrorMessage(variantValue(resp, "Error")) : "Bio is too long (max 2000)");
      }
    }

    this.seedSelf();
    await this.persistProfile();
    this.bumpRevision();
    return errors.length ? { ok: false, message: errors.join("; ") } : { ok: true, message: null };
  }

  async signOut(): Promise<void> {
    const epoch = ++this.sessionEpoch;
    this.ocIdentity = null;
    this.pendingOcIdentity = null;
    this.profile = null;
    this.signIn = { phase: "idle" };
    this.sending = false;
    this.registrationInitiated = false;
    this.pendingExpirationMs = 0;
    this.storedExpirationMs = 0;
    this.signInPollPromise = null;
    this.refreshPromise = null;
    this.chatsLoaded = false;
    this.refreshError = null;
    this.pendingNav = null;
    this.chats = [];
    this.routes.clear();
    this.userCache.clear();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.storeForSession(epoch, async () => {
      await clearOcSession();
      await clearPendingEmail();
    });
    this.bumpRevision();
  }

  private async requireSessionKey(): Promise<ECDSAKeyIdentity> {
    if (!this.sessionKey) this.sessionKey = await loadOrCreateSessionKey();
    return this.sessionKey;
  }

  // -- reads ---------------------------------------------------------------
  refresh(): Promise<void> {
    if (!this.profile) return Promise.resolve();
    if (this.refreshPromise) return this.refreshPromise;
    const epoch = this.sessionEpoch;
    const userCanister = this.profile.userCanister;
    const result = (async () => {
      try {
        const initial = successPayload(
          await this.user.initialState(this.ocAuth(), userCanister),
          "Could not load OpenChat chats",
        );
        if (epoch !== this.sessionEpoch) return;
        await this.loadChats(initial, userCanister, epoch);
        if (epoch !== this.sessionEpoch) return;
        this.refreshError = null;
        this.bumpRevision();
      } catch (error) {
        if (epoch === this.sessionEpoch) this.refreshError = error;
        // Preserve the last snapshot; a later refresh retries. Initial chat
        // readers surface this error instead of reporting an empty account.
      }
    })();
    this.refreshPromise = result;
    void result.finally(() => {
      if (this.refreshPromise === result) this.refreshPromise = null;
    });
    return result;
  }

  /**
   * Build the chat list. initial_state only returns read-state stubs for groups
   * and communities (no name / latest message / event index), so we fetch the
   * full summary from each group and community canister and merge the read
   * markers from the stub. Direct chats already carry full data.
   */
  private async loadChats(initial: Record<string, unknown>, userCanister: string, epoch = this.sessionEpoch): Promise<void> {
    const identity = this.ocAuth();
    const chats: ChatVM[] = [];
    const routes = new Map<ChatId, Route>();
    const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

    const directThem: string[] = [];
    for (const s of list(rec(initial.direct_chats).summaries)) {
      const vm = directChatVM(s);
      const them = principalText(s.them);
      if (!vm || !them) continue;
      chats.push(vm);
      directThem.push(them);
      routes.set(vm.id, {
        kind: "direct",
        them,
        canister: userCanister,
        latestEventIndex: num(s.latest_event_index),
        latestMessageIndex: numOrNull(s.latest_message_index),
      });
    }
    // Resolve the other party's username/avatar so DM rows show a name + face.
    await this.resolveUserNames(directThem, epoch);
    if (epoch !== this.sessionEpoch) return;
    for (const vm of chats) {
      if (vm.kind !== "direct") continue;
      const route = routes.get(vm.id);
      const cached = route && route.kind === "direct" ? this.userCache.get(route.them) : undefined;
      if (cached?.name) vm.title = cached.name;
      if (cached?.avatarUrl) vm.avatarUrl = cached.avatarUrl;
    }

    const groupFulls = await Promise.all(
      list(rec(initial.group_chats).summaries).map((st) => {
        const gid = principalText(st.chat_id);
        return gid
          ? this.group
              .summary(identity, gid)
              // group summary Success is { summary: GroupCanisterGroupChatSummary } — unwrap it.
              .then((r) => ({ gid, stub: st, full: rec(variantPayload(r, "Success").summary) }))
              .catch(() => null)
          : Promise.resolve(null);
      }),
    );
    if (epoch !== this.sessionEpoch) return;
    for (const g of groupFulls) {
      if (!g || Object.keys(g.full).length === 0) continue;
      chats.push({
        id: `group:${g.gid}`,
        kind: "group",
        title: str(g.full.name, shortId(g.gid)),
        subtitle: str(g.full.description) || null,
        lastMessage: messagePreview(g.full.latest_message),
        unread: unreadFrom(g.full.latest_message_index, g.stub.read_by_me_up_to),
        lastUpdatedMs: num(g.full.last_updated),
        avatarUrl: canisterAvatarUrl(g.gid, g.full.avatar_id),
      });
      routes.set(`group:${g.gid}`, {
        kind: "group",
        groupId: g.gid,
        latestEventIndex: num(g.full.latest_event_index),
        latestMessageIndex: numOrNull(g.full.latest_message_index),
      });
    }

    const commFulls = await Promise.all(
      list(rec(initial.communities).summaries).map((st) => {
        const cid = principalText(st.community_id);
        return cid
          ? this.community
              .summary(identity, cid)
              .then((r) => ({ cid, stub: st, full: variantPayload(r, "Success") }))
              .catch(() => null)
          : Promise.resolve(null);
      }),
    );
    if (epoch !== this.sessionEpoch) return;
    for (const c of commFulls) {
      if (!c || Object.keys(c.full).length === 0) continue;
      const communityName = str(c.full.name, shortId(c.cid));
      const communityAvatar = canisterAvatarUrl(c.cid, c.full.avatar_id);
      const readBy = new Map<number, unknown>();
      for (const st of list(c.stub.channels)) readBy.set(num(st.channel_id), st.read_by_me_up_to);
      const channels = list(c.full.channels);
      const primaryId = pickPrimaryChannel(channels);
      for (const ch of channels) {
        const channelId = num(ch.channel_id);
        const channelName = str(ch.name, String(channelId));
        const id = `channel:${c.cid}:${channelId}`;
        chats.push({
          id,
          kind: "channel",
          title: `${communityName} › ${channelName}`,
          subtitle: str(ch.description) || null,
          lastMessage: messagePreview(ch.latest_message),
          unread: unreadFrom(ch.latest_message_index, readBy.get(channelId)),
          lastUpdatedMs: num(ch.last_updated),
          avatarUrl: communityAvatar,
          communityId: c.cid,
          communityName,
          channelName,
          primaryChannel: channelId === primaryId,
        });
        routes.set(id, {
          kind: "channel",
          communityId: c.cid,
          channelId,
          latestEventIndex: num(ch.latest_event_index),
          latestMessageIndex: numOrNull(ch.latest_message_index),
        });
      }
    }

    chats.sort((a, b) => b.lastUpdatedMs - a.lastUpdatedMs);
    this.chats = chats;
    this.routes = routes;
    this.chatsLoaded = true;
  }

  listChats(): ChatVM[] {
    return this.chats;
  }

  /** Mark every chat read (clears all unread indicators). Sets each chat's read
   *  marker to its latest message in one user-canister mark_read call. */
  async markAllRead(): Promise<{ ok: boolean; message: string | null }> {
    if (!this.profile) return { ok: false, message: "Not signed in" };
    const chats: { chatId: string; readUpTo: number }[] = [];
    const commMap = new Map<string, { channelId: number; readUpTo: number }[]>();
    for (const route of this.routes.values()) {
      if (route.latestMessageIndex === null) continue; // no messages → nothing to read
      if (route.kind === "direct") {
        chats.push({ chatId: route.them, readUpTo: route.latestMessageIndex });
      } else if (route.kind === "group") {
        chats.push({ chatId: route.groupId, readUpTo: route.latestMessageIndex });
      } else {
        const arr = commMap.get(route.communityId) ?? [];
        arr.push({ channelId: route.channelId, readUpTo: route.latestMessageIndex });
        commMap.set(route.communityId, arr);
      }
    }
    const communities = [...commMap].map(([communityId, channels]) => ({ communityId, channels }));
    if (chats.length === 0 && communities.length === 0) return { ok: true, message: null };
    try {
      await this.user.markRead(this.ocAuth(), this.profile.userCanister, chats, communities);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    // Optimistically clear the badges now; the next refresh reconciles.
    this.chats = this.chats.map((c) => (c.unread > 0 ? { ...c, unread: 0 } : c));
    this.bumpRevision();
    void this.refresh();
    return { ok: true, message: null };
  }

  /**
   * Populate the username cache for any ids we don't already know, in one
   * batched user_index `users` call. Cheap (a query), and cached so repeated
   * refreshes and message loads don't re-fetch known users.
   */
  private async resolveUserNames(ids: string[], epoch = this.sessionEpoch): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => id && !this.userCache.has(id));
    if (missing.length === 0) return;
    try {
      const resp = await this.userIndex.usersByPrincipal(
        this.readIdentity(),
        missing.map((id) => Principal.fromText(id)),
      );
      if (epoch !== this.sessionEpoch) return;
      for (const u of parseUserSummariesV2(resp)) {
        this.userCache.set(u.userId, { name: u.displayName || u.username, avatarUrl: u.avatarUrl });
      }
    } catch {
      /* names/avatars are a nicety; ids remain as fallback */
    }
  }

  async readMessages(chatId: ChatId, limit = 50): Promise<MessageVM[]> {
    const route = this.routes.get(chatId);
    if (!route) throw new Error("Unknown OpenChat chat");
    const myUserId = this.profile?.userId ?? null;
    const start = Math.max(0, route.latestEventIndex);
    let resp: Variant;
    if (route.kind === "direct") {
      resp = await this.user.events(
        this.ocAuth(),
        route.canister,
        Principal.fromText(route.them),
        start,
        false,
        limit,
      );
    } else if (route.kind === "group") {
      resp = await this.group.eventsByIndex(this.ocAuth(), route.groupId, start, false, limit);
    } else {
      resp = await this.transport.msgpackQuery(
        route.communityId,
        "events",
        {
          channel_id: route.channelId,
          thread_root_message_index: null,
          start_index: start,
          ascending: false,
          max_messages: limit,
          max_events: limit * 2,
          latest_known_update: null,
        },
        this.ocAuth(),
      );
    }
    const success = successPayload(resp, "Could not read OpenChat messages");
    const events = Array.isArray(success.events) ? success.events : [];
    const list = messagesFromEvents(events, myUserId);
    list.sort((a, b) => a.index - b.index);
    // Fill in sender display names + avatars (cached + batched).
    await this.resolveUserNames(list.map((m) => m.senderId));
    for (const m of list) {
      const cached = this.userCache.get(m.senderId);
      if (cached) {
        m.senderName = cached.name;
        m.senderAvatarUrl = cached.avatarUrl;
      }
    }
    return list;
  }

  async search(term: string): Promise<UserVM[]> {
    const resp = successPayload(await this.userIndex.search(this.ocAuth(), term, 10), "Could not search OpenChat users");
    const users = Array.isArray(resp.users) ? resp.users : [];
    const out: UserVM[] = [];
    for (const raw of users) {
      const u = rec(raw);
      const userId = principalText(u.user_id);
      if (!userId) continue;
      out.push({
        userId,
        username: str(u.username, userId),
        displayName: typeof u.display_name === "string" ? u.display_name : null,
      });
    }
    return out;
  }

  // -- discovery (public directory; works for the user and the agent) ------
  async exploreCommunities(term?: string): Promise<DirectoryEntryVM[]> {
    const resp = successPayload(
      await this.groupIndex.exploreCommunities(this.readIdentity(), term?.trim() || null, 0, 25),
      "Could not explore OpenChat communities",
    );
    return directoryEntries(resp.matches, "community");
  }

  async exploreGroups(term?: string): Promise<DirectoryEntryVM[]> {
    const resp = successPayload(
      await this.groupIndex.exploreGroups(this.readIdentity(), term?.trim() || null, 0, 25),
      "Could not explore OpenChat groups",
    );
    return directoryEntries(resp.matches, "group");
  }

  private readIdentity(): Identity {
    return this.ocIdentity ?? this.anonymous;
  }

  // -- writes --------------------------------------------------------------
  /**
   * Send to a chat. Some groups/communities require accepting their rules
   * before a member can post; when that's the case and `acceptRules` is false
   * (the default), we don't post — we return `rules_required` with the rules
   * text so the UI/agent can show it and resend with `acceptRules = true`,
   * which passes the current rules version(s) that OpenChat records as accepted.
   */
  async sendMessage(chatId: ChatId, text: string, acceptRules = false): Promise<SendResultVM> {
    const epoch = this.sessionEpoch;
    const route = this.routes.get(chatId);
    const messageId = randomMessageId();
    const idText = messageId.toString();
    if (!route) return { kind: "error", messageId: idText, message: "Unknown chat" };
    if (!this.profile) return { kind: "error", messageId: idText, message: "Not signed in" };

    const rules = acceptRules && route.kind !== "direct" ? await this.fetchRules(route).catch(() => null) : null;
    if (epoch !== this.sessionEpoch || !this.profile) {
      return { kind: "error", messageId: idText, message: "The signed-in account changed; no message was sent" };
    }
    const resp = await this.doSend(route, messageId, text, rules);

    // The chat gates posting on rules acceptance: surface them for an explicit
    // accept rather than silently accepting on the user's behalf.
    if (!acceptRules && route.kind !== "direct" && isRulesNotAccepted(resp)) {
      const info = await this.fetchRules(route).catch(() => null);
      return {
        kind: "rules_required",
        messageId: idText,
        message: "This chat requires accepting its rules before you can post.",
        rulesText: info?.text || null,
      };
    }
    const outcome = classifySend(resp, idText);
    if (outcome.kind === "sent") void this.refresh();
    return outcome;
  }

  private doSend(route: Route, messageId: bigint, text: string, rules: RulesInfo | null): Promise<Variant> {
    const username = this.profile!.username;
    if (route.kind === "direct") {
      return this.user.sendMessageV2(this.ocAuth(), this.profile!.userCanister, Principal.fromText(route.them), messageId, text);
    }
    if (route.kind === "group") {
      return this.group.sendMessageV2(this.ocAuth(), route.groupId, messageId, text, username, null, rules?.groupVersion ?? null);
    }
    return this.community.sendMessage(
      this.ocAuth(),
      route.communityId,
      route.channelId,
      messageId,
      text,
      username,
      null,
      rules?.communityVersion ?? null,
      rules?.channelVersion ?? null,
    );
  }

  /** Fetch a chat's rules text and current version(s) for acceptance-on-send. */
  private async fetchRules(route: Route): Promise<RulesInfo> {
    const rulesOf = (payload: Record<string, unknown>): { text: string; version: number } => {
      const cr = rec(payload.chat_rules);
      return { text: str(cr.text), version: num(cr.version) };
    };
    if (route.kind === "group") {
      const r = rulesOf(variantPayload(await this.group.selectedInitial(this.ocAuth(), route.groupId), "Success"));
      return { text: r.text, groupVersion: r.version, communityVersion: null, channelVersion: null };
    }
    if (route.kind === "channel") {
      const [chResp, comResp] = await Promise.all([
        this.community.selectedChannelInitial(this.ocAuth(), route.communityId, route.channelId),
        this.community.selectedInitial(this.ocAuth(), route.communityId),
      ]);
      const ch = rulesOf(variantPayload(chResp, "Success"));
      const com = rulesOf(variantPayload(comResp, "Success"));
      const text = [com.text, ch.text].filter((t) => t.trim()).join("\n\n");
      return { text, groupVersion: null, communityVersion: com.version, channelVersion: ch.version };
    }
    return { text: "", groupVersion: null, communityVersion: null, channelVersion: null };
  }

  async dmUser(usernameOrPrincipal: string, text: string): Promise<SendResultVM> {
    if (!this.profile) return { kind: "error", messageId: "0", message: "Not signed in" };
    const target = usernameOrPrincipal.trim().replace(/^@/, "");
    const epoch = this.sessionEpoch;
    let principal = target;
    if (!looksLikePrincipal(target)) {
      const results = await this.search(target);
      const match = results.find((u) => u.username.toLowerCase() === target.toLowerCase());
      if (!match) return { kind: "error", messageId: "0", message: "No exact username match. Search users and choose the intended recipient." };
      principal = match.userId;
    }
    if (epoch !== this.sessionEpoch || !this.profile) {
      return { kind: "error", messageId: "0", message: "The signed-in account changed; no message was sent" };
    }
    const messageId = randomMessageId();
    const resp = await this.user.sendMessageV2(
      this.ocAuth(),
      this.profile.userCanister,
      Principal.fromText(principal),
      messageId,
      text,
    );
    const outcome = classifySend(resp, messageId.toString());
    if (outcome.kind === "sent") void this.refresh();
    return outcome;
  }

  async joinGroup(groupId: string): Promise<JoinResultVM> {
    if (!this.profile) return { kind: "error", message: "Not signed in" };
    // A join is routed through the local_user_index that hosts the *target*
    // group (the one it trusts), discovered from the group canister itself —
    // not the user's own index.
    const lui = principalText(variantValue(await this.group.localUserIndex(this.ocAuth(), groupId), "Success"));
    if (!lui) return { kind: "not_found", message: "Couldn't resolve that group" };
    const resp = await this.lui.joinGroup(this.ocAuth(), lui, groupId);
    const outcome = classifyJoin(resp);
    if (outcome.kind === "joined") void this.refresh();
    return outcome;
  }

  async joinCommunity(communityId: string): Promise<JoinResultVM> {
    if (!this.profile) return { kind: "error", message: "Not signed in" };
    const lui = principalText(
      variantValue(await this.community.localUserIndex(this.ocAuth(), communityId), "Success"),
    );
    if (!lui) return { kind: "not_found", message: "Couldn't resolve that community" };
    const resp = await this.lui.joinCommunity(this.ocAuth(), lui, communityId);
    const outcome = classifyJoin(resp);
    if (outcome.kind === "joined") void this.refresh();
    return outcome;
  }
}

// ---- helpers ----
/** Decode a `data:image/...;base64,...` URL into its mime type and raw bytes. */
function parseImageDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl.trim());
  if (!m) return null;
  const mime = m[1] || "image/jpeg";
  const isBase64 = !!m[2];
  const payload = m[3] ?? "";
  try {
    if (isBase64) {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { mime, bytes };
    }
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/** Pull the `m/s1/s2/c` query string out of a pasted magic link (URL or bare). */
function extractLinkQuery(link: string): string | null {
  const trimmed = link.trim();
  if (!trimmed) return null;
  const qIdx = trimmed.indexOf("?");
  let q = qIdx >= 0 ? trimmed.slice(qIdx + 1) : trimmed;
  const hIdx = q.indexOf("#");
  if (hIdx >= 0) q = q.slice(0, hIdx);
  if (!/(^|&)m=/.test(q) || !/(^|&)s1=/.test(q)) return null;
  return q;
}

function queryParam(query: string, key: string): string | null {
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    if (decodeURIComponent(k) === key) {
      return eq >= 0 ? decodeURIComponent(pair.slice(eq + 1)) : "";
    }
  }
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** Read the 3-digit `code` out of the link's `m` payload and append `&c=<code>`. */
function appendCodeFromM(query: string): string {
  const mHex = queryParam(query, "m");
  if (!mHex) return query;
  try {
    const m = decodeMsgpack<{ code?: unknown }>(hexToBytes(mHex));
    const code = typeof m.code === "string" ? m.code : null;
    if (code) return `${query}&c=${encodeURIComponent(code)}`;
  } catch {
    /* fall through — handle_magic_link will report the missing code */
  }
  return query;
}

function directoryEntries(matches: unknown, kind: "community" | "group"): DirectoryEntryVM[] {
  if (!Array.isArray(matches)) return [];
  const out: DirectoryEntryVM[] = [];
  for (const raw of matches) {
    const m = rec(raw);
    const id = principalText(m.id);
    if (!id) continue;
    const gate = kind === "community" ? m.gate_config : m.gate;
    out.push({
      id,
      kind,
      name: str(m.name, id),
      description: str(m.description),
      members: num(m.member_count),
      channels: kind === "community" ? num(m.channel_count) : null,
      gated: gate !== null && gate !== undefined && !(Array.isArray(gate) && gate.length === 0),
      verified: m.verified === true,
    });
  }
  return out;
}

function looksLikePrincipal(v: string): boolean {
  try {
    return Principal.fromText(v).toText() === v;
  } catch {
    return false;
  }
}

function responseError(response: Variant, fallback: string): string {
  const tag = variantTag(response);
  return tag === "Error" ? ocErrorMessage(variantValue(response, "Error")) : tag || fallback;
}

function successPayload(response: Variant, fallback: string): Record<string, unknown> {
  if (!variantIs(response, "Success")) throw new Error(responseError(response, fallback));
  return variantPayload(response, "Success");
}
// Human-friendly text for OpenChat's named join/send failure variants.
const JOIN_TAG_TEXT: Record<string, string> = {
  GroupNotPublic: "This group isn't public — you need an invite",
  ChatNotPublic: "This chat isn't public — you need an invite",
  CommunityNotPublic: "This community isn't public — you need an invite",
  NotInvited: "You need an invite to join",
  Blocked: "You're blocked from this group",
  UserBlocked: "You're blocked from this community",
  UserSuspended: "Your account is suspended",
  ChatFrozen: "This group is frozen",
  CommunityFrozen: "This community is frozen",
  ParticipantLimitReached: "This group is full",
  MemberLimitReached: "This community is full",
  InternalError: "OpenChat internal error — try again",
};

function usernameError(resp: Variant): string {
  switch (variantTag(resp)) {
    case "UsernameTaken":
      return "That username is already taken";
    case "UsernameInvalid":
      return "That username isn't allowed";
    case "UsernameTooShort":
      return "Username is too short (min 5)";
    case "UsernameTooLong":
      return "Username is too long (max 20)";
    case "Error":
      return ocErrorMessage(variantValue(resp, "Error"));
    default:
      return "Couldn't change username";
  }
}
function displayNameError(resp: Variant): string {
  switch (variantTag(resp)) {
    case "DisplayNameInvalid":
      return "That display name isn't allowed";
    case "DisplayNameTooShort":
      return "Display name is too short (min 3)";
    case "DisplayNameTooLong":
      return "Display name is too long (max 25)";
    case "Error":
      return ocErrorMessage(variantValue(resp, "Error"));
    default:
      return "Couldn't change display name";
  }
}
function registerError(resp: Variant): string {
  const tag = variantTag(resp);
  if (tag === "Error") return ocErrorMessage(variantValue(resp, "Error"));
  return JOIN_TAG_TEXT[tag] ?? tag ?? "registration failed";
}
/** True when a send failed specifically because chat/community rules are unaccepted. */
function isRulesNotAccepted(resp: Variant): boolean {
  if (variantTag(resp) !== "Error") return false;
  const code = ocErrorCode(variantValue(resp, "Error"));
  return code === CHAT_RULES_NOT_ACCEPTED_CODE || code === COMMUNITY_RULES_NOT_ACCEPTED_CODE;
}
function classifySend(resp: Variant, messageId: string): SendResultVM {
  const tag = variantTag(resp);
  if (tag === "Success") return { kind: "sent", messageId, message: null };
  if (tag === "Error") {
    const err = variantValue(resp, "Error");
    // A resend of the same message_id comes back as OCError 287, not a variant.
    if (ocErrorCode(err) === MESSAGE_ID_EXISTS_CODE)
      return { kind: "duplicate", messageId, message: "already delivered" };
    return { kind: "error", messageId, message: ocErrorMessage(err) };
  }
  return { kind: "error", messageId, message: JOIN_TAG_TEXT[tag] ?? tag ?? "send failed" };
}
function classifyJoin(resp: Variant): JoinResultVM {
  const tag = variantTag(resp);
  switch (tag) {
    case "Success":
      return { kind: "joined", message: null };
    case "AlreadyInGroup":
    case "AlreadyInGroupV2":
    case "AlreadyInCommunity":
      return { kind: "already_member", message: null };
    case "GateCheckFailed":
      return { kind: "gate_blocked", message: "This one has a membership gate you can't satisfy (e.g. Diamond)" };
    case "GroupNotFound":
    case "CommunityNotFound":
      return { kind: "not_found", message: "Not found" };
    case "Error": {
      const err = variantValue(resp, "Error");
      // Some gate/diamond failures come back as OCError codes.
      if (ocErrorCode(err) === 253)
        return { kind: "gate_blocked", message: "Requires Diamond membership" };
      return { kind: "error", message: ocErrorMessage(err) };
    }
    default:
      return { kind: "error", message: JOIN_TAG_TEXT[tag] ?? tag ?? "Couldn't join" };
  }
}
