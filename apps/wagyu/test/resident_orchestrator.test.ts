import { describe, expect, test } from "bun:test";
import {
  type WagyuBackendStatus,
  type WagyuDrainResult,
  type WagyuOutboxPage,
  type WagyuResidentBackend,
} from "../src/resident/contracts.ts";
import {
  WAGYU_RESIDENT_POLL_BASE_MS,
  WAGYU_RESIDENT_POLL_MAX_MS,
  WAGYU_RESIDENT_OUTBOX_PAGE_REQUEST_MAX,
  WagyuResidentBusyError,
  WagyuResidentOrchestrator,
  residentPollDelay,
  type WagyuResidentScheduler,
} from "../src/resident/orchestrator.ts";
import {
  emptyStoredProjection,
  type WagyuResidentStorage,
  type WagyuResidentStoredProjection,
} from "../src/resident/storage.ts";

describe("Wagyu resident orchestration", () => {
  test("republishes a cached badge after reload, then replaces it from local authoritative status", async () => {
    const cached = status({
      unreadFeedCount: 1,
      unreadNotificationCount: 1,
    });
    const authoritative = status({
      stateRevision: "8",
      feedRevision: "5",
      notificationRevision: "6",
      unreadFeedCount: 4,
      unreadNotificationCount: 3,
      outboxErrorCount: 2,
    });
    const badges: Array<number | null> = [];
    const publications: Array<[string, string]> = [];
    const harness = createHarness({
      initial: {
        ...emptyStoredProjection(),
        lastAuthoritativeAtMs: 10,
        status: cached,
      },
      backend: backend({ status: async () => authoritative }),
      setBadge: async (badge) => {
        badges.push(badge);
      },
      publish: async (topic, revision) => {
        publications.push([topic, revision]);
      },
    });

    const snapshot = await harness.resident.start();

    expect(badges).toEqual([1, 3]);
    expect(snapshot.source).toBe("authoritative");
    expect(snapshot.badge).toBe(3);
    expect(publications).toContainEqual(["wagyu_status", "8"]);
    expect(publications).toContainEqual(["wagyu_feed", "5"]);
    expect(publications).toContainEqual(["wagyu_notifications", "6"]);
    expect(harness.calls.status).toBe(1);
    expect(harness.calls.outboxPage).toBe(0);
    expect(harness.calls.drain).toBe(0);
  });

  test("an explicit refresh replaces the tray badge after notifications are marked read", async () => {
    let current = status({
      stateRevision: "5",
      notificationRevision: "5",
      unreadNotificationCount: 5,
    });
    const badges: Array<number | null> = [];
    const publications: Array<[string, string]> = [];
    const harness = createHarness({
      backend: backend({ status: async () => current }),
      setBadge: async (badge) => {
        badges.push(badge);
      },
      publish: async (topic, revision) => {
        publications.push([topic, revision]);
      },
    });
    await harness.resident.start();
    current = status({
      stateRevision: "6",
      notificationRevision: "6",
      unreadNotificationCount: 0,
    });

    const refreshed = await harness.resident.refresh();

    expect(refreshed.status?.unreadNotificationCount).toBe(0);
    expect(refreshed.badge).toBeNull();
    expect(badges).toEqual([5, null]);
    expect(publications).toContainEqual(["wagyu_notifications", "6"]);
    expect(harness.calls.status).toBe(2);
  });

  test("loads only a bounded local notification projection for the tray", async () => {
    const harness = createHarness({
      backend: backend({
        notificationPage: async (limit) => {
          expect(limit).toBe(20);
          return {
            revision: "4",
            items: [{
              localSequence: "3",
              receivedAtNs: "1000000",
              actorNodeId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
              kind: "reply",
              verification: "verified",
              read: false,
            }],
          };
        },
        markNotificationsRead: async (localSequences) => {
          expect(localSequences).toEqual(["3"]);
          return "5";
        },
      }),
    });
    await harness.resident.start();

    const snapshot = await harness.resident.refreshTray();

    expect(snapshot.notificationItems).toEqual([{
      localSequence: "3",
      receivedAtNs: "1000000",
      actorNodeId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      kind: "reply",
      verification: "verified",
      read: true,
    }]);
    expect(harness.calls.notificationPage).toBe(1);
    expect(harness.calls.markNotificationsRead).toBe(1);
    expect(harness.calls.outboxPage).toBe(0);
  });

  test("queues due relationship renewals in the resident before draining", async () => {
    let pending = false;
    let relationshipRevision = "1";
    const nodeId = "rrkah-fqaaa-aaaaa-aaaaq-cai";
    const harness = createHarness({
      backend: backend({
        status: async () =>
          status({
            networkConfigured: true,
            networkId: [1, ...Array.from({ length: 31 }, () => 0)],
            relationshipRevision,
            outboundWorkPending: pending,
          }),
        renewalPage: async (beforeNode) => {
          expect(beforeNode).toBeNull();
          return {
            revision: relationshipRevision,
            dueNodeIds: [nodeId],
            nextBeforeNode: null,
          };
        },
        renewFollowingIfDue: async (candidate) => {
          expect(candidate).toBe(nodeId);
          pending = true;
          relationshipRevision = "2";
          return true;
        },
        drain: async () => {
          pending = false;
          return drainResult();
        },
      }),
    });

    const snapshot = await harness.resident.start();

    expect(harness.calls.renewalPage).toBe(1);
    expect(harness.calls.renewFollowingIfDue).toBe(1);
    expect(harness.calls.drain).toBe(1);
    expect(snapshot.status?.outboundWorkPending).toBeFalse();
  });

  test("a renewal scan failure never blocks ordinary outbound delivery", async () => {
    const harness = createHarness({
      backend: backend({
        status: async () =>
          status({
            networkConfigured: true,
            networkId: [1, ...Array.from({ length: 31 }, () => 0)],
            outboundWorkPending: true,
          }),
        renewalPage: async () => {
          throw new Error("relationship scan unavailable");
        },
        drain: async () => drainResult(),
      }),
    });

    await harness.resident.start();

    expect(harness.calls.renewalPage).toBe(1);
    expect(harness.calls.drain).toBe(1);
  });

  test("advances one fanout-only outbound batch during a startup pass", async () => {
    const statuses = [
      status({ stateRevision: "2", outboundWorkPending: true }),
      status({ stateRevision: "3", outboundWorkPending: true }),
    ];
    const harness = createHarness({
      backend: backend({
        status: async () => statuses.shift() ?? status({
          stateRevision: "3",
          outboundWorkPending: true,
        }),
        drain: async (limit) => {
          expect(limit).toBe(20);
          return drainResult({ remaining: 30, completed: 20 });
        },
      }),
    });

    const snapshot = await harness.resident.start();

    expect(harness.calls.drain).toBe(1);
    expect(harness.calls.status).toBe(2);
    expect(harness.calls.outboxPage).toBe(1);
    expect(snapshot.status?.outboundWorkPending).toBeTrue();
    expect(snapshot.status?.outboxQueuedCount).toBe(0);
    expect(harness.scheduler.delays).toHaveLength(1);
  });

  test("coalesces foreground wakes and drains fanout-only work immediately", async () => {
    let pending = false;
    let stateRevision = "1";
    const harness = createHarness({
      backend: backend({
        status: async () =>
          status({
            stateRevision,
            outboundWorkPending: pending,
            outboxQueuedCount: 0,
          }),
        drain: async () => {
          pending = false;
          stateRevision = "3";
          return drainResult({ remaining: 0, completed: 1 });
        },
      }),
    });
    await harness.resident.start();
    pending = true;
    stateRevision = "2";

    const [first, second] = await Promise.all([
      harness.resident.wake(),
      harness.resident.wake(),
    ]);

    expect(harness.calls.drain).toBe(1);
    expect(first.status?.outboundWorkPending).toBeFalse();
    expect(second.status?.outboundWorkPending).toBeFalse();
  });

  test("keeps cached state explicitly non-authoritative when the local query fails", async () => {
    const cached = status({ unreadFeedCount: 2 });
    const harness = createHarness({
      initial: {
        ...emptyStoredProjection(),
        lastAuthoritativeAtMs: 20,
        status: cached,
      },
      backend: backend({
        status: async () => {
          throw new Error("local backend unavailable");
        },
      }),
    });

    const snapshot = await harness.resident.start();

    expect(snapshot.source).toBe("cached");
    expect(snapshot.phase).toBe("starting");
    expect(snapshot.lastError).toMatchObject({
      operation: "status",
      message: "local backend unavailable",
    });
    expect(snapshot.consecutiveFailures).toBe(1);
    expect(harness.scheduler.delays).toEqual([120_000]);
  });

  test("rejects a state rollback within the same kernel installation generation", async () => {
    const cached = status({
      profileGeneration: "12",
      stateRevision: "90",
      feedRevision: "70",
    });
    const harness = createHarness({
      initial: {
        ...emptyStoredProjection(),
        lastAuthoritativeAtMs: 20,
        status: cached,
      },
      backend: backend({
        status: async () =>
          status({
            profileGeneration: "12",
            stateRevision: "1",
            feedRevision: "1",
          }),
      }),
    });

    const snapshot = await harness.resident.start();

    expect(snapshot.source).toBe("cached");
    expect(snapshot.status?.stateRevision).toBe("90");
    expect(snapshot.lastError?.message).toBe(
      "Wagyu backend state revision regressed",
    );
    expect(harness.storage.saved).toHaveLength(0);
  });

  test("accepts a revision reset only after the kernel installation generation advances", async () => {
    const cached = status({
      profileGeneration: "12",
      stateRevision: "90",
      feedRevision: "70",
      notificationRevision: "50",
    });
    const next = status({
      profileGeneration: "13",
      stateRevision: "1",
      feedRevision: "1",
      notificationRevision: "1",
    });
    const publications: Array<[string, string]> = [];
    const harness = createHarness({
      initial: {
        ...emptyStoredProjection(),
        lastAuthoritativeAtMs: 20,
        status: cached,
      },
      backend: backend({ status: async () => next }),
      publish: async (topic, revision) => {
        publications.push([topic, revision]);
      },
    });

    const snapshot = await harness.resident.start();

    expect(snapshot.source).toBe("authoritative");
    expect(snapshot.status).toMatchObject({
      profileGeneration: "13",
      stateRevision: "1",
    });
    expect(harness.storage.saved.at(-1)?.status).toMatchObject({
      profileGeneration: "13",
      stateRevision: "1",
    });
    expect(publications).toContainEqual(["wagyu_status", "1"]);
    expect(publications).toContainEqual(["wagyu_feed", "1"]);
    expect(publications).toContainEqual(["wagyu_notifications", "1"]);
  });

  test("rejects an installation-generation rollback within one node and network", async () => {
    const cached = status({
      profileGeneration: "12",
      stateRevision: "5",
    });
    const harness = createHarness({
      initial: {
        ...emptyStoredProjection(),
        lastAuthoritativeAtMs: 20,
        status: cached,
      },
      backend: backend({
        status: async () =>
          status({
            profileGeneration: "11",
            stateRevision: "6",
          }),
      }),
    });

    const snapshot = await harness.resident.start();

    expect(snapshot.source).toBe("cached");
    expect(snapshot.status?.profileGeneration).toBe("12");
    expect(snapshot.lastError?.message).toBe(
      "Wagyu backend installation generation regressed",
    );
  });

  test("does not compare revision high-water marks across node identities", async () => {
    const cached = status({
      node: "aaaaa-aa",
      profileGeneration: "12",
      stateRevision: "90",
    });
    const next = status({
      node: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      profileGeneration: "1",
      stateRevision: "1",
    });
    const harness = createHarness({
      initial: {
        ...emptyStoredProjection(),
        lastAuthoritativeAtMs: 20,
        status: cached,
      },
      backend: backend({ status: async () => next }),
    });

    const snapshot = await harness.resident.start();

    expect(snapshot.source).toBe("authoritative");
    expect(snapshot.status).toMatchObject({
      node: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      profileGeneration: "1",
      stateRevision: "1",
    });
  });

  test("does not compare revision high-water marks across configured network identities", async () => {
    const cached = status({
      networkConfigured: true,
      networkId: Array.from({ length: 32 }, () => 7),
      profileGeneration: "12",
      stateRevision: "90",
    });
    const next = status({
      networkConfigured: true,
      networkId: Array.from({ length: 32 }, () => 8),
      profileGeneration: "1",
      stateRevision: "1",
    });
    const harness = createHarness({
      initial: {
        ...emptyStoredProjection(),
        lastAuthoritativeAtMs: 20,
        status: cached,
      },
      backend: backend({ status: async () => next }),
    });

    const snapshot = await harness.resident.start();

    expect(snapshot.source).toBe("authoritative");
    expect(snapshot.status).toMatchObject({
      networkId: Array.from({ length: 32 }, () => 8),
      profileGeneration: "1",
      stateRevision: "1",
    });
  });

  test("loads a revision-pinned bounded outbox projection across pages", async () => {
    const requests: Array<
      [number | undefined, string | null | undefined, string | null | undefined]
    > = [];
    const harness = createHarness({
      backend: backend({
        outboxPage: async (limit, before, expectedRevision) => {
          requests.push([limit, before, expectedRevision]);
          const first = before === null || before === undefined
            ? 100
            : Number(before) - 1;
          const count = limit ?? 8;
          const items = Array.from(
            { length: count },
            (_, index) => outboxItem(String(first - index)),
          );
          return {
            revision: "44",
            items,
            nextBeforeSequence: items.at(-1)?.localSequence ?? null,
          };
        },
      }),
    });
    await harness.resident.start();

    const snapshot = await harness.resident.refresh(true);

    expect(snapshot.outboxItems).toHaveLength(50);
    expect(snapshot.outboxItems[0]?.localSequence).toBe("100");
    expect(snapshot.outboxItems.at(-1)?.localSequence).toBe("51");
    expect(requests).toHaveLength(WAGYU_RESIDENT_OUTBOX_PAGE_REQUEST_MAX);
    expect(requests[0]).toEqual([8, null, null]);
    expect(requests[1]).toEqual([8, "93", "44"]);
    expect(requests.at(-1)).toEqual([2, "53", "44"]);
  });

  test("does not publish mixed-revision outbox pages", async () => {
    const harness = createHarness({
      backend: backend({
        outboxPage: async (_limit, before) =>
          before === null || before === undefined
            ? {
                revision: "10",
                items: [outboxItem("9")],
                nextBeforeSequence: "9",
              }
            : {
                revision: "11",
                items: [outboxItem("8")],
                nextBeforeSequence: null,
              },
      }),
    });
    await harness.resident.start();

    const snapshot = await harness.resident.refresh(true);

    expect(snapshot.outboxItems).toEqual([]);
    expect(snapshot.lastError).toMatchObject({
      operation: "outbox_page",
      message: "Wagyu outbox revision changed during pagination",
    });
  });

  test("lets the backend authorize a direct retry outside the bounded projection", async () => {
    const harness = createHarness({
      backend: backend({
        outboxPage: async () => outboxPage(),
        retry: async (localSequence) => {
          if (localSequence === "8") {
            throw new Error("Backend rejected non-retryable outbox item");
          }
          return drainResult();
        },
      }),
    });
    await harness.resident.start();
    await harness.resident.refresh(true);

    await expect(harness.resident.retry("7")).resolves.toMatchObject({
      source: "authoritative",
    });
    expect(harness.calls.retry).toBe(1);
    await expect(harness.resident.retry("8")).rejects.toThrow(
      "Backend rejected non-retryable outbox item",
    );
    expect(harness.calls.retry).toBe(2);
    await expect(harness.resident.retry("01")).rejects.toThrow(
      "local sequence is invalid",
    );
    expect(harness.calls.retry).toBe(2);
  });

  test("does not overlap outbound mutations", async () => {
    const pending: {
      resolve: ((value: WagyuDrainResult) => void) | null;
    } = { resolve: null };
    const harness = createHarness({
      backend: backend({
        drain: () =>
          new Promise<WagyuDrainResult>((resolve) => {
            pending.resolve = resolve;
          }),
      }),
    });
    await harness.resident.start();

    const first = harness.resident.drainNow();
    await Promise.resolve();
    await expect(harness.resident.drainNow()).rejects.toBeInstanceOf(
      WagyuResidentBusyError,
    );
    const resolveDrain = pending.resolve;
    if (resolveDrain === null) throw new Error("Drain did not start");
    resolveDrain(drainResult());
    await first;
  });

  test("persists user pause without changing canonical backend state", async () => {
    const harness = createHarness({});
    await harness.resident.start();

    const paused = await harness.resident.setAutoDrain(false);
    expect(paused.phase).toBe("paused");
    expect(paused.pauseReason).toBe("user");
    expect(harness.storage.saved.at(-1)?.autoDrainEnabled).toBe(false);

    const resumed = await harness.resident.setAutoDrain(true);
    expect(resumed.phase).toBe("ready");
    expect(harness.storage.saved.at(-1)?.autoDrainEnabled).toBe(true);
    expect(harness.scheduler.delays.at(-1)).toBe(0);
  });
});

