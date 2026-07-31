import { describe, expect, test } from "bun:test";
import type { JsonObject } from "neutron-tools/app";
import {
  parseWagyuBackendStatus,
  parseWagyuDrainResult,
  parseWagyuOutboxPage,
  parseWagyuRenewalPage,
  trayBadgeForStatus,
} from "../src/resident/contracts.ts";
import {
  parseStoredProjection,
  type WagyuResidentStoredProjection,
} from "../src/resident/storage.ts";
import {
  parseResidentSnapshot,
  residentSnapshotJson,
  wagyuResidentSnapshotSchema,
} from "../src/resident/wire.ts";
import type { WagyuResidentSnapshot } from "../src/resident/orchestrator.ts";

describe("Wagyu resident backend boundary", () => {
  test("accepts the one closed shared status contract and derives a bounded badge", () => {
    const parsed = parseWagyuBackendStatus(statusWire({
      network_id: "07".repeat(32),
      unread_feed_count: "4",
      unread_notification_count: "3",
      outbound_work_pending: true,
      outbox_error_count: "2",
    }));
    expect(parsed.node).toBe("aaaaa-aa");
    expect(parsed.networkId).toEqual(bytes(32, 7));
    expect(parsed.networkConfigured).toBeTrue();
    expect(parsed.protocol).toBe("wagyu_v1");
    expect(parsed.unreadFeedCount).toBe(4);
    expect(parsed.unreadNotificationCount).toBe(3);
    expect(parsed.outboundWorkPending).toBeTrue();
    expect(parsed.outboxErrorCount).toBe(2);
    expect(trayBadgeForStatus(parsed)).toBe(3);
  });

  test("rejects unknown status fields, malformed network ids, and incoherent pause state", () => {
    expect(() =>
      parseWagyuBackendStatus({ ok: statusWire() })
    ).toThrow("invalid response");
    expect(() =>
      parseWagyuBackendStatus({ err: { invalid: null } })
    ).toThrow("invalid response");
    expect(() =>
      parseWagyuBackendStatus(statusWire({ extra: "not allowed" }))
    ).toThrow("invalid response");
    expect(() =>
      parseWagyuBackendStatus(statusWire({ network_configured: true }))
    ).toThrow("invalid response");
    expect(() =>
      parseWagyuBackendStatus(statusWire({
        network_id: "01".repeat(31),
      }))
    ).toThrow("network id");
    expect(() =>
      parseWagyuBackendStatus(statusWire({
        network_id: bytes(32, 1),
      }))
    ).toThrow("network id");
    expect(() =>
      parseWagyuBackendStatus(statusWire({
        release_gate_message: null,
      }))
    ).toThrow("release gate message");
    expect(() =>
      parseWagyuBackendStatus(statusWire({
        pause_reason: [{ low_cycles: null }],
      }))
    ).toThrow("pause reason");
    expect(() =>
      parseWagyuBackendStatus(statusWire({
        outbox_paused: false,
        pause_reason: { low_cycles: null },
      }))
    ).toThrow("pause reason");
    expect(() =>
      parseWagyuBackendStatus(statusWire({
        outbound_work_pending: "true",
      }))
    ).toThrow("outbound work state");
    expect(() =>
      parseWagyuBackendStatus(statusWire({
        outbound_work_pending: false,
        outbox_queued_count: "1",
      }))
    ).toThrow("outbound work state");
    const missingPending = statusWire();
    delete missingPending.outbound_work_pending;
    expect(() => parseWagyuBackendStatus(missingPending)).toThrow(
      "invalid response",
    );
  });

  test("keeps an unknown optional outbox state unsupported without selecting retry", () => {
    const page = parseWagyuOutboxPage({
      revision: "4",
      items: [
        {
          local_sequence: "9",
          recipient: "aaaaa-aa",
          route: { future_route: null },
          state: { future_state: null },
          attempt_count: "1",
          retryable: false,
          created_at_ns: "1",
          updated_at_ns: "2",
        },
      ],
    });
    expect(page.items).toEqual([
      {
        localSequence: "9",
        recipient: "aaaaa-aa",
        route: "unsupported",
        state: "unsupported",
        attemptCount: 1,
        retryable: false,
        nextRetryAtNs: null,
        lastError: null,
        createdAtNs: "1",
        updatedAtNs: "2",
        fanout: null,
      },
    ]);
  });

  test("parses bounded partial fanout recipient accounting", () => {
    const page = parseWagyuOutboxPage(fanoutPageWire());
    expect(page.nextBeforeSequence).toBe("9");
    expect(page.items[0]).toMatchObject({
      route: "deliver",
      state: "uncertain",
      fanout: {
        jobId: "3",
        state: "partial",
        completedRecipientCount: 3,
        terminalRecipientCount: 1,
        uncertainRecipientCount: 1,
      },
    });
  });

  test("rejects predecessor array and null encodings for projected options", () => {
    expect(() =>
      parseWagyuOutboxPage({
        revision: "4",
        next_before_sequence: ["9"],
        items: [],
      })
    ).toThrow("next outbox sequence");
    expect(() =>
      parseWagyuOutboxPage({
        revision: "4",
        items: [{
          local_sequence: "9",
          recipient: "aaaaa-aa",
          route: [{ deliver: null }],
          state: { queued: null },
          attempt_count: "0",
          retryable: false,
          created_at_ns: "1",
          updated_at_ns: "1",
        }],
      })
    ).toThrow("outbox route");
    expect(() =>
      parseWagyuOutboxPage({
        revision: "4",
        items: [{
          local_sequence: "9",
          recipient: "aaaaa-aa",
          state: { queued: null },
          attempt_count: "0",
          retryable: false,
          created_at_ns: "1",
          updated_at_ns: "1",
          fanout: null,
        }],
      })
    ).toThrow("fanout progress");
  });

  test("requires numeric, bounded Nat32 fanout recipient counts", () => {
    for (
      const field of [
        "eligible_recipient_count",
        "queued_recipient_count",
        "completed_recipient_count",
        "terminal_recipient_count",
        "uncertain_recipient_count",
      ]
    ) {
      expect(() =>
        parseWagyuOutboxPage(fanoutPageWire({ [field]: "1" }))
      ).toThrow("invalid response");
    }

    for (const invalid of [-1, 1.5, 100_001, Number.MAX_SAFE_INTEGER]) {
      expect(() =>
        parseWagyuOutboxPage(
          fanoutPageWire({ eligible_recipient_count: invalid }),
        )
      ).toThrow("eligible recipient count");
    }
  });

  test("validates bounded drain accounting", () => {
    expect(
      parseWagyuDrainResult({
        state_revision: "10",
        outbox_revision: "8",
        attempted: "20",
        completed: "18",
        remaining: "3",
        errors: "2",
        paused: false,
      }),
    ).toMatchObject({ attempted: 20, completed: 18, remaining: 3 });
    expect(() =>
      parseWagyuDrainResult({
        state_revision: "10",
        outbox_revision: "8",
        attempted: "1",
        completed: "2",
        remaining: "0",
        errors: "0",
        paused: false,
      })
    ).toThrow("completed count");
  });
});

