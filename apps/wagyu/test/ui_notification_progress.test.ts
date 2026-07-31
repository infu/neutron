import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type {
  NotificationItem,
  NotificationPage,
} from "../src/app/model.ts";
import {
  notificationEvidenceNeedsAutomaticHydration,
  progressOlderNotificationProofs,
} from "../src/app/notification_progress.ts";

describe("older notification proof progression", () => {
  test("the tile serializes cursor progression behind loaded evidence", async () => {
    const app = await readFile(
      new URL("../src/app/App.tsx", import.meta.url),
      "utf8",
    );

    expect(app).toContain("notificationProofProgressTailRef.current");
    expect(app).toContain("progressOlderNotificationProofs({");
    expect(app).toContain("pendingNotificationEvidenceSignature.length > 0");
    expect(app).toContain("snapshot?.notifications.nextCursor");
    expect(app).toContain(
      "verifyNotification(item, true, signal, false)",
    );
  });

  test("advances pending evidence across discarded pages in bounded batches", async () => {
    const controller = new AbortController();
    const pages = new Map<string, NotificationPage>([
      [
        "50",
        page(
          "49",
          [
            notification("49", "reply"),
            notification("48", "like"),
            notification("47", "share"),
            notification("46", "follow"),
          ],
        ),
      ],
      [
        "49",
        page(
          null,
          [
            notification("45", "reply"),
            notification("44", "like"),
          ],
        ),
      ],
    ]);
    const hydrated: string[] = [];
    const loads: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let pauses = 0;

    await progressOlderNotificationProofs({
      initialCursor: "50",
      signal: controller.signal,
      proofBatch: 2,
      proofConcurrency: 2,
      loadPage: async (cursor) => {
        loads.push(cursor);
        const value = pages.get(cursor);
        if (!value) throw new Error(`Missing fake page ${cursor}`);
        return value;
      },
      hydrate: async (item) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        hydrated.push(item.id);
        const source = pages.get("50")?.items.includes(item)
          ? pages.get("50")
          : pages.get("49");
        if (source) {
          source.items = source.items.map((candidate) =>
            candidate.id === item.id
              ? { ...candidate, verification: "verified" }
              : candidate
          );
        }
        active -= 1;
      },
      pause: async () => {
        pauses += 1;
      },
    });

    expect(hydrated).toEqual([
      "notification-49",
      "notification-48",
      "notification-47",
      "notification-45",
      "notification-44",
    ]);
    expect(loads.filter((cursor) => cursor === "50").length).toBe(3);
    expect(loads).toContain("49");
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(pauses).toBeGreaterThan(0);
  });

  test("stops after cancellation and never starts the next page", async () => {
    const controller = new AbortController();
    const hydrated: string[] = [];
    const loads: string[] = [];

    await progressOlderNotificationProofs({
      initialCursor: "50",
      signal: controller.signal,
      loadPage: async (cursor) => {
        loads.push(cursor);
        return page(
          cursor === "50" ? "49" : null,
          cursor === "50" ? [notification("48", "reply")] : [
            notification("40", "share"),
          ],
        );
      },
      hydrate: async (item) => {
        hydrated.push(item.id);
        controller.abort();
      },
      pause: async () => undefined,
    });

    expect(hydrated).toEqual(["notification-48"]);
    expect(loads).toEqual(["50"]);
  });

  test("selects only pending reply, like, and share evidence", () => {
    expect(
      notificationEvidenceNeedsAutomaticHydration(
        notification("1", "reply"),
      ),
    ).toBeTrue();
    expect(
      notificationEvidenceNeedsAutomaticHydration(
        notification("2", "follow"),
      ),
    ).toBeFalse();
    expect(
      notificationEvidenceNeedsAutomaticHydration({
        ...notification("3", "like"),
        verification: "verified",
      }),
    ).toBeFalse();
  });
});

function page(
  nextCursor: string | null,
  items: NotificationItem[],
): NotificationPage {
  return { revision: "1", items, nextCursor };
}

function notification(
  sequence: string,
  kind: NotificationItem["kind"],
): NotificationItem {
  return {
    id: `notification-${sequence}`,
    localSequence: sequence,
    receivedAt: "2026-07-25T00:00:00.000Z",
    actorNodeId: "aaaaa-aa",
    actorDisplayName: null,
    actorAvatarUrl: null,
    actorProfileProof: "loading",
    kind,
    verification: kind === "follow" ? "transport-authenticated" : "pending",
    read: false,
    targetPostId: kind === "follow" ? null : "11".repeat(32),
    targetBodyHash: kind === "follow" ? null : "22".repeat(32),
    actionId: kind === "follow" ? null : "33".repeat(32),
    objectDigest: kind === "follow" ? null : "44".repeat(32),
    objectLength: kind === "follow" ? null : 1,
    verifiedReply: null,
  };
}
