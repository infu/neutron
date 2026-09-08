import type { Identity } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { OC_CANISTERS } from "./constants.ts";
import type { OcTransport } from "./transport.ts";

// Candid interface for the OpenChat sign-in-with-email canister, authored from
// the OpenChat api crate (interface facts, not copied source). Calls go through
// the transport's explicit submit+poll so the slow generate_magic_link update
// (which sends the email via an HTTPS outcall) reliably completes.

const generateMagicLinkArgs = IDL.Record({
  email: IDL.Text,
  session_key: IDL.Vec(IDL.Nat8),
  max_time_to_live: IDL.Opt(IDL.Nat64),
});
const generateMagicLinkResponse = IDL.Variant({
  Success: IDL.Record({
    created: IDL.Nat64,
    user_key: IDL.Vec(IDL.Nat8),
    expiration: IDL.Nat64,
    code: IDL.Text,
  }),
  Blocked: IDL.Nat64,
  EmailInvalid: IDL.Null,
  FailedToSendEmail: IDL.Text,
});

const delegation = IDL.Record({ pubkey: IDL.Vec(IDL.Nat8), expiration: IDL.Nat64 });
const signedDelegation = IDL.Record({ delegation, signature: IDL.Vec(IDL.Nat8) });
const getDelegationArgs = IDL.Record({
  email: IDL.Text,
  session_key: IDL.Vec(IDL.Nat8),
  expiration: IDL.Nat64,
});
const getDelegationResponse = IDL.Variant({ Success: signedDelegation, NotFound: IDL.Null });

const handleMagicLinkArgs = IDL.Record({ link: IDL.Text });
const handleMagicLinkResponse = IDL.Variant({
  Success: IDL.Null,
  LinkExpired: IDL.Null,
  LinkInvalid: IDL.Text,
  CodeIncorrect: IDL.Null,
});

const bytes = (v: unknown): Uint8Array =>
  v instanceof Uint8Array ? v : Uint8Array.from(v as number[]);

export type GenerateMagicLinkResult =
  | { kind: "success"; userKey: Uint8Array; expiration: bigint; code: string }
  | { kind: "blocked"; durationMs: bigint }
  | { kind: "email_invalid" }
  | { kind: "failed_to_send"; error: string };

export type GetEmailDelegationResult =
  | { kind: "success"; delegationPubkey: Uint8Array; expiration: bigint; signature: Uint8Array }
  | { kind: "not_found" };

export type HandleMagicLinkResult =
  | { kind: "success" }
  | { kind: "link_expired" }
  | { kind: "link_invalid"; message: string }
  | { kind: "code_incorrect" };

export class SignInWithEmailClient {
  constructor(private readonly transport: OcTransport) {}

  private get id(): string {
    return OC_CANISTERS.signInWithEmail;
  }

  async generateMagicLink(
    identity: Identity,
    email: string,
    sessionKeyDer: Uint8Array,
  ): Promise<GenerateMagicLinkResult> {
    const [resp] = await this.transport.candidUpdate(
      this.id,
      "generate_magic_link",
      [generateMagicLinkArgs],
      [{ email, session_key: sessionKeyDer, max_time_to_live: [] }],
      [generateMagicLinkResponse],
      identity,
    );
    const v = resp as Record<string, unknown>;
    if ("Success" in v) {
      const s = v.Success as { user_key: unknown; expiration: bigint; code: string };
      return { kind: "success", userKey: bytes(s.user_key), expiration: s.expiration, code: s.code };
    }
    if ("Blocked" in v) return { kind: "blocked", durationMs: v.Blocked as bigint };
    if ("FailedToSendEmail" in v) return { kind: "failed_to_send", error: String(v.FailedToSendEmail) };
    return { kind: "email_invalid" };
  }

  async getDelegation(
    identity: Identity,
    email: string,
    sessionKeyDer: Uint8Array,
    expiration: bigint,
  ): Promise<GetEmailDelegationResult> {
    const [resp] = await this.transport.candidQuery(
      this.id,
      "get_delegation",
      [getDelegationArgs],
      [{ email, session_key: sessionKeyDer, expiration }],
      [getDelegationResponse],
      identity,
    );
    const v = resp as Record<string, unknown>;
    if ("Success" in v) {
      const s = v.Success as {
        delegation: { pubkey: unknown; expiration: bigint };
        signature: unknown;
      };
      return {
        kind: "success",
        delegationPubkey: bytes(s.delegation.pubkey),
        expiration: s.delegation.expiration,
        signature: bytes(s.signature),
      };
    }
    return { kind: "not_found" };
  }

  async handleMagicLink(identity: Identity, linkQuery: string): Promise<HandleMagicLinkResult> {
    const [resp] = await this.transport.candidUpdate(
      this.id,
      "handle_magic_link",
      [handleMagicLinkArgs],
      [{ link: linkQuery }],
      [handleMagicLinkResponse],
      identity,
    );
    const v = resp as Record<string, unknown>;
    if ("Success" in v) return { kind: "success" };
    if ("LinkExpired" in v) return { kind: "link_expired" };
    if ("CodeIncorrect" in v) return { kind: "code_incorrect" };
    return { kind: "link_invalid", message: String((v as { LinkInvalid?: unknown }).LinkInvalid ?? "invalid link") };
  }
}
