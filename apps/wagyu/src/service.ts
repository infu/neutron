import {
  exposeTool,
  publishAppStateChange,
  setTrayState,
  type JsonValue,
  type MsgBusToolContext,
} from "neutron-tools/app";
import {
  WAGYU_RESIDENT_TOOLS,
  createWagyuResidentBackend,
} from "./resident/contracts.ts";
import { WagyuResidentOrchestrator } from "./resident/orchestrator.ts";
import { browserWagyuResidentStorage } from "./resident/storage.ts";
import {
  residentSnapshotJson,
  wagyuEmptyInputSchema,
  wagyuResidentSnapshotSchema,
  wagyuRetryInputSchema,
  wagyuSetAutoDrainInputSchema,
} from "./resident/wire.ts";
import {
  WAGYU_RESIDENT_VERIFICATION_TOOLS,
  cancelVerificationInputSchema,
  cancelVerificationOutputSchema,
  createWagyuVerificationWorkerClient,
  loadTrustedWorkerRuntime,
  parseVerificationRequestId,
  parseVerifyFeedArguments,
  parseVerifyLikesArguments,
  parseVerifyProfileArguments,
  parseVerifyThreadArguments,
  verifyFeedInputSchema,
  verifyLikesInputSchema,
  verifyProfileInputSchema,
  verifyThreadInputSchema,
  workerResultJson,
  workerResultOutputSchema,
  type WagyuVerificationWorkerClientV1,
} from "./worker/index.ts";
import {
  createScopedWagyuService,
  exposeWagyuAgentTools,
} from "./agent_tools.ts";

const resident = new WagyuResidentOrchestrator({
  backend: createWagyuResidentBackend(),
  storage: browserWagyuResidentStorage(),
  setBadge: (badge) => setTrayState({ badge }),
  publish: (topic, revision) => publishAppStateChange(topic, revision),
  now: () => Date.now(),
  scheduler: {
    set: (delayMs, callback) => window.setTimeout(callback, delayMs),
    clear: (handle) => window.clearTimeout(handle),
  },
});

exposeTool(
  WAGYU_RESIDENT_TOOLS.snapshot,
  {
    title: "Open Wagyu Notifications",
    description:
      "Read recent local notifications, mark the displayed summaries read, and return bounded resident status. This never fetches a peer.",
    inputSchema: wagyuEmptyInputSchema,
    outputSchema: wagyuResidentSnapshotSchema,
    annotations: { "neutron:effects": ["read", "write", "network"] },
  },
  async (_args, context) => {
    requireWagyuSurface(context);
    return residentSnapshotJson(await resident.refreshTray());
  },
);

