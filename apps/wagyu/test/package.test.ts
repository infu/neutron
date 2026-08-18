import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { buildCapabilityPlan } from "neutron-tools/src/capabilities/plan.js";
import { physicalPublicIngressMethodName } from "neutron-tools/src/physical_names.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendSourceUrl = new URL("../backend/main.mo", import.meta.url);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("Wagyu manifest is a semantically valid format-3 app package", async () => {
  const manifest = await readManifest();

  expect(validate_neutron_conf(manifest).errors).toEqual([]);
  expect(() => buildCapabilityPlan(manifest)).not.toThrow();
  expect(manifest).toMatchObject({
    format: 3,
    id: "wagyu",
    name: "Wagyu",
    version: 305,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    src: "main.mo",
    backend: {
      capabilities: {
        backend_calls: { api: 1 },
        deferred_timers: { api: 1 },
        certified_assets: { api: 2 },
      },
    },
    background: { path: "service.html" },
    tray: { path: "tray.html", icon: "static/wagyu-steak-topdown-v2.png" },
    tiles: [{ id: "wagyu", path: "index.html", icon: "static/wagyu-steak-topdown-v2.png" }],
    memory: {
      wagyu: {
        version: 3,
        schemas: {
          "1": { src: "memory/wagyu/v1.mo" },
          "2": { src: "memory/wagyu/v2.mo" },
          "3": { src: "memory/wagyu/v3.mo" },
        },
        migrations: [
          {
            from: 1,
            to: 2,
            src: "memory/wagyu/v1_to_v2.mo",
          },
        ],
      },
    },
  });
  const migrations = manifest.memory?.wagyu?.migrations ?? [];
  expect(
    migrations.some((migration) => migration.from === 2 && migration.to === 3),
  ).toBe(false);
  expect(manifest).not.toHaveProperty("init_arg");
  expect(manifest.capabilities?.persistent_browser_storage).toEqual({
    api: 1,
    surface: "background",
  });
});

test("Wagyu exposes exactly the five paid push routes and one shared dispatcher", async () => {
  const manifest = await readManifest();
  const routes = manifest.capabilities?.public_ingress?.routes;

  expect(routes).toEqual([
    {
      protocol: "wagyu_v1",
      id: "follow",
      handler: "wagyu_ingress_follow_v1",
      mode: "update",
      caller: "canister",
      max_request_bytes: 1_024,
      max_response_bytes: 256,
      max_calls_per_hour: 120,
      max_calls_per_caller_per_hour: 12,
      required_cycles: 7_000_000_000,
    },
    {
      protocol: "wagyu_v1",
      id: "unfollow",
      handler: "wagyu_ingress_unfollow_v1",
      mode: "update",
      caller: "canister",
      max_request_bytes: 512,
      max_response_bytes: 128,
      max_calls_per_hour: 240,
      max_calls_per_caller_per_hour: 24,
      required_cycles: 50_000_000,
    },
    {
      protocol: "wagyu_v1",
      id: "deliver",
      handler: "wagyu_ingress_deliver_v1",
      mode: "update",
      caller: "canister",
      max_request_bytes: 16_384,
      max_response_bytes: 512,
      max_calls_per_hour: 1_800,
      max_calls_per_caller_per_hour: 240,
      required_cycles: 200_000_000,
    },
    {
      protocol: "wagyu_v1",
      id: "like",
      handler: "wagyu_ingress_like_v1",
      mode: "update",
      caller: "canister",
      max_request_bytes: 8_192,
      max_response_bytes: 512,
      max_calls_per_hour: 1_080,
      max_calls_per_caller_per_hour: 120,
      required_cycles: 250_000_000,
    },
    {
      protocol: "wagyu_v1",
      id: "notice",
      handler: "wagyu_ingress_notice_v1",
      mode: "update",
      caller: "canister",
      max_request_bytes: 1_024,
      max_response_bytes: 256,
      max_calls_per_hour: 360,
      max_calls_per_caller_per_hour: 60,
      required_cycles: 100_000_000,
    },
  ]);

  expect(
    routes?.reduce(
      (total, route) => total + (route.max_calls_per_hour ?? 0),
      0,
    ),
  ).toBe(3_600);
  expect(
    physicalPublicIngressMethodName("wagyu", "wagyu_v1", "update"),
  ).toBe("app_wagyu__wagyu_v1_update");

  for (const route of routes ?? []) {
    expect(manifest.func?.[route.handler]).toEqual({
      type: "update",
      async: false,
      arg: ["caller"],
    });
  }
});

test("Wagyu certified storage uses only closed generic collection kinds", async () => {
  const manifest = await readManifest();
  const capabilities = manifest.capabilities;

  expect(capabilities).not.toHaveProperty("http_routes");
  expect(capabilities?.certified_assets).toEqual({
    api: 2,
    max_entries: 100_000,
    max_committed_bytes: 1_073_741_824,
    max_object_bytes: 1_048_576,
    max_pending_stages: 1,
    max_staged_bytes: 1_048_576,
    max_batch_operations: 16,
    max_batch_bytes: 1_048_576,
    max_idempotency_receipts: 4_096,
    collections: [
      {
        id: "posts",
        mount: "protocol",
        path_prefix: "/v1/objects/post/sha256/",
        kind: "immutable_blob",
        max_object_bytes: 1_044_480,
      },
      {
        id: "shares",
        mount: "protocol",
        path_prefix: "/v1/objects/share/sha256/",
        kind: "immutable_blob",
      },
      {
        id: "tombstones",
        mount: "protocol",
        path_prefix: "/v1/objects/tombstone/sha256/",
        kind: "immutable_blob",
      },
      {
        id: "likes",
        mount: "protocol",
        path_prefix: "/v1/objects/like/sha256/",
        kind: "immutable_blob",
      },
      {
        id: "like_batches",
        mount: "protocol",
        path_prefix: "/v1/objects/like-batch/sha256/",
        kind: "immutable_blob",
        max_object_bytes: 983_040,
      },
      {
        id: "like_heads",
        mount: "protocol",
        path_prefix: "/v1/heads/likes/",
        kind: "mutable_blob",
        max_object_bytes: 4_096,
      },
      {
        id: "reply_indexes",
        mount: "protocol",
        path_prefix: "/v1/heads/replies/",
        kind: "mutable_blob",
        max_object_bytes: 1_044_480,
      },
      {
        id: "profile",
        mount: "protocol",
        exact_path: "/v1/profile",
        kind: "mutable_blob",
        max_object_bytes: 266_240,
      },
    ],
  });
});

