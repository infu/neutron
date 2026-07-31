import {
  createMsgBusClient,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import { WAGYU_RESIDENT_ENDPOINT } from "../resident/contracts.ts";
import { fromCanonicalBase64 } from "../verifier/bytes.ts";
import {
  WAGYU_WORKER_DEFAULT_TIMEOUT_MS,
  WAGYU_WORKER_MAX_TIMEOUT_MS,
  type VerifiedFeedValueV1,
  type VerifiedLikesValueV1,
  type VerifiedProfileValueV1,
  type VerifiedThreadValueV1,
  type VerifyFeedTaskV1,
  type VerifyLikesTaskV1,
  type VerifyProfileTaskV1,
  type VerifyThreadTaskV1,
  type WagyuWorkerCallOptionsV1,
  type WagyuWorkerResultV1,
} from "./types.ts";
import {
  WAGYU_RESIDENT_VERIFICATION_TOOLS,
  parseWorkerResultJson,
} from "./wire.ts";

export interface WagyuResidentVerificationClientV1 {
  verifyProfile(
    task: Omit<VerifyProfileTaskV1, "kind">,
    options?: WagyuWorkerCallOptionsV1,
  ): Promise<WagyuWorkerResultV1<VerifiedProfileValueV1>>;
  verifyFeed(
    task: Omit<VerifyFeedTaskV1, "kind">,
    options?: WagyuWorkerCallOptionsV1,
  ): Promise<WagyuWorkerResultV1<VerifiedFeedValueV1>>;
  verifyLikes(
    task: Omit<VerifyLikesTaskV1, "kind">,
    options?: WagyuWorkerCallOptionsV1,
  ): Promise<WagyuWorkerResultV1<VerifiedLikesValueV1>>;
  verifyThread(
    task: Omit<VerifyThreadTaskV1, "kind">,
    options?: WagyuWorkerCallOptionsV1,
  ): Promise<WagyuWorkerResultV1<VerifiedThreadValueV1>>;
}

export const WAGYU_RESIDENT_STARTUP_RETRY_DELAYS_MS =
  [50, 100, 200, 400, 800, 1_000, 1_000] as const;

/**
 * Tile-side facade for the background-owned persistent Worker. No root key or
 * gateway is accepted here: the background derives trust from its own kernel
 * runtime configuration.
 */
export function createWagyuResidentVerificationClient(
  endpoint: MsgBusEndpointId =
    WAGYU_RESIDENT_ENDPOINT as MsgBusEndpointId,
  bus: Pick<ReturnType<typeof createMsgBusClient>, "callTool"> =
    createMsgBusClient(),
): WagyuResidentVerificationClientV1 {
  const session = randomRequestSession();
  let requestCounter = 0;
  const call = async <T>(
    name: string,
    arguments_: JsonObject,
    parse: (value: JsonValue) => T,
    options: WagyuWorkerCallOptionsV1,
  ): Promise<WagyuWorkerResultV1<T>> => {
    const timeoutMs = boundedTimeout(
      options.timeoutMs ?? WAGYU_WORKER_DEFAULT_TIMEOUT_MS,
    );
    if (options.signal?.aborted) return cancelled();
    const requestId = `${session}:${++requestCounter}`;
    const operation: Promise<WagyuWorkerResultV1<T>> = (async () => {
      try {
        const value = await retryResidentStartupCall<JsonValue>(
          () =>
            bus.callTool<JsonValue>(
              {
                target: endpoint,
                name,
                arguments: { ...arguments_, requestId },
              },
              Math.ceil(timeoutMs / 1_000) + 5,
            ),
          options.signal,
        );
        return parseWorkerResultJson(value, parse);
      } catch (error) {
        return options.signal?.aborted
          ? cancelled()
          : {
              state: "unavailable",
              code: "resident_verification_unavailable",
              reason: boundedError(
                error,
                "Resident verification was unavailable",
              ),
            };
      }
    })();
    const signal = options.signal;
    if (signal === undefined) return operation;
    return new Promise<WagyuWorkerResultV1<T>>((resolve) => {
      let settled = false;
      const finish = (result: WagyuWorkerResultV1<T>) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        void bus.callTool<JsonValue>(
          {
            target: endpoint,
            name: WAGYU_RESIDENT_VERIFICATION_TOOLS.cancel,
            arguments: { requestId },
          },
          { timeout: 5, control: "cancel" },
        ).catch(() => undefined);
        finish(cancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      void operation.then(finish);
    });
  };

  return {
    verifyProfile(task, options = {}) {
      return call(
        WAGYU_RESIDENT_VERIFICATION_TOOLS.profile,
        { nodeId: task.nodeId },
        parseProfileValue,
        options,
      );
    },
    verifyFeed(task, options = {}) {
      return call(
        WAGYU_RESIDENT_VERIFICATION_TOOLS.feed,
        {
          candidateId: task.candidateId,
          immediateSender: task.immediateSender,
          eventKind: task.eventKind,
          exactEventBytes: Array.from(task.exactEventBytes),
          ...(task.verifiedShareEdge === undefined
            ? {}
            : {
                verifiedShareEdge: {
                  immediateSender:
                    task.verifiedShareEdge.immediateSender,
                  originalAuthor: task.verifiedShareEdge.originalAuthor,
                  postId: Array.from(task.verifiedShareEdge.postId),
                  bodyHash: Array.from(task.verifiedShareEdge.bodyHash),
                  exactShareDeliveryBytes: Array.from(
                    task.verifiedShareEdge.exactShareDeliveryBytes,
                  ),
                },
              }),
        },
        parseFeedValue,
        options,
      );
    },
    verifyLikes(task, options = {}) {
      return call(
        WAGYU_RESIDENT_VERIFICATION_TOOLS.likes,
        {
          postAuthor: task.postAuthor,
          postId: Array.from(task.postId),
          postBodyHash: Array.from(task.postBodyHash),
          ...(task.continuation === undefined
            ? {}
            : { continuation: task.continuation }),
        },
        parseLikesValue,
        options,
      );
    },
    verifyThread(task, options = {}) {
      return call(
        WAGYU_RESIDENT_VERIFICATION_TOOLS.thread,
        {
          postAuthor: task.postAuthor,
          postId: Array.from(task.postId),
          postBodyHash: Array.from(task.postBodyHash),
          postObjectDigest: Array.from(task.postObjectDigest),
          postBodyLength: task.postBodyLength,
          ...(task.summaryOnly === undefined
            ? {}
            : { summaryOnly: task.summaryOnly }),
        },
        parseThreadValue,
        options,
      );
    },
  };
}

/**
 * A tile can render its first feed page one React turn before Kernel has
 * registered the app's background endpoint. That is a launch race, not
 * evidence that every post is unavailable. Keep the cards in their loading
 * state for a short bounded window and retry only this exact startup class.
 */
export async function retryResidentStartupCall<T>(
  call: () => Promise<T>,
  signal?: AbortSignal,
  delays: readonly number[] = WAGYU_RESIDENT_STARTUP_RETRY_DELAYS_MS,
  wait: (
    delayMs: number,
    signal?: AbortSignal,
  ) => Promise<boolean> = waitForResidentStartup,
): Promise<T> {
  let retry = 0;
  while (true) {
    if (signal?.aborted) throw abortError();
    try {
      return await call();
    } catch (error) {
      const delay = delays[retry];
      if (
        delay === undefined ||
        !isResidentStartupRace(error)
      ) {
        throw error;
      }
      retry += 1;
      if (!(await wait(delay, signal))) throw abortError();
    }
  }
}

function isResidentStartupRace(error: unknown): boolean {
  const message = boundedError(error, "").toLowerCase();
  return (
    message.includes("unknown endpoint 'app:wagyu:background'") ||
    message.includes(
      "endpoint 'app:wagyu:background' was replaced before connecting",
    )
  );
}

function waitForResidentStartup(
  delayMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(ready);
    };
    const onAbort = () => finish(false);
    const timer = globalThis.setTimeout(() => finish(true), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  return new Error("Resident verification was cancelled");
}

function parseProfileValue(value: JsonValue): VerifiedProfileValueV1 {
  const record = requiredObject(value, "Verified profile");
  const avatarValue = record.avatar;
  const avatar = avatarValue === null
    ? null
    : (() => {
        const item = requiredObject(avatarValue, "Verified avatar");
        const mediaType = item.mediaType;
        if (
          mediaType !== "jpeg" &&
          mediaType !== "png" &&
          mediaType !== "webp"
        ) {
          throw new Error("Verified avatar media type is invalid");
        }
        const verifiedMediaType = mediaType as "jpeg" | "png" | "webp";
        return {
          mediaType: verifiedMediaType,
          width: safeInteger(item.width, "Avatar width"),
          height: safeInteger(item.height, "Avatar height"),
          bytes: byteArray(item.bytes, "Avatar bytes", 256 * 1_024),
        };
      })();
  return {
    nodeId: requiredText(record.nodeId, "Profile node"),
    profileGeneration: naturalText(
      record.profileGeneration,
      "Profile generation",
    ),
    revision: naturalText(record.revision, "Profile revision"),
    bodyDigest: hex32(record.bodyDigest, "Profile body digest"),
    displayName: requiredText(record.displayName, "Display name", true),
    description: requiredText(record.description, "Description", true),
    capabilities: stringArray(record.capabilities, "Capabilities", 32),
    updatedAtNs: naturalText(record.updatedAtNs, "Profile update time"),
    certificateTimeNs: naturalText(
      record.certificateTimeNs,
      "Certificate time",
    ),
    highWater:
      record.highWater === "advance" || record.highWater === "replay"
        ? record.highWater
        : (() => {
            throw new Error("Profile high-water state is invalid");
          })(),
    avatar,
  };
}

function parseFeedValue(value: JsonValue): VerifiedFeedValueV1 {
  const record = requiredObject(value, "Verified feed item");
  // The background output already passed the Worker protocol and tool schema.
  // Recheck the fields that control rendering and promotion.
  if (
    record.eventKind !== "original" &&
    record.eventKind !== "share" &&
    record.eventKind !== "tombstone"
  ) throw new Error("Verified feed kind is invalid");
  return {
    candidateId: requiredText(record.candidateId, "Candidate ID"),
    eventKind: record.eventKind,
    authorNodeId: requiredText(record.authorNodeId, "Feed author"),
    sharedByNodeId:
      record.sharedByNodeId === null
        ? null
        : requiredText(record.sharedByNodeId, "Feed sharer"),
    postId: hex32(record.postId, "Post ID"),
    bodyHash: hex32(record.bodyHash, "Body hash"),
    objectDigest: hex32(record.objectDigest, "Object digest"),
    bodyLength: safeInteger(record.bodyLength, "Body length"),
    bodyMarkdown:
      record.bodyMarkdown === null
        ? null
        : requiredText(record.bodyMarkdown, "Post body", true),
    actionTimeNs: naturalText(record.actionTimeNs, "Action time"),
    replyTo: record.replyTo === null
      ? null
      : parseReply(requiredObject(record.replyTo, "Reply parent")),
  };
}

function parseLikesValue(value: JsonValue): VerifiedLikesValueV1 {
  const record = requiredObject(value, "Verified likes");
  if (!Array.isArray(record.packages)) {
    throw new Error("Verified Like packages are invalid");
  }
  return {
    postAuthor: requiredText(record.postAuthor, "Post author"),
    postId: hex32(record.postId, "Post ID"),
    postBodyHash: hex32(record.postBodyHash, "Post body hash"),
    head: record.head as unknown as VerifiedLikesValueV1["head"],
    packages:
      record.packages as unknown as VerifiedLikesValueV1["packages"],
    verifiedIncluded: safeInteger(
      record.verifiedIncluded,
      "Verified Like count",
    ),
    invalid: safeInteger(record.invalid, "Invalid Like count"),
    unavailable: safeInteger(
      record.unavailable,
      "Unavailable Like count",
    ),
    truncated:
      typeof record.truncated === "boolean"
        ? record.truncated
        : (() => {
            throw new Error("Like truncation state is invalid");
          })(),
    continuation:
      record.continuation === null
        ? null
        : continuationText(record.continuation),
  };
}

function parseThreadValue(value: JsonValue): VerifiedThreadValueV1 {
  const record = requiredObject(value, "Verified thread");
  if (!Array.isArray(record.replies)) {
    throw new Error("Verified thread replies are invalid");
  }
  const indexValue = record.index;
  return {
    postAuthor: requiredText(record.postAuthor, "Post author"),
    postId: hex32(record.postId, "Post ID"),
    postBodyHash: hex32(record.postBodyHash, "Post body hash"),
    replyCount: safeInteger(
      record.replyCount,
      "Verified direct-reply count",
      0,
      4_096,
    ),
    index: indexValue === null
      ? null
      : (() => {
          const index = requiredObject(indexValue, "Reply index");
          return {
            storeGeneration: naturalText(
              index.storeGeneration,
              "Reply-index generation",
            ),
            revision: naturalText(index.revision, "Reply-index revision"),
            bodyDigest: hex32(index.bodyDigest, "Reply-index digest"),
          };
        })(),
    replies: record.replies.map((value) => {
      const reply = requiredObject(value, "Verified thread reply");
      if (
        reply.state !== "verified" &&
        reply.state !== "invalid" &&
        reply.state !== "unavailable"
      ) throw new Error("Thread reply state is invalid");
      return {
        state: reply.state,
        code: reply.code === null
          ? null
          : requiredText(reply.code, "Thread reply code"),
        authorNodeId: requiredText(reply.authorNodeId, "Reply author"),
        postId: hex32(reply.postId, "Reply post ID"),
        objectDigest: hex32(reply.objectDigest, "Reply object digest"),
        bodyLength: safeInteger(reply.bodyLength, "Reply body length"),
        receivedAtNs: naturalText(reply.receivedAtNs, "Reply receipt time"),
        bodyHash: reply.bodyHash === null
          ? null
          : hex32(reply.bodyHash, "Reply body hash"),
        bodyMarkdown: reply.bodyMarkdown === null
          ? null
          : requiredText(reply.bodyMarkdown, "Reply body", true),
        createdAtNs: reply.createdAtNs === null
          ? null
          : naturalText(reply.createdAtNs, "Reply creation time"),
      };
    }),
  };
}

function parseReply(
  record: JsonObject,
): NonNullable<VerifiedFeedValueV1["replyTo"]> {
  if (
    record.state !== "verified" &&
    record.state !== "invalid" &&
    record.state !== "unavailable"
  ) throw new Error("Reply verification state is invalid");
  return {
    state: record.state,
    code:
      record.code === null ? null : requiredText(record.code, "Reply code"),
    authorNodeId: requiredText(record.authorNodeId, "Reply author"),
    postId: hex32(record.postId, "Reply post ID"),
    bodyHash: hex32(record.bodyHash, "Reply body hash"),
    objectDigest: hex32(record.objectDigest, "Reply object digest"),
    bodyLength: safeInteger(record.bodyLength, "Reply body length"),
    bodyMarkdown:
      record.bodyMarkdown === null
        ? null
        : requiredText(record.bodyMarkdown, "Reply body", true),
  };
}

function requiredObject(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredText(
  value: JsonValue | undefined,
  label: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > 8_192
  ) throw new Error(`${label} is invalid`);
  return value;
}

function naturalText(value: JsonValue | undefined, label: string): string {
  const text = requiredText(value, label);
  if (!/^(0|[1-9][0-9]{0,19})$/u.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function continuationText(value: JsonValue | undefined): string {
  const text = requiredText(value, "Like continuation");
  if (!/^[0-9a-f]{64}$/u.test(text)) {
    throw new Error("Like continuation is invalid");
  }
  return text;
}

function hex32(value: JsonValue | undefined, label: string): string {
  const text = requiredText(value, label);
  if (!/^[0-9a-f]{64}$/u.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function byteArray(
  value: JsonValue | undefined,
  label: string,
  maximum: number,
): Uint8Array {
  if (typeof value === "string") {
    return fromCanonicalBase64(value, label, maximum);
  }
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    !value.every(
      (item) =>
        typeof item === "number" &&
        Number.isInteger(item) &&
        item >= 0 &&
        item <= 255,
    )
  ) throw new Error(`${label} is invalid`);
  return Uint8Array.from(value as number[]);
}

function stringArray(
  value: JsonValue | undefined,
  label: string,
  maximum: number,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    !value.every((item) => typeof item === "string" && item.length <= 64)
  ) throw new Error(`${label} is invalid`);
  return value as string[];
}

function safeInteger(
  value: JsonValue | undefined,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) throw new Error(`${label} is invalid`);
  return value;
}

function boundedTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > WAGYU_WORKER_MAX_TIMEOUT_MS
  ) throw new Error("Verification timeout is invalid");
  return value;
}

function randomRequestSession(): string {
  try {
    return globalThis.crypto.randomUUID().replaceAll("-", "");
  } catch {
    const time = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2);
    return `session${time}${random}`.slice(0, 48).padEnd(16, "0");
  }
}

function cancelled<T>(): WagyuWorkerResultV1<T> {
  return {
    state: "unavailable",
    code: "worker_cancelled",
    reason: "Verification was cancelled",
  };
}

function boundedError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.length > 512 ? `${message.slice(0, 509)}...` : message;
}
