import { describe, expect, test } from "bun:test";
import {
  reconcileUnreadNotificationsFromResident,
} from "../src/app/App.tsx";
import { createPreviewWagyuService } from "../src/app/demo_data.ts";
import type { WagyuResidentSnapshot } from "../src/resident/orchestrator.ts";

describe("mark-read badge reconciliation", () => {
  test("reconciles only the unread notification count from fresh authoritative resident status", async () => {
    const current = await createPreviewWagyuService().loadSnapshot();
    const resident = residentSnapshot({
      notificationRevision: current.notifications.revision,
      unreadNotificationCount: 0,
    });

    const reconciled = reconcileUnreadNotificationsFromResident(
      current,
      resident,
    );

    expect(reconciled).not.toBe(current);
    expect(reconciled.status).toEqual({
      ...current.status,
      unreadNotifications: 0,
    });
    expect(reconciled.profile).toBe(current.profile);
    expect(reconciled.feed).toBe(current.feed);
    expect(reconciled.authored).toBe(current.authored);
    expect(reconciled.notifications).toBe(current.notifications);
    expect(reconciled.relationships).toBe(current.relationships);
  });

  test("rejects cached, failed, and revision-stale resident status", async () => {
    const current = await createPreviewWagyuService().loadSnapshot();
    current.notifications.revision = "8";
    const authoritative = residentSnapshot({
      notificationRevision: "8",
      unreadNotificationCount: 0,
    });

    expect(
      reconcileUnreadNotificationsFromResident(current, {
        ...authoritative,
        source: "cached",
      }),
    ).toBe(current);
    expect(
      reconcileUnreadNotificationsFromResident(current, {
        ...authoritative,
        lastError: {
          operation: "status",
          message: "status query failed",
          atMs: 1,
        },
      }),
    ).toBe(current);
    expect(
      reconcileUnreadNotificationsFromResident(
        current,
        residentSnapshot({
          notificationRevision: "7",
          unreadNotificationCount: 0,
        }),
      ),
    ).toBe(current);
  });
});

function residentSnapshot(
  statusOverrides: Partial<
    NonNullable<WagyuResidentSnapshot["status"]>
  > = {},
): WagyuResidentSnapshot {
  return {
    version: 1,
    residentRevision: "2",
    source: "authoritative",
    phase: "ready",
    autoDrainEnabled: true,
    pauseReason: null,
    operation: null,
    lastAuthoritativeAtMs: 1,
    consecutiveFailures: 0,
    lastError: null,
    badge: null,
    status: {
      node: "aaaaa-aa",
      networkId: Array.from({ length: 32 }, () => 0),
      networkConfigured: true,
      protocol: "wagyu_v1",
      profileGeneration: "1",
      profileRevision: "1",
      certifiedAssetsReady: true,
      releaseGateMessage: null,
      stateRevision: "2",
      feedRevision: "1",
      notificationRevision: "2",
      relationshipRevision: "1",
      unreadFeedCount: 0,
      unreadNotificationCount: 0,
      outboundWorkPending: false,
      outboxQueuedCount: 0,
      outboxErrorCount: 0,
      outboxPaused: false,
      pauseReason: null,
      ...statusOverrides,
    },
    notificationItems: [],
    outboxItems: [],
  };
}
