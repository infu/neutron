import {
  isV2ResponseBody,
  pollForResponse,
  RejectError,
  UncertifiedRejectUpdateErrorCode,
  UnexpectedErrorCode,
  UnknownError,
  type Agent,
  type RequestId,
} from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { submitPollingUpdate } from "./polling_update_agent.ts";

type RawUpdatePoll = (
  agent: Agent,
  canisterId: Principal,
  requestId: RequestId,
) => Promise<{ reply: Uint8Array }>;

type RawUpdateDependencies = {
  poll?: RawUpdatePoll;
};

/**
 * Submit an update using already-encoded Candid and return its certified raw
 * reply. This deliberately stops below Actor.createActor: callers must meter
 * the raw reply before passing it to IDL.decode.
 */
export async function submitRawSelfUpdate(
  agent: Agent,
  canisterId: string | Principal,
  methodName: string,
  arg: Uint8Array,
  dependencies: RawUpdateDependencies = {},
): Promise<Uint8Array> {
  const canister = Principal.from(canisterId);
  const submitted = await submitPollingUpdate(agent, canister, {
    methodName,
    arg,
    effectiveCanisterId: canister,
  });
  const { requestId, response } = submitted;
  if (isV2ResponseBody(response.body)) {
    throw RejectError.fromCode(
      new UncertifiedRejectUpdateErrorCode(
        requestId,
        response.body.reject_code,
        response.body.reject_message,
        response.body.error_code,
      ),
    );
  }
  if (response.status !== 202) {
    throw UnknownError.fromCode(
      new UnexpectedErrorCode(
        `Asynchronous update returned unexpected HTTP status ${response.status}`,
      ),
    );
  }
  const reply = (
    await (dependencies.poll ?? pollForResponse)(agent, canister, requestId)
  ).reply;
  if (reply === undefined) {
    throw UnknownError.fromCode(
      new UnexpectedErrorCode(
        "Update call settled without a certified reply; the outcome is unknown",
      ),
    );
  }
  return reply;
}
