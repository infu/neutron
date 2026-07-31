import {
  WAGYU_VERIFICATION_WORKER_PROTOCOL,
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
  type WagyuVerificationWorkerClientV1,
  type WagyuWorkerCallOptionsV1,
  type WagyuWorkerLikeV1,
  type WagyuWorkerRequestV1,
  type WagyuWorkerResponseV1,
  type WagyuWorkerResultV1,
  type WagyuWorkerTrustedConfigV1,
} from "./types.ts";
import { createPackagedWagyuVerificationWorker } from "./bootstrap.ts";

export interface CreateWagyuVerificationWorkerClientOptionsV1 {
  readonly trusted: WagyuWorkerTrustedConfigV1;
  /** Tests and audited embedders may provide an already isolated Worker. */
  readonly worker?: WagyuWorkerLikeV1;
  readonly defaultTimeoutMs?: number;
}

type PendingCall = {
  readonly resolve: (value: WagyuWorkerResultV1<unknown>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
};

type WorkerRequestWithoutId =
  WagyuWorkerRequestV1 extends infer Request
    ? Request extends { readonly requestId: string }
      ? Omit<Request, "requestId">
      : never
    : never;

export function createWagyuVerificationWorkerClient(
  options: CreateWagyuVerificationWorkerClientOptionsV1,
): WagyuVerificationWorkerClientV1 {
  const defaultTimeoutMs = boundedTimeout(
    options.defaultTimeoutMs ?? WAGYU_WORKER_DEFAULT_TIMEOUT_MS,
  );
  const ownsWorker = options.worker === undefined;
  const worker = options.worker ?? createPackagedWagyuVerificationWorker();
  const pending = new Map<string, PendingCall>();
  let counter = 0;
  let closed = false;
  const session = randomSession();

  const onMessage = (event: MessageEvent<unknown>) => {
    const response = parseResponse(event.data);
    if (response === null) return;
    const call = pending.get(response.requestId);
    if (call === undefined) return;
    pending.delete(response.requestId);
    clearTimeout(call.timer);
    if (call.signal !== undefined && call.abort !== undefined) {
      call.signal.removeEventListener("abort", call.abort);
    }
    call.resolve(response.result);
  };
  worker.addEventListener("message", onMessage);

  const dispatch = <T>(
    request: WorkerRequestWithoutId,
    options: WagyuWorkerCallOptionsV1 = {},
    transfer: readonly Transferable[] = [],
  ): Promise<WagyuWorkerResultV1<T>> => {
    if (closed) {
      return Promise.resolve(unavailable(
        "worker_closed",
        "Verification Worker client is closed",
      ));
    }
    const timeoutMs = boundedTimeout(
      options.timeoutMs ?? defaultTimeoutMs,
    );
    if (options.signal?.aborted) {
      return Promise.resolve(unavailable(
        "worker_cancelled",
        "Verification was cancelled",
      ));
    }
    const requestId = `${session}:${++counter}`;
    return new Promise((resolve) => {
      const finishUnavailable = (
        code: "worker_timeout" | "worker_cancelled",
        reason: string,
      ) => {
        const current = pending.get(requestId);
        if (current === undefined) return;
        pending.delete(requestId);
        clearTimeout(current.timer);
        if (current.signal !== undefined && current.abort !== undefined) {
          current.signal.removeEventListener("abort", current.abort);
        }
        try {
          worker.postMessage({
            protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
            type: "cancel",
            requestId,
          } satisfies WagyuWorkerRequestV1);
        } catch {
          // The local result below remains explicit even if cancellation could
          // not be delivered to a failed Worker process.
        }
        resolve(unavailable(code, reason));
      };
      const timer = setTimeout(
        () =>
          finishUnavailable(
            "worker_timeout",
            "Verification exceeded its bounded client deadline",
          ),
        timeoutMs,
      );
      const abort = options.signal === undefined
        ? undefined
        : () =>
            finishUnavailable(
              "worker_cancelled",
              "Verification was cancelled",
            );
      pending.set(requestId, {
        resolve: resolve as (value: WagyuWorkerResultV1<unknown>) => void,
        timer,
        ...(options.signal === undefined
          ? {}
          : { signal: options.signal, abort: abort! }),
      });
      options.signal?.addEventListener("abort", abort!, { once: true });
      try {
        const message = {
          ...request,
          requestId,
        } as WagyuWorkerRequestV1;
        worker.postMessage(
          message,
          transfer,
        );
      } catch (error) {
        finishUnavailable(
          "worker_cancelled",
          boundedError(error, "Verification Worker message failed"),
        );
      }
    });
  };

  const trusted = cloneTrusted(options.trusted);
  const ready = dispatch<{ readonly networkId: string }>({
    protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
    type: "init",
    trusted,
  });

  const afterReady = async <T>(
    run: () => Promise<WagyuWorkerResultV1<T>>,
  ): Promise<WagyuWorkerResultV1<T>> => {
    const initialized = await ready;
    if (initialized.state !== "verified") return initialized;
    return run();
  };

  return {
    ready,
    verifyProfile(task, callOptions = {}) {
      return afterReady<VerifiedProfileValueV1>(() =>
        dispatch<VerifiedProfileValueV1>({
          protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
          type: "task",
          timeoutMs: boundedTimeout(
            callOptions.timeoutMs ?? defaultTimeoutMs,
          ),
          task: {
            kind: "profile",
            nodeId: task.nodeId,
          } satisfies VerifyProfileTaskV1,
        }, callOptions)
      );
    },
    verifyFeed(task, callOptions = {}) {
      return afterReady<VerifiedFeedValueV1>(() => {
        const exactEventBytes = task.exactEventBytes.slice();
        const edge = task.verifiedShareEdge === undefined
          ? undefined
          : {
              ...task.verifiedShareEdge,
              postId: task.verifiedShareEdge.postId.slice(),
              bodyHash: task.verifiedShareEdge.bodyHash.slice(),
              exactShareDeliveryBytes:
                task.verifiedShareEdge.exactShareDeliveryBytes.slice(),
            };
        return dispatch<VerifiedFeedValueV1>({
          protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
          type: "task",
          timeoutMs: boundedTimeout(
            callOptions.timeoutMs ?? defaultTimeoutMs,
          ),
          task: {
            kind: "feed",
            candidateId: task.candidateId,
            immediateSender: task.immediateSender,
            eventKind: task.eventKind,
            exactEventBytes,
            ...(edge === undefined ? {} : { verifiedShareEdge: edge }),
          } satisfies VerifyFeedTaskV1,
        }, callOptions, transferableBuffers(
          exactEventBytes,
          edge?.postId,
          edge?.bodyHash,
          edge?.exactShareDeliveryBytes,
        ));
      });
    },
    verifyLikes(task, callOptions = {}) {
      return afterReady<VerifiedLikesValueV1>(() => {
        const postId = task.postId.slice();
        const postBodyHash = task.postBodyHash.slice();
        return dispatch<VerifiedLikesValueV1>({
          protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
          type: "task",
          timeoutMs: boundedTimeout(
            callOptions.timeoutMs ?? defaultTimeoutMs,
          ),
          task: {
            kind: "likes",
            postAuthor: task.postAuthor,
            postId,
            postBodyHash,
            ...(task.continuation === undefined
              ? {}
              : { continuation: task.continuation }),
          } satisfies VerifyLikesTaskV1,
        }, callOptions, transferableBuffers(postId, postBodyHash));
      });
    },
    verifyThread(task, callOptions = {}) {
      return afterReady<VerifiedThreadValueV1>(() => {
        const postId = task.postId.slice();
        const postBodyHash = task.postBodyHash.slice();
        const postObjectDigest = task.postObjectDigest.slice();
        return dispatch<VerifiedThreadValueV1>({
          protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
          type: "task",
          timeoutMs: boundedTimeout(
            callOptions.timeoutMs ?? defaultTimeoutMs,
          ),
          task: {
            kind: "thread",
            postAuthor: task.postAuthor,
            postId,
            postBodyHash,
            postObjectDigest,
            postBodyLength: task.postBodyLength,
            ...(task.summaryOnly === undefined
              ? {}
              : { summaryOnly: task.summaryOnly }),
          } satisfies VerifyThreadTaskV1,
        }, callOptions, transferableBuffers(
          postId,
          postBodyHash,
          postObjectDigest,
        ));
      });
    },
    close() {
      if (closed) return;
      closed = true;
      worker.removeEventListener("message", onMessage);
      for (const [requestId, call] of pending) {
        clearTimeout(call.timer);
        if (call.signal !== undefined && call.abort !== undefined) {
          call.signal.removeEventListener("abort", call.abort);
        }
        call.resolve(unavailable(
          "worker_closed",
          "Verification Worker client is closed",
        ));
        try {
          worker.postMessage({
            protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
            type: "cancel",
            requestId,
          } satisfies WagyuWorkerRequestV1);
        } catch {
          // Closing is already complete locally.
        }
      }
      pending.clear();
      if (ownsWorker) worker.terminate?.();
    },
  };
}

function parseResponse(value: unknown): WagyuWorkerResponseV1 | null {
  if (
    !isRecord(value) ||
    value.protocol !== WAGYU_VERIFICATION_WORKER_PROTOCOL ||
    value.type !== "response" ||
    typeof value.requestId !== "string" ||
    !isResult(value.result)
  ) {
    return null;
  }
  return value as unknown as WagyuWorkerResponseV1;
}

function isResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.state !== "string") return false;
  if (value.state === "verified") return "value" in value;
  return (
    (value.state === "invalid" || value.state === "unavailable") &&
    typeof value.code === "string" &&
    value.code.length >= 1 &&
    value.code.length <= 128 &&
    typeof value.reason === "string" &&
    value.reason.length <= 512
  );
}

