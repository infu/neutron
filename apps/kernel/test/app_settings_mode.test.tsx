import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BackendCallReservation } from "../src/backend_calls/service.ts";
import { AppSettingsEntry } from "../src/settings/AppSettingsEntry.tsx";
import type { CapabilitySummary } from "../src/settings/capability_registry.ts";
import type { KernelUiMode } from "../src/ui_mode.ts";
import { registryApp } from "./app_registry_fixture.ts";

const entry = registryApp({
  id: "networked_app",
  name: "Networked App",
  description: "Connects to a weather service",
  background: {
    path: "background.html",
    description: "Keeps weather current",
  },
  backend: {
    capabilities: {
      backend_calls: { api: 1 },
      https_outcalls: { api: 1 },
      randomness: { api: 1 },
    },
  },
  capabilities: {
    backend_calls: {
      api: 1,
      description: "Connect to approved services",
      reservation_scopes: ["principal"],
      max_concurrency: 2,
      max_cycles_per_call: 1_000_000_000_000,
      max_cycles_per_day: 10_000_000_000_000,
    },
    https_outcalls: {
      api: 1,
      endpoints: [
        {
          id: "weather",
          url_prefix: "https://api.example.com/v1/",
          methods: ["get", "post"],
          request_headers: ["accept"],
          max_request_bytes: 65_536,
          max_response_bytes: 32_768,
          transform: "strip_headers",
        },
      ],
    },
    randomness: { api: 1 },
  },
});

const reservation: BackendCallReservation = {
  id: 4n,
  appId: "networked_app",
  installationUid: 7n,
  scopeKind: "principal",
  principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  method: null,
  createdAt: 1_700_000_000_000_000_000n,
  createdBy: "aaaaa-aa",
};

test("normal app details keep material access and controls without developer diagnostics", () => {
  const html = renderEntry("normal");

  expect(html).toContain('data-tid="settings-app-normal-networked_app"');
  expect(html).toContain("Neutron keeps this app in its own protected space");
  expect(html).toContain("Installed from a repository · package integrity verified");
  expect(html).toContain("Other canisters");
  expect(html).toContain("All methods on ryjl3-tyaaa-aaaaa-aaaba-cai");
  expect(html).toContain("Broad access · remains approved until revoked");
  expect(html).toContain("Revoke backend access 4");
  expect(html).toContain("External services");
  expect(html).toContain("https://api.example.com/v1/");
  expect(html).toContain("The destination and IC subnet replicas can read that data");
  expect(html).toContain("Runs automatically");
  expect(html).toContain("Background activity");
  expect(html).toContain("Other app features");
  expect(html).toContain("Secure randomness");
  expect(html).toContain("Turn off Canister access for Networked App");
  expect(html).toContain("Turn off https://api.example.com/v1/ for Networked App");

  expect(html).not.toContain("Capability plan");
  expect(html).not.toContain("grant: declaration");
  expect(html).not.toContain("Runtime operation counts");
  expect(html).not.toContain("Resident process");
  expect(html).not.toContain("Backend functions");
  expect(html).not.toContain("Manifest SHA-256");
  expect(html).not.toContain(entry.capability_plan_fingerprint);
});

test("developer app details retain the exact capability and package view", () => {
  const html = renderEntry("developer");

  expect(html).not.toContain('data-tid="settings-app-normal-networked_app"');
  expect(html).toContain("Capability plan");
  expect(html).toContain(entry.capability_plan_fingerprint);
  expect(html).toContain("grant: owner runtime grant");
  expect(html).toContain("Runtime operation counts");
  expect(html).toContain("Resident process");
  expect(html).toContain("background.html");
  expect(html).toContain("Manifest SHA-256");
});