describe("Wagyu resident polling", () => {
  test("backs off local status failures with a fixed ceiling", () => {
    expect(residentPollDelay(0)).toBe(WAGYU_RESIDENT_POLL_BASE_MS);
    expect(residentPollDelay(1)).toBe(120_000);
    expect(residentPollDelay(2)).toBe(240_000);
    expect(residentPollDelay(3)).toBe(WAGYU_RESIDENT_POLL_MAX_MS);
    expect(residentPollDelay(4)).toBe(WAGYU_RESIDENT_POLL_MAX_MS);
    expect(residentPollDelay(100)).toBe(WAGYU_RESIDENT_POLL_MAX_MS);
    expect(residentPollDelay(Number.NaN)).toBe(WAGYU_RESIDENT_POLL_BASE_MS);
  });
});

type HarnessCalls = {
  status: number;
  notificationPage: number;
  markNotificationsRead: number;
  renewalPage: number;
  renewFollowingIfDue: number;
  outboxPage: number;
  drain: number;
  retry: number;
};

function createHarness(options: {
  initial?: WagyuResidentStoredProjection | null;
  backend?: WagyuResidentBackend;
  setBadge?: (badge: number | null) => Promise<void>;
  publish?: (topic: string, revision: string) => Promise<void>;
}) {
  const calls: HarnessCalls = {
    status: 0,
    notificationPage: 0,
    markNotificationsRead: 0,
    renewalPage: 0,
    renewFollowingIfDue: 0,
    outboxPage: 0,
    drain: 0,
    retry: 0,
  };
  const delegate = options.backend ?? backend({});
  const outboxPageArguments: Array<
    [number | undefined, string | null | undefined, string | null | undefined]
  > = [];
  const counted: WagyuResidentBackend = {
    status: async () => {
      calls.status += 1;
      return delegate.status();
    },
    notificationPage: async (limit) => {
      calls.notificationPage += 1;
      return delegate.notificationPage(limit);
    },
    markNotificationsRead: async (localSequences) => {
      calls.markNotificationsRead += 1;
      return delegate.markNotificationsRead(localSequences);
    },
    renewalPage: async (beforeNode) => {
      calls.renewalPage += 1;
      return delegate.renewalPage(beforeNode);
    },
    renewFollowingIfDue: async (nodeId) => {
      calls.renewFollowingIfDue += 1;
      return delegate.renewFollowingIfDue(nodeId);
    },
    outboxPage: async (limit, beforeSequence, expectedRevision) => {
      calls.outboxPage += 1;
      outboxPageArguments.push([
        limit,
        beforeSequence,
        expectedRevision,
      ]);
      return delegate.outboxPage(limit, beforeSequence, expectedRevision);
    },
    drain: async (limit) => {
      calls.drain += 1;
      return delegate.drain(limit);
    },
    retry: async (localSequence) => {
      calls.retry += 1;
      return delegate.retry(localSequence);
    },
  };
  const storage = memoryStorage(options.initial ?? null);
  const scheduler = fakeScheduler();
  return {
    calls,
    outboxPageArguments,
    storage,
    scheduler,
    resident: new WagyuResidentOrchestrator({
      backend: counted,
      storage,
      setBadge: options.setBadge ?? (async () => undefined),
      publish: options.publish ?? (async () => undefined),
      now: () => 1_000,
      scheduler,
    }),
  };
}