test("Wagyu freezes API-1 owner calls, outbound calls, and unattended work", async () => {
  const manifest = await readManifest();
  const capabilities = manifest.capabilities;
  const selfCalls = capabilities?.preapproved_self_calls;

  expect(capabilities?.backend_calls).toEqual({
    api: 1,
    description:
      "Push paid Wagyu V1 actions to owner-approved peer Neutron canisters",
    reservation_scopes: ["method"],
    install_reservations: [
      { kind: "method", method: "app_wagyu__wagyu_v1_update" },
    ],
    max_concurrency: 20,
    max_cycles_per_call: 7_000_000_000,
    max_cycles_per_day: 10_000_000_000_000,
  });
  expect(capabilities?.scheduled_tasks).toEqual({
    api: 1,
    tasks: [
      {
        id: "outbox",
        method: "wagyu_outbox_tick",
        interval_seconds: 86_400,
        run_on_start: true,
        max_backend_calls: 20,
      },
    ],
  });
  expect(manifest.func?.wagyu_outbox_tick).toEqual({
    type: "internal",
    async: "async*",
    arg: ["task_capabilities"],
  });
  expect(manifest.func?.wagyu_notification_promote).toMatchObject({
    type: "update",
    async: "async*",
  });
  expect(manifest.func?.wagyu_notification_promote_self_v1).toMatchObject({
    type: "update",
    async: "async*",
  });

  expect(selfCalls?.api).toBe(1);
  if (!selfCalls || selfCalls.api !== 1) {
    throw new Error("Wagyu requires preapproved_self_calls API 1");
  }
  expect(selfCalls.methods).toEqual([
    "wagyu_status",
    "wagyu_profile",
    "wagyu_get_send_quote_v1",
    "wagyu_relationships",
    "wagyu_unfollow",
    "wagyu_block",
    "wagyu_unblock",
    "wagyu_notifications_mark_read",
    "wagyu_authored_page",
    "wagyu_outbox_page",
    "wagyu_outbox_drain",
    "wagyu_outbox_retry",
    "wagyu_feed_page_self_v1",
    "wagyu_notification_page_self_v1",
    "wagyu_notification_evidence_self_v1",
    "wagyu_block_statuses_self_v1",
    "wagyu_profile_edit_v1",
    "wagyu_follow_self_v1",
    "wagyu_auto_renew_self_v1",
    "wagyu_post_prepare_self_v1",
    "wagyu_share_prepare_self_v1",
    "wagyu_like_prepare_self_v1",
    "wagyu_tombstone_prepare_self_v1",
    "wagyu_post_finalize_self_v1",
    "wagyu_share_finalize_self_v1",
    "wagyu_like_finalize_self_v1",
    "wagyu_tombstone_finalize_self_v1",
    "wagyu_feed_promote_self_v1",
    "wagyu_feed_reject_self_v1",
    "wagyu_notification_promote_self_v1",
    "wagyu_like_seal_self_v1",
    "wagyu_withdrawal_advance_self_v1",
  ]);
  expect(selfCalls.methods).toHaveLength(32);
  for (const method of [
    "wagyu_network_configure",
    "wagyu_network_configure_dialog_v1",
    "wagyu_profile_edit_self_v1",
    "wagyu_get_feed_page_v1",
    "wagyu_get_notification_page_v1",
    "wagyu_get_notification_evidence_v1",
    "wagyu_follow",
    "wagyu_post_publish",
    "wagyu_share_publish",
    "wagyu_like_publish",
    "wagyu_action_finalize",
    "wagyu_post_delete",
    "wagyu_like_seal",
    "wagyu_withdrawal_advance",
    "wagyu_feed_promote",
    "wagyu_feed_reject",
    "wagyu_notification_promote",
  ]) {
    expect(
      selfCalls.methods.includes(method),
      `${method} must require an explicit dialog or use its owner bridge`,
    ).toBe(false);
  }
  expect(manifest.func?.wagyu_network_configure).toBeUndefined();
  expect(manifest.func?.wagyu_network_configure_dialog_v1).toBeUndefined();
});

test("Wagyu binds its installation before run-on-start mutates durable state", async () => {
  const source = await readFile(backendSourceUrl, "utf8");
  const taskStart = source.indexOf(
    "public func /*internal*/wagyu_outbox_tick(",
  );
  const binding = source.indexOf(
    "let ?_installation = installationContext() else return;",
    taskStart,
  );
  const firstSchedulerWork = source.indexOf(
    "let tickTime = nowNs();",
    taskStart,
  );

  expect(taskStart).toBeGreaterThanOrEqual(0);
  expect(binding).toBeGreaterThan(taskStart);
  expect(firstSchedulerWork).toBeGreaterThan(binding);
});
