import {
  AnonymousIdentity,
  HttpAgent,
  QueryResponseStatus,
  polling,
  type Identity,
} from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { OC_BOUNDARY_HOST } from "./constants.ts";
import { decodeMsgpack, encodeMsgpack } from "./msgpack.ts";

/**
 * Low-level transport to OpenChat's mainnet canisters.
 *
 * Every call is an ordinary IC ingress signed by an app-held identity — the
 * anonymous identity for public/auth-bootstrap calls, or the logged-in OpenChat
 * delegation for authenticated calls. Nothing here touches the Neutron backend
 * or the kernel call-approval dialog: this is the wagyu/blast "the app holds its
 * own key and calls canisters directly" pattern.
 *
 * `_msgpack` endpoints read raw msgpack argument bytes and reply with raw
 * msgpack bytes (ic_cdk `encode_with`/`decode_with`), so there is no Candid
 * envelope: we send the encoded value as the raw `arg` and decode the raw reply.
 */
export class OcTransport {
  private agent: HttpAgent | null = null;
  private readonly anonymous = new AnonymousIdentity();
  // Updates poll request_status via read_state, which the replica requires to be
  // signed by the same principal that submitted the call. We therefore set the
  // agent identity for the update and serialize updates so two of them can't
  // interleave their identity between call and poll. Queries are single requests
  // and pass their identity per-call, so they need neither.
  private updateChain: Promise<unknown> = Promise.resolve();

  private runUpdate<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.updateChain.then(fn, fn);
    this.updateChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private getAgentSync(): HttpAgent {
    if (this.agent) return this.agent;
    // Built synchronously and configured like OpenChat's own web client: the
    // async `HttpAgent.create` does a time-sync round trip and query-signature
    // verification fetches subnet keys, both of which can stall against the
    // public boundary. `createSync` uses the built-in IC mainnet root key and
    // the local clock, which is what OpenChat relies on.
    this.agent = HttpAgent.createSync({
      host: OC_BOUNDARY_HOST,
      identity: this.anonymous,
      shouldFetchRootKey: false,
      verifyQuerySignatures: false,
    });
    return this.agent;
  }

  private getAgent(): Promise<HttpAgent> {
    return Promise.resolve(this.getAgentSync());
  }

  /** Warm the agent up front so first-call latency is not on the UI path. */
  async ready(): Promise<void> {
    await this.getAgent();
  }

  async msgpackQuery<T = unknown>(
    canisterId: string,
    method: string,
    args: unknown,
    identity: Identity = this.anonymous,
  ): Promise<T> {
    const agent = await this.getAgent();
    const response = await agent.query(
      Principal.fromText(canisterId),
      { methodName: `${method}_msgpack`, arg: encodeMsgpack(args) },
      identity,
    );
    if (response.status !== QueryResponseStatus.Replied) {
      throw new OcRejectError(
        method,
        response.reject_code,
        response.reject_message,
      );
    }
    return decodeMsgpack<T>(new Uint8Array(response.reply.arg));
  }

  msgpackUpdate<T = unknown>(
    canisterId: string,
    method: string,
    args: unknown,
    identity: Identity,
  ): Promise<T> {
    return this.runUpdate(async () => {
      const agent = await this.getAgent();
      agent.replaceIdentity(identity);
      const canister = Principal.fromText(canisterId);
      const { requestId, response } = await agent.call(canister, {
        methodName: `${method}_msgpack`,
        arg: encodeMsgpack(args),
        effectiveCanisterId: canister,
        callSync: false,
      });
      if (response.status >= 400) {
        throw new OcRejectError(method, response.status, response.statusText);
      }
      const { reply } = await polling.pollForResponse(agent, canister, requestId);
      return decodeMsgpack<T>(new Uint8Array(reply));
    });
  }

  /**
   * Candid update via explicit submit + poll (never the sync-call endpoint), so
   * a slow update — e.g. sign_in_with_email.generate_magic_link, which makes an
   * HTTPS outcall to send the email — is polled to completion (up to 5 min)
   * rather than depending on the Actor layer's sync-call handling.
   */
  candidUpdate(
    canisterId: string,
    method: string,
    argTypes: IDL.Type[],
    args: unknown[],
    resultTypes: IDL.Type[],
    identity: Identity = this.anonymous,
  ): Promise<unknown[]> {
    return this.runUpdate(async () => {
      const agent = await this.getAgent();
      agent.replaceIdentity(identity);
      const canister = Principal.fromText(canisterId);
      const arg = new Uint8Array(IDL.encode(argTypes, args));
      const { requestId, response } = await agent.call(canister, {
        methodName: method,
        arg,
        effectiveCanisterId: canister,
        callSync: false,
      });
      if (response.status >= 400) {
        throw new OcRejectError(method, response.status, response.statusText);
      }
      const { reply } = await polling.pollForResponse(agent, canister, requestId);
      return IDL.decode(resultTypes, new Uint8Array(reply));
    });
  }

  async candidQuery(
    canisterId: string,
    method: string,
    argTypes: IDL.Type[],
    args: unknown[],
    resultTypes: IDL.Type[],
    identity: Identity = this.anonymous,
  ): Promise<unknown[]> {
    const agent = await this.getAgent();
    const arg = new Uint8Array(IDL.encode(argTypes, args));
    const response = await agent.query(
      Principal.fromText(canisterId),
      { methodName: method, arg },
      identity,
    );
    if (response.status !== QueryResponseStatus.Replied) {
      throw new OcRejectError(method, response.reject_code, response.reject_message);
    }
    return IDL.decode(resultTypes, new Uint8Array(response.reply.arg));
  }
}

export class OcRejectError extends Error {
  constructor(
    readonly method: string,
    readonly code: unknown,
    readonly rejectMessage?: string,
  ) {
    super(`OpenChat ${method} rejected: ${rejectMessage ?? String(code)}`);
    this.name = "OcRejectError";
  }
}