function backend(
  overrides: Partial<WagyuResidentBackend>,
): WagyuResidentBackend {
  return {
    status: overrides.status ?? (async () => status()),
    notificationPage:
      overrides.notificationPage ??
      (async () => ({ revision: "1", items: [] })),
    markNotificationsRead:
      overrides.markNotificationsRead ??
      (async () => "1"),
    renewalPage:
      overrides.renewalPage ??
      (async () => ({
        revision: "1",
        dueNodeIds: [],
        nextBeforeNode: null,
      })),
    renewFollowingIfDue:
      overrides.renewFollowingIfDue ??
      (async () => false),
    outboxPage:
      overrides.outboxPage ??
      (async () => ({ revision: "1", items: [], nextBeforeSequence: null })),
    drain:
      overrides.drain ??
      (async () => drainResult()),
    retry:
      overrides.retry ??
      (async () => drainResult()),
  };
}

function status(
  overrides: Partial<WagyuBackendStatus> = {},
): WagyuBackendStatus {
  return {
    node: "aaaaa-aa",
    networkId: Array.from({ length: 32 }, () => 0),
    networkConfigured: false,
    protocol: "wagyu_v1",
    profileGeneration: "1",
    profileRevision: "0",
    certifiedAssetsReady: true,
    releaseGateMessage: null,
    stateRevision: "1",
    feedRevision: "1",
    notificationRevision: "1",
    relationshipRevision: "1",
    unreadFeedCount: 0,
    unreadNotificationCount: 0,
    outboundWorkPending: false,
    outboxQueuedCount: 0,
    outboxErrorCount: 0,
    outboxPaused: false,
    pauseReason: null,
    ...overrides,
  };
}

