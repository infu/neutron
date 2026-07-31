import {
  Certificate,
  CertifiedRejectErrorCode,
  ExternalError,
  isV2ResponseBody,
  isV3ResponseBody,
  lookupResultToBuffer,
  MissingRootKeyErrorCode,
  pollForResponse,
  RejectError,
  RequestStatusResponseStatus,
  UncertifiedRejectUpdateErrorCode,
  UnexpectedErrorCode,
  UnknownError,
  type Agent,
  type RequestId,
} from "@dfinity/agent";
import { Principal } from "@dfinity/principal";

type RawUpdatePoll = (
  agent: Agent,
  canisterId: Principal,
  requestId: RequestId,
) => Promise<{ reply: Uint8Array }>;

type RawUpdateDependencies = {
  poll?: RawUpdatePoll;
  createCertificate?: (
    options: Parameters<typeof Certificate.create>[0],
  ) => Promise<Pick<Certificate, "lookup_path">>;
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
  const submitted = await agent.call(canister, {
    methodName,
    arg,
    effectiveCanisterId: canister,
  });
  const { requestId, response } = submitted;
  let reply: Uint8Array | undefined;

  if (isV3ResponseBody(response.body)) {
    if (agent.rootKey === null) {
      throw ExternalError.fromCode(new MissingRootKeyErrorCode());
    }
    const certificate = await (
      dependencies.createCertificate ?? Certificate.create
    )({
      certificate: response.body.certificate,
      rootKey: agent.rootKey,
      canisterId: canister,
      agent,
    });
    const path = [
      new TextEncoder().encode("request_status"),
      requestId,
    ] as const;
    const encodedStatus = lookupResultToBuffer(
      certificate.lookup_path([...path, "status"]),
    );
    const status =
      encodedStatus === undefined
        ? RequestStatusResponseStatus.Unknown
        : new TextDecoder().decode(encodedStatus);
    if (status === RequestStatusResponseStatus.Replied) {
      reply = lookupResultToBuffer(
        certificate.lookup_path([...path, "reply"]),
      );
      if (reply === undefined) {
        throw UnknownError.fromCode(
          new UnexpectedErrorCode(
            "Certified update status was replied without reply bytes",
          ),
        );
      }
    } else if (status === RequestStatusResponseStatus.Rejected) {
      const rejectCodeBytes = lookupResultToBuffer(
        certificate.lookup_path([...path, "reject_code"]),
      );
      const rejectMessageBytes = lookupResultToBuffer(
        certificate.lookup_path([...path, "reject_message"]),
      );
      if (
        rejectCodeBytes === undefined ||
        rejectCodeBytes.byteLength !== 1 ||
        rejectMessageBytes === undefined
      ) {
        throw UnknownError.fromCode(
          new UnexpectedErrorCode(
            "Certified update rejection omitted required fields",
          ),
        );
      }
      const errorCodeBytes = lookupResultToBuffer(
        certificate.lookup_path([...path, "error_code"]),
      );
      throw RejectError.fromCode(
        new CertifiedRejectErrorCode(
          requestId,
          rejectCodeBytes[0]!,
          new TextDecoder().decode(rejectMessageBytes),
          errorCodeBytes === undefined
            ? undefined
            : new TextDecoder().decode(errorCodeBytes),
        ),
      );
    }
  } else if (isV2ResponseBody(response.body)) {
    throw RejectError.fromCode(
      new UncertifiedRejectUpdateErrorCode(
        requestId,
        response.body.reject_code,
        response.body.reject_message,
        response.body.error_code,
      ),
    );
  }

  if (response.status === 202) {
    reply = (
      await (dependencies.poll ?? pollForResponse)(
        agent,
        canister,
        requestId,
      )
    ).reply;
  }
  if (reply === undefined) {
    throw UnknownError.fromCode(
      new UnexpectedErrorCode(
        "Update call settled without a certified reply; the outcome is unknown",
      ),
    );
  }
  return reply;
}