test("resident settings distinguish an ephemeral credential partition from persistent browser storage", () => {
  const dedicatedEntry = registryApp({
    id: "ephemeral_resident",
    name: "Ephemeral Resident",
    background: {
      path: "background.html",
      description: "Runs a worker",
    },
    capabilities: {
      dedicated_resident_origin: {
        api: 1,
        surface: "background",
        mode: "credentialless_ephemeral_v1",
      },
    },
  });
  const persistentEntry = registryApp({
    id: "persistent_resident",
    name: "Persistent Resident",
    background: {
      path: "background.html",
      description: "Keeps local state",
    },
    capabilities: {
      persistent_browser_storage: {
        api: 1,
        surface: "background",
      },
    },
  });

  for (const uiMode of ["normal", "developer"] as const) {
    const ephemeralHtml = renderStaticEntry(
      uiMode,
      "ephemeral_resident",
      dedicatedEntry,
    );
    expect(ephemeralHtml).toContain(
      "isolated resident origin with ephemeral credential partition",
    );
    expect(ephemeralHtml.toLowerCase()).toContain(
      "browser storage apis may still exist",
    );
    expect(ephemeralHtml).toContain("persistent browser storage");
    expect(ephemeralHtml).not.toContain("opaque, no storage");
    expect(ephemeralHtml).not.toContain("storage APIs disabled");

    const persistentHtml = renderStaticEntry(
      uiMode,
      "persistent_resident",
      persistentEntry,
    );
    expect(persistentHtml).toContain("persistent browser storage");
    expect(persistentHtml).not.toContain(
      "isolated resident origin with ephemeral credential partition",
    );
    expect(persistentHtml.toLowerCase()).not.toContain(
      "browser storage apis may still exist",
    );
  }
});

test("headless apps use the trusted fallback icon without fetching a missing tile asset", () => {
  const headless = registryApp({
    id: "headless_app",
    name: "Headless App",
    tiles: [],
  });
  const html = renderStaticEntry("normal", "headless_app", headless);

  expect(html).toContain("settings-app-icon");
  expect(html).toContain("<svg");
  expect(html).not.toContain("/app/headless_app/static/icon.png");
});

test("Certified Assets settings show derived publication and blob policy", () => {
  const publicationEntry = registryApp({
    id: "publisher",
    name: "Publisher",
    backend: { capabilities: { certified_assets: { api: 2 } } },
    capabilities: {
      certified_assets: {
        api: 2,
        max_entries: 768,
        max_committed_bytes: 201_326_592,
        max_object_bytes: 67_108_864,
        max_pending_stages: 1,
        max_staged_bytes: 67_108_864,
        max_batch_operations: 1,
        max_batch_bytes: 67_108_864,
        max_idempotency_receipts: 2_048,
        collections: [
          {
            id: "shares",
            mount: "shares",
            kind: "publication",
          },
        ],
      },
    },
  });
  const blobEntry = registryApp({
    id: "object_store",
    name: "Object Store",
    backend: { capabilities: { certified_assets: { api: 2 } } },
    capabilities: {
      certified_assets: {
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
            kind: "immutable_blob",
            path_prefix: "/v1/objects/post/sha256/",
          },
          {
            id: "like_heads",
            mount: "protocol",
            kind: "mutable_blob",
            path_prefix: "/v1/heads/likes/",
            max_object_bytes: 4_096,
          },
          {
            id: "profile",
            mount: "protocol",
            kind: "mutable_blob",
            exact_path: "/v1/profile",
            max_object_bytes: 266_240,
          },
        ],
      },
    },
  });

  const publicationRouteSummary: CapabilitySummary = {
    ...capability("certified_read_routes", "shares"),
    appId: "publisher",
    planFingerprint: publicationEntry.capability_plan_fingerprint,
  };

  for (const uiMode of ["normal", "developer"] as const) {
    const publicationHtml = renderStaticEntry(
      uiMode,
      "publisher",
      publicationEntry,
      [publicationRouteSummary],
    );
    expect(publicationHtml).toContain(
      'data-capability-kind="certified_read_routes"',
    );
    expect(publicationHtml).not.toContain(
      'data-capability-kind="http_routes"',
    );
    expect(publicationHtml).toContain(
      uiMode === "normal"
        ? "Turn off /app/publisher/_route/shares for Publisher"
        : "Disable certified_read_routes resource shares for this app",
    );
    expect(publicationHtml).toContain("/app/publisher/_route/shares");
    expect(publicationHtml).toContain("GET, HEAD");
    expect(publicationHtml.toLowerCase()).toContain("public plaintext");
    expect(publicationHtml).toContain("67,108,864 bytes");
    expect(publicationHtml).toContain("2,048");
    expect(publicationHtml).toContain("2,816");
    expect(publicationHtml).toContain("24 hours");
    expect(publicationHtml).toContain(
      "Kernel-allocated opaque path plus a safe filename",
    );
    expect(publicationHtml).toContain(
      "Host-bound GET and HEAD with bounded ranges",
    );
    expect(publicationHtml).toContain(
      "inert inline text or a forced-download attachment",
    );
    expect(publicationHtml).toContain("no-store; no CORS");
    expect(publicationHtml).toContain("Write freeze");
    expect(publicationHtml).toContain("route disable");
    expect(publicationHtml).toContain("fixed certified 404");
    expect(publicationHtml).toContain(
      "Host-bound, no-store certified 404 without CORS",
    );

    const blobHtml = renderStaticEntry(uiMode, "object_store", blobEntry);
    expect(blobHtml).toContain("/app/object_store/_route/protocol");
    expect(blobHtml).toContain("GET");
    expect(blobHtml.toLowerCase()).toContain(
      "portable across supported gateways",
    );
    expect(blobHtml).toContain("/v1/objects/post/sha256/");
    expect(blobHtml).toContain("/v1/heads/likes/");
    expect(blobHtml).toContain("/v1/profile");
    expect(blobHtml).toContain("immutable public cache");
    expect(blobHtml).toContain("revalidation cache");
    expect(blobHtml).toContain("passive application/octet-stream");
    expect(blobHtml).toContain("anonymous wildcard CORS without credentials");
    expect(blobHtml).toContain("Write freeze");
    expect(blobHtml).toContain("route disable");
    expect(blobHtml).toContain(
      "Portable, no-store certified 404 with anonymous wildcard CORS and no credentials",
    );
    for (const html of [publicationHtml, blobHtml]) {
      for (const legacy of [
        "Files",
        "Wagyu",
        "public Candid",
        "files_",
        "public_candid_",
      ]) {
        expect(html).not.toContain(legacy);
      }
    }
  }
});