function drainResult(
  overrides: Partial<WagyuDrainResult> = {},
): WagyuDrainResult {
  return {
    stateRevision: "2",
    outboxRevision: "2",
    attempted: 1,
    completed: 1,
    remaining: 0,
    errors: 0,
    paused: false,
    pauseReason: null,
    ...overrides,
  };
}

function outboxPage(): WagyuOutboxPage {
  return {
    revision: "1",
    nextBeforeSequence: null,
    items: [outboxItem("7")],
  };
}

function outboxItem(localSequence: string) {
  return {
    localSequence,
    recipient: "aaaaa-aa",
    route: "deliver" as const,
    state: "uncertain" as const,
    attemptCount: 1,
    retryable: true,
    nextRetryAtNs: "1",
    lastError: "response lost",
    createdAtNs: "0",
    updatedAtNs: "1",
    fanout: null,
  };
}

function memoryStorage(
  initial: WagyuResidentStoredProjection | null,
): WagyuResidentStorage & { saved: WagyuResidentStoredProjection[] } {
  const saved: WagyuResidentStoredProjection[] = [];
  return {
    saved,
    load: () => initial,
    save: (value) => {
      saved.push(value);
    },
  };
}

function fakeScheduler(): WagyuResidentScheduler & { delays: number[] } {
  let nextHandle = 1;
  const delays: number[] = [];
  return {
    delays,
    set: (delayMs) => {
      delays.push(delayMs);
      return nextHandle++;
    },
    clear: () => undefined,
  };
}