describe("Wagyu resident relationship renewal boundary", () => {
  test("treats the peer renewal hint as diagnostic unless local backend accounting says due", () => {
    const peer = "rrkah-fqaaa-aaaaa-aaaaq-cai";

    const page = parseWagyuRenewalPage({
      revision: "9",
      items: [
        renewalRow(peer, {
          following_renewal_requested: true,
          following_auto_renew_due: false,
        }),
      ],
    });

    expect(page).toEqual({
      revision: "9",
      dueNodeIds: [],
      nextBeforeNode: null,
    });
  });

  test("skips semantically ineligible due rows without poisoning eligible peers", () => {
    const blocked = "rrkah-fqaaa-aaaaa-aaaaq-cai";
    const incompatible = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    const notFollowing = "r7inp-6aaaa-aaaaa-aaabq-cai";
    const registering = "rkp4c-7iaaa-aaaaa-aaaca-cai";
    const eligible = "qoctq-giaaa-aaaaa-aaaea-cai";
    const lastIneligible = "qsgjb-riaaa-aaaaa-aaaga-cai";

    const page = parseWagyuRenewalPage({
      revision: "8",
      items: [
        renewalRow(blocked, {
          blocked: true,
          following_state: { blocked: null },
        }),
        renewalRow(incompatible, {
          compatible: false,
          following_state: { incompatible: null },
        }),
        renewalRow(notFollowing, {
          following: false,
          following_state: { expired: null },
        }),
        renewalRow(registering, {
          following_state: { registering: null },
        }),
        renewalRow(eligible),
        renewalRow(lastIneligible, {
          following_state: { cleanup_pending: null },
        }),
      ],
      next_before_node: lastIneligible,
    });

    expect(page).toEqual({
      revision: "8",
      dueNodeIds: [eligible],
      nextBeforeNode: lastIneligible,
    });
  });

  test("still structurally validates a semantically skipped row", () => {
    const eligible = "rrkah-fqaaa-aaaaa-aaaaq-cai";
    const malformedBlocked = "ryjl3-tyaaa-aaaaa-aaaba-cai";

    expect(() =>
      parseWagyuRenewalPage({
        revision: "8",
        items: [
          renewalRow(eligible),
          renewalRow(malformedBlocked, {
            blocked: true,
            following_state: { blocked: null },
            follower_delivery_credits: "0",
          }),
        ],
        next_before_node: malformedBlocked,
      })
    ).toThrow("follower delivery credits");
  });
});