function renderEntry(uiMode: KernelUiMode): string {
  return renderToStaticMarkup(
    <table>
      <AppSettingsEntry
        backendReservations={[reservation]}
        capabilityActionsDisabled={false}
        capabilityOperation={null}
        capabilitySummaries={[
          capability("backend_calls", "default"),
          capability("https_outcalls", "weather"),
          capability("randomness", "default"),
        ]}
        dependencies={[]}
        dependents={[]}
        entry={entry}
        id="networked_app"
        uiMode={uiMode}
        usage={{ kind: "ready", usage: null }}
        memories={[]}
        onRevokeReservation={() => undefined}
        onSetCapabilityEnabled={() => undefined}
        onUninstall={() => undefined}
        provenance={{
          kind: "repository",
          repository: "qhbym-qaaaa-aaaaa-aaafq-cai",
          manifest_id: "default",
          manifest_digest: "a".repeat(64),
          package_digest: "b".repeat(64),
        }}
        registry={{ networked_app: entry }}
        reservationActionsDisabled={false}
        runtimeVersion={100n}
        scheduledTasks={[]}
        transitiveDependentIds={[]}
        uninstallDisabled={false}
        uninstallTitle="Uninstall Networked App"
        update={null}
      />
    </table>,
  );
}

function renderStaticEntry(
  uiMode: KernelUiMode,
  appId: string,
  appEntry: ReturnType<typeof registryApp>,
  capabilitySummaries: CapabilitySummary[] = [],
): string {
  return renderToStaticMarkup(
    <table>
      <AppSettingsEntry
        backendReservations={[]}
        capabilityActionsDisabled={false}
        capabilityOperation={null}
        capabilitySummaries={capabilitySummaries}
        dependencies={[]}
        dependents={[]}
        entry={appEntry}
        id={appId}
        uiMode={uiMode}
        usage={{ kind: "ready", usage: null }}
        memories={[]}
        onRevokeReservation={() => undefined}
        onSetCapabilityEnabled={() => undefined}
        onUninstall={() => undefined}
        registry={{ [appId]: appEntry }}
        reservationActionsDisabled={false}
        runtimeVersion={100n}
        scheduledTasks={[]}
        transitiveDependentIds={[]}
        uninstallDisabled={false}
        uninstallTitle={`Uninstall ${appEntry.name}`}
        update={null}
      />
    </table>,
  );
}

function capability(
  kind: CapabilitySummary["kind"],
  resourceId: string,
): CapabilitySummary {
  return {
    appId: "networked_app",
    installationUid: "7",
    planFingerprint: entry.capability_plan_fingerprint,
    kind,
    resourceId,
    api: 1,
    declarationFingerprint: "c".repeat(64),
    grant: kind === "backend_calls" ? "owner_runtime_grant" : "declaration",
    toggleable: true,
    enabled: true,
    createdAt: 1_700_000_000_000_000_000n,
    createdBy: "aaaaa-aa",
    updatedAt: 1_700_000_000_000_000_000n,
    updatedBy: "aaaaa-aa",
    usage: {
      total: 3n,
      succeeded: 2n,
      denied: 0n,
      failed: 1n,
      rateLimited: 0n,
      busy: 0n,
      revoked: 0n,
      lastAt: null,
      lastOperation: null,
      lastOutcome: null,
    },
  };
}