function cloneTrusted(
  trusted: WagyuWorkerTrustedConfigV1,
): WagyuWorkerTrustedConfigV1 {
  return {
    rootKey: trusted.rootKey.slice(),
    networkId: trusted.networkId.slice(),
    gatewayOrigin: trusted.gatewayOrigin,
    ...(trusted.allowInsecureLocalhost === true
      ? { allowInsecureLocalhost: true }
      : {}),
    ...(typeof trusted.localAgentHost === "string"
      ? { localAgentHost: trusted.localAgentHost }
      : {}),
    storageMode:
      trusted.storageMode === "persistent-background"
        ? "persistent-background"
        : "memory",
  };
}

function transferableBuffers(
  ...values: Array<Uint8Array | undefined>
): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const value of values) {
    if (value !== undefined && value.buffer instanceof ArrayBuffer) {
      buffers.add(value.buffer);
    }
  }
  return [...buffers];
}

function boundedTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > WAGYU_WORKER_MAX_TIMEOUT_MS
  ) {
    throw new Error("Verification Worker timeout is outside its bounded range");
  }
  return value;
}

function randomSession(): string {
  try {
    return globalThis.crypto.randomUUID().replaceAll("-", "");
  } catch {
    return `session${Date.now().toString(36)}`;
  }
}

function unavailable(
  code: string,
  reason: string,
): Extract<WagyuWorkerResultV1<never>, { state: "unavailable" }> {
  return { state: "unavailable", code, reason };
}

function boundedError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.length > 512 ? `${message.slice(0, 509)}...` : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