describe("Wagyu resident rebuildable cache and tray wire", () => {
  test("publishes only tool-safe linear schema patterns", () => {
    for (const pattern of schemaPatterns(wagyuResidentSnapshotSchema)) {
      expect(pattern).not.toContain("(");
      expect(pattern).not.toMatch(/\\[1-9]/u);
    }
  });

  test("round-trips a closed stored projection", () => {
    const projection: WagyuResidentStoredProjection = {
      version: 1,
      autoDrainEnabled: false,
      lastAuthoritativeAtMs: 500,
      status: parseWagyuBackendStatus(statusWire({
        network_id: "03".repeat(32),
        outbound_work_pending: true,
        outbox_queued_count: "3",
      })),
    };
    expect(parseStoredProjection(projection)).toEqual(projection);
    expect(parseStoredProjection({ ...projection, canonical: true })).toBeNull();

    const storedStatus = projection.status;
    if (storedStatus === null) throw new Error("Expected stored status fixture");
    const { outboundWorkPending: _, ...legacyStatus } = storedStatus;
    expect(parseStoredProjection({
      ...projection,
      status: legacyStatus,
    })).toEqual({
      ...projection,
      status: {
        ...storedStatus,
        outboundWorkPending: true,
      },
    });
  });

  test("round-trips the bounded tray snapshot and rejects count tampering", () => {
    const snapshot = residentSnapshot();
    expect(parseResidentSnapshot(residentSnapshotJson(snapshot))).toEqual(snapshot);
    expect(() =>
      parseResidentSnapshot({
        ...residentSnapshotJson(snapshot),
        badge: 10_000,
      })
    ).toThrow("tray badge");
  });
});

function schemaPatterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaPatterns);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.pattern === "string" ? [record.pattern] : []),
    ...Object.values(record).flatMap(schemaPatterns),
  ];
}

function statusWire(overrides: JsonObject = {}): JsonObject {
  return {
    node: "aaaaa-aa",
    network_id: "00".repeat(32),
    protocol: "wagyu_v1",
    profile_generation: "1",
    profile_revision: "0",
    certified_assets_ready: true,
    state_revision: "1",
    feed_revision: "1",
    notification_revision: "1",
    relationship_revision: "1",
    unread_feed_count: "0",
    unread_notification_count: "0",
    outbound_work_pending: false,
    outbox_queued_count: "0",
    outbox_error_count: "0",
    outbox_paused: false,
    ...overrides,
  };
}

function renewalRow(node: string, overrides: JsonObject = {}): JsonObject {
  return {
    node,
    following: true,
    follower: false,
    following_state: { active: null },
    follower_delivery_credits: 0,
    following_renewal_requested: false,
    following_auto_renew_due: true,
    blocked: false,
    bond_cycles: "7000000000",
    protocol: "wagyu_v1",
    compatible: true,
    ...overrides,
  };
}

function fanoutPageWire(fanoutOverrides: JsonObject = {}): JsonObject {
  return {
    revision: "4",
    next_before_sequence: "9",
    items: [
      {
        local_sequence: "9",
        recipient: "aaaaa-aa",
        route: { deliver: null },
        state: { uncertain: null },
        attempt_count: "2",
        retryable: true,
        created_at_ns: "1",
        updated_at_ns: "2",
        fanout: {
          job_id: "3",
          state: { partial: null },
          eligible_recipient_count: 5,
          queued_recipient_count: 5,
          completed_recipient_count: 3,
          terminal_recipient_count: 1,
          uncertain_recipient_count: 1,
          ...fanoutOverrides,
        },
      },
    ],
  };
}

function residentSnapshot(): WagyuResidentSnapshot {
  const status = parseWagyuBackendStatus(statusWire({
    network_id: "02".repeat(32),
    unread_notification_count: "1",
  }));
  return {
    version: 1,
    residentRevision: "7",
    source: "authoritative",
    phase: "ready",
    autoDrainEnabled: true,
    pauseReason: null,
    operation: null,
    lastAuthoritativeAtMs: 500,
    consecutiveFailures: 0,
    lastError: null,
    badge: 1,
    status,
    notificationItems: [],
    outboxItems: [],
  };
}

function bytes(length: number, value: number): number[] {
  return Array.from({ length }, () => value);
}