exposeTool(
  WAGYU_RESIDENT_TOOLS.refresh,
  {
    title: "Refresh Wagyu Resident Status",
    description:
      "Refresh the constant-size local Wagyu status and revision-pinned bounded outbound projection.",
    inputSchema: wagyuEmptyInputSchema,
    outputSchema: wagyuResidentSnapshotSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (_args, context) => {
    requireWagyuSurface(context);
    // A global tile refresh needs revision/status invalidation only. Outbox
    // projection is resident/tray state and may require several sequential
    // pages, so it must not delay visible feed/profile refresh.
    return residentSnapshotJson(await resident.refresh(false));
  },
);

exposeTool(
  WAGYU_RESIDENT_TOOLS.wake,
  {
    title: "Wake Wagyu Background Delivery",
    description:
      "Acknowledge and start one coalesced bounded outbound pass after a durable foreground action. Progress arrives through resident revision topics.",
    inputSchema: wagyuEmptyInputSchema,
    outputSchema: wagyuResidentSnapshotSchema,
    annotations: { "neutron:effects": ["write", "network"] },
  },
  async (_args, context) => {
    requireWagyuSurface(context);
    // The foreground mutation is already durable. Do not hold its UI wake
    // behind a remote dispatch timeout; the resident owns completion and
    // publishes later progress through its revision topics.
    void resident.wake().catch(() => undefined);
    return residentSnapshotJson(resident.snapshot());
  },
);

exposeTool(
  WAGYU_RESIDENT_TOOLS.drain,
  {
    title: "Advance Wagyu Outbox",
    description:
      "Advance one bounded local Wagyu outbox batch. The backend pushes only already-committed payloads.",
    inputSchema: wagyuEmptyInputSchema,
    outputSchema: wagyuResidentSnapshotSchema,
    annotations: { "neutron:effects": ["write", "network"] },
  },
  async (_args, context) => {
    requireWagyuSurface(context);
    return residentSnapshotJson(await resident.drainNow());
  },
);

exposeTool(
  WAGYU_RESIDENT_TOOLS.retry,
  {
    title: "Retry Wagyu Outbox Item",
    description:
      "Ask the local backend to retry one canonical outbox sequence; the backend revalidates eligibility and reuses its durable exact payload.",
    inputSchema: wagyuRetryInputSchema,
    outputSchema: wagyuResidentSnapshotSchema,
    annotations: { "neutron:effects": ["write", "network"] },
  },
  async (args, context) => {
    requireWagyuSurface(context);
    return residentSnapshotJson(
      await resident.retry(requiredSequence(args.localSequence)),
    );
  },
);

exposeTool(
  WAGYU_RESIDENT_TOOLS.setAutoDrain,
  {
    title: "Configure Wagyu Background Delivery",
    description:
      "Pause or resume bounded local outbox advancement in this resident browser process.",
    inputSchema: wagyuSetAutoDrainInputSchema,
    outputSchema: wagyuResidentSnapshotSchema,
    annotations: { "neutron:effects": ["write"] },
  },
  async (args, context) => {
    requireWagyuSurface(context);
    if (typeof args.enabled !== "boolean") {
      throw new Error("Wagyu automatic drain setting is invalid");
    }
    return residentSnapshotJson(
      await resident.setAutoDrain(args.enabled),
    );
  },
);

exposeTool(
  WAGYU_RESIDENT_VERIFICATION_TOOLS.profile,
  {
    title: "Verify a Certified Wagyu Profile",
    description:
      "Verify one on-demand peer profile in the background Worker using the resident's trusted runtime and persistent high-water cache.",
    inputSchema: verifyProfileInputSchema,
    outputSchema: workerResultOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (args, context) => {
    return runResidentVerification(
      context,
      args.requestId,
      async (signal) => {
        const worker = await residentVerificationWorker();
        return workerResultJson(
          await worker.verifyProfile(
            parseVerifyProfileArguments(args),
            { signal },
          ),
        );
      },
    );
  },
);

exposeTool(
  WAGYU_RESIDENT_VERIFICATION_TOOLS.feed,
  {
    title: "Verify a Quarantined Wagyu Feed Event",
    description:
      "Verify one exact bounded feed candidate and any reply parent in the background Worker before promotion or rendering.",
    inputSchema: verifyFeedInputSchema,
    outputSchema: workerResultOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (args, context) => {
    return runResidentVerification(
      context,
      args.requestId,
      async (signal) => {
        const worker = await residentVerificationWorker();
        return workerResultJson(
          await worker.verifyFeed(
            parseVerifyFeedArguments(args),
            { signal },
          ),
        );
      },
    );
  },
);

exposeTool(
  WAGYU_RESIDENT_VERIFICATION_TOOLS.likes,
  {
    title: "Verify Wagyu Like Packages",
    description:
      "Walk one page of at most two packages, returning an opaque continuation when more remain, and verify receipts with Worker concurrency capped at twelve.",
    inputSchema: verifyLikesInputSchema,
    outputSchema: workerResultOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (args, context) => {
    return runResidentVerification(
      context,
      args.requestId,
      async (signal) => {
        const worker = await residentVerificationWorker();
        return workerResultJson(
          await worker.verifyLikes(
            parseVerifyLikesArguments(args),
            { signal },
          ),
        );
      },
    );
  },
);

exposeTool(
  WAGYU_RESIDENT_VERIFICATION_TOOLS.thread,
  {
    title: "Verify a Certified Wagyu Reply Index",
    description:
      "Load the selected post author's certified direct-reply index and verify the newest twenty-five listed replies from their real authors.",
    inputSchema: verifyThreadInputSchema,
    outputSchema: workerResultOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (args, context) => {
    return runResidentVerification(
      context,
      args.requestId,
      async (signal) => {
        const worker = await residentVerificationWorker();
        return workerResultJson(
          await worker.verifyThread(
            parseVerifyThreadArguments(args),
            { signal },
          ),
        );
      },
    );
  },
);

exposeTool(
  WAGYU_RESIDENT_VERIFICATION_TOOLS.cancel,
  {
    title: "Cancel Wagyu Verification",
    description:
      "Cancel one verification started by this exact Wagyu surface.",
    inputSchema: cancelVerificationInputSchema,
    outputSchema: cancelVerificationOutputSchema,
    annotations: {
      "neutron:effects": ["write"],
      "neutron:control": "cancel",
    },
  },
  (args, context) => {
    const endpoint = requireWagyuSurface(context);
    const requestId = parseVerificationRequestId(args.requestId);
    const controller = activeResidentVerifications.get(
      residentVerificationKey(endpoint, requestId),
    );
    const cancelled =
      controller !== undefined && !controller.signal.aborted;
    if (cancelled) controller.abort("caller-cancelled");
    return { cancelled };
  },
);

const disposeAgentTools = exposeWagyuAgentTools({
  createService: (context) =>
    createScopedWagyuService(context, residentVerificationWorker),
  afterMutation: () => {
    // The owner mutation is already durable. Delivery continues in the
    // resident and its normal revision topics refresh every open Wagyu tile.
    void resident.wake().catch(() => undefined);
  },
});

void resident.start();

window.addEventListener("pagehide", () => {
  resident.stop();
  disposeAgentTools();
  for (const controller of activeResidentVerifications.values()) {
    controller.abort("resident-page-hidden");
  }
  residentVerificationEpoch += 1;
  residentVerificationClient?.close();
  residentVerificationClient = null;
  residentVerificationPromise = null;
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) void resident.start();
});

function requireWagyuSurface(context: MsgBusToolContext): string {
  const caller = context.caller;
  if (
    caller?.appId !== "wagyu" ||
    (caller.role !== "tile" && caller.role !== "tray") ||
    typeof caller.endpoint !== "string" ||
    caller.endpoint.length > 512
  ) {
    throw new Error(
      "Wagyu resident controls are available only to a live Wagyu tile or tray",
    );
  }
  const endpointPattern =
    caller.role === "tray"
      ? /^app:wagyu:tray:instance:[^:]{1,192}$/u
      : /^app:wagyu:tile:[^:]{1,64}:instance:[^:]{1,192}$/u;
  if (!endpointPattern.test(caller.endpoint)) {
    throw new Error("Wagyu resident caller endpoint is invalid");
  }
  return caller.endpoint;
}

function requiredSequence(value: JsonValue | undefined): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(value)
  ) {
    throw new Error("Wagyu outbox local sequence is invalid");
  }
  return value;
}

let residentVerificationPromise:
  | Promise<WagyuVerificationWorkerClientV1>
  | null = null;
let residentVerificationClient: WagyuVerificationWorkerClientV1 | null = null;
let residentVerificationEpoch = 0;
const activeResidentVerifications = new Map<string, AbortController>();
const MAX_ACTIVE_RESIDENT_VERIFICATIONS = 64;

async function runResidentVerification(
  context: MsgBusToolContext,
  rawRequestId: JsonValue | undefined,
  run: (signal: AbortSignal) => Promise<JsonValue>,
): Promise<JsonValue> {
  const endpoint = requireWagyuSurface(context);
  const requestId = parseVerificationRequestId(rawRequestId);
  const key = residentVerificationKey(endpoint, requestId);
  if (activeResidentVerifications.has(key)) {
    throw new Error("Wagyu verification request is already active");
  }
  if (
    activeResidentVerifications.size >= MAX_ACTIVE_RESIDENT_VERIFICATIONS
  ) {
    throw new Error("Wagyu resident verification is busy");
  }

  const controller = new AbortController();
  const abortFromContext = () =>
    controller.abort(context.signal?.reason ?? "invocation-cancelled");
  if (context.signal?.aborted) abortFromContext();
  else context.signal?.addEventListener("abort", abortFromContext, {
    once: true,
  });
  activeResidentVerifications.set(key, controller);
  try {
    return await run(controller.signal);
  } finally {
    context.signal?.removeEventListener("abort", abortFromContext);
    if (activeResidentVerifications.get(key) === controller) {
      activeResidentVerifications.delete(key);
    }
  }
}

function residentVerificationKey(
  endpoint: string,
  requestId: string,
): string {
  return `${endpoint}\u0000${requestId}`;
}

function residentVerificationWorker(): Promise<WagyuVerificationWorkerClientV1> {
  if (residentVerificationPromise) return residentVerificationPromise;
  const epoch = residentVerificationEpoch;
  const pending = loadTrustedWorkerRuntime(
    "persistent-background",
  ).then((trusted) => {
    const client = createWagyuVerificationWorkerClient({ trusted });
    if (epoch !== residentVerificationEpoch) {
      client.close();
      throw new Error("Wagyu resident verification context changed");
    }
    residentVerificationClient = client;
    return client;
  }).catch((error) => {
    if (residentVerificationPromise === pending) {
      residentVerificationPromise = null;
    }
    throw error;
  });
  residentVerificationPromise = pending;
  return pending;
}

void residentVerificationWorker().then((worker) => worker.ready).catch(() => {
  // A later on-demand call retries trusted runtime initialization.
});
