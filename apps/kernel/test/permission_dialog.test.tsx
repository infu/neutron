import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRequestDialog,
  PermissionDisclosure,
} from "../src/AppDialogs.tsx";
import { safeInstallOfferUrl } from "../src/install_offers/InstallOfferDialog.tsx";
import {
  BackendCallRequest,
  BinaryFieldInspectionList,
  CandidMethodName,
  CanonicalJsonReview,
  FrontendToolRequest,
  canonicalJsonForDisplay,
} from "../src/Requests.tsx";
import { useMsgBusPermissionStore } from "../src/reducer/msg_bus.ts";
import { configInstallDisclosures } from "../src/lib/perm.ts";
import {
  isAuthorityPendingState,
  snapshotAppInstallRequest,
  useAppsStore,
  type AppInstallRequestInput,
} from "../src/reducer/apps.ts";
import { AppSettingsEntry } from "../src/settings/AppSettingsEntry.tsx";
import { Launcher } from "../src/workspace/Launcher.tsx";
import { launcherEntriesFromApps } from "../src/workspace/launcher_entries.ts";
import { WorkspaceView } from "../src/workspace/WorkspaceView.tsx";
import { useWorkspaceStore } from "../src/workspace/store.ts";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { buildCapabilityPlan } from "neutron-tools/src/capabilities/plan.js";
import { diffCapabilityPlans } from "neutron-tools/src/capabilities/wire.js";
import { registryApp } from "./app_registry_fixture.ts";
import { uninstallDeploymentRecordFixture } from "./deployment_record_fixture.ts";
import type { CapabilitySummary } from "../src/settings/capability_registry.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

afterEach(() => {
  useAppsStore.setState({
    request: null,
    compiled: null,
    pendingInstallRecovery: null,
    runtimeAuthorityFence: null,
  });
  useMsgBusPermissionStore.setState({ requests: {} });
});

type FixtureInstallRequest = Omit<
  AppInstallRequestInput,
  "packageName" | "packageVersion" | "packageDigest"
> &
  Partial<
    Pick<
      AppInstallRequestInput,
      "packageName" | "packageVersion" | "packageDigest"
    >
  >;

function fixtureAppInstallRequest(request: FixtureInstallRequest) {
  const {
    packageName = request.id,
    packageVersion = 100,
    packageDigest = "0".repeat(64),
    ...rest
  } = request;
  return snapshotAppInstallRequest({
    ...rest,
    packageName,
    packageVersion,
    packageDigest,
  });
}

test("manual install exposes the exact build review before enabling its final action", () => {
  const html = renderToStaticMarkup(
    <AppRequestDialog
      compiled={{
        size: 1,
        deploymentReview: {
          record: uninstallDeploymentRecordFixture(),
          suppliedPackages: [],
        },
      }}
      request={fixtureAppInstallRequest({
        id: "hello",
        size: 1,
        capabilityPlanFingerprint: "a".repeat(64),
        capabilityDisclosures: [],
        permissions: [],
      })}
    />,
  );

  const reviewIndex = html.indexOf('data-tid="deployment-build-review"');
  const acceptIndex = html.indexOf('data-tid="install-accept"');
  expect(reviewIndex).toBeGreaterThan(-1);
  expect(acceptIndex).toBeGreaterThan(reviewIndex);
  expect(html).toContain("Deployment ready");
  expect(html).not.toContain("Raw compiler Wasm");
  expect(html).not.toContain("Transport Wasm");
  const accept = html.match(/<button[^>]*data-tid="install-accept"[^>]*>/u)?.[0];
  expect(accept).toBeDefined();
  expect(accept).not.toContain("disabled");

  const developerHtml = renderToStaticMarkup(
    <AppRequestDialog
      compiled={{
        size: 1,
        deploymentReview: {
          record: uninstallDeploymentRecordFixture(),
          suppliedPackages: [],
        },
      }}
      request={fixtureAppInstallRequest({
        id: "hello",
        size: 1,
        capabilityPlanFingerprint: "a".repeat(64),
        capabilityDisclosures: [],
        permissions: [],
      })}
      uiMode="developer"
    />,
  );
  expect(developerHtml).toContain(
    "Build and installation details",
  );
  expect(developerHtml).toContain("Raw compiler Wasm");
  expect(developerHtml).toContain("Transport Wasm");
  expect(developerHtml).not.toContain(
    '<details open=""><summary>Build and installation details</summary>',
  );
});

test("launcher exposes a real modal dialog boundary", () => {
  const html = renderToStaticMarkup(<Launcher onClose={() => undefined} open />);
  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-modal="true"');
  expect(html).toContain('aria-label="App launcher"');
  expect(html).toContain('tabindex="-1"');
  expect(html).toContain('role="group"');
  expect(html).toContain('aria-label="Install app from"');
  expect(html).toContain('aria-label="Install app from File"');
  expect(html).toContain('aria-label="Install app from URL"');
  expect(html).toContain('data-tid="launcher-install-package"');
  expect(html).toContain('data-tid="launcher-install-package-url"');
  expect(html).toContain(
    'class="launcher-tile-row launcher-install-entry"',
  );
  expect(html).toContain('class="launcher-install-icon"');
  expect(
    html.indexOf('class="launcher-tile-row launcher-install-entry"'),
  ).toBeGreaterThan(html.indexOf('class="launcher-results"'));
});

test("launcher reuses its controls as a non-modal workspace region", () => {
  const html = renderToStaticMarkup(
    <Launcher placement="workspace" workspaceId={1} />,
  );
  expect(html).toContain('role="region"');
  expect(html).toContain('aria-label="App launcher"');
  expect(html).toContain('class="launcher launcher--workspace"');
  expect(html).toContain('data-tid="workspace-launcher"');
  expect(html).toContain('data-tid="workspace-launcher-install-package"');
  expect(html).toContain('data-tid="workspace-launcher-install-package-url"');
  expect(html).toContain(
    'class="launcher-tile-row launcher-install-entry"',
  );
  expect(html).not.toContain('class="launcher-actions');
  expect(html).not.toContain('aria-modal="true"');
  expect(html).not.toContain('class="launcher-backdrop"');
  expect(html).not.toContain('data-tid="launcher-reset-workspace"');
});

test("launcher opens installed tiles without exposing app deletion", async () => {
  const apps = {
    mail: registryApp({
      id: "mail",
      name: "Mail",
      tiles: [
        {
          id: "main",
          title: "Mail",
          path: "index.html",
          icon: "static/icon.png",
        },
      ],
    }),
  };
  expect(launcherEntriesFromApps(apps)).toMatchObject(
    [{ appId: "mail", appName: "Mail", tileId: "main", title: "Mail" }],
  );
  const source = await fs.readFile(
    path.join(repoRoot, "apps/kernel/src/workspace/Launcher.tsx"),
    "utf8",
  );
  expect(source).not.toContain("uninstall");
  expect(source).not.toContain("IoTrashOutline");
});

test("a pending install disables launcher mutations without hiding the launcher", async () => {
  useAppsStore.getState().setPendingInstallRecovery({
    deploymentId: "deploy00000000000000000000000000",
    runningTarget: true,
    blockers: [],
  });
  expect(isAuthorityPendingState(useAppsStore.getState())).toBe(true);
  const source = await fs.readFile(
    path.join(repoRoot, "apps/kernel/src/workspace/Launcher.tsx"),
    "utf8",
  );
  expect(source).toContain(
    "const appMutationBlocked = operationBusy || authorityPending",
  );
  expect(source.match(/disabled=\{installSource !== null \|\| appMutationBlocked\}/g))
    .toHaveLength(4);
});

test("only the interactive empty workspace mounts the shared launcher", () => {
  useWorkspaceStore.getState().resetCurrentWorkspace();
  const active = renderToStaticMarkup(
    <WorkspaceView active interactive workspaceId={1} />,
  );
  expect(active).toContain('data-tid="workspace-empty"');
  expect(active).toContain('data-tid="workspace-launcher"');

  const retained = renderToStaticMarkup(
    <WorkspaceView active={false} interactive={false} workspaceId={1} />,
  );
  expect(retained).toContain('data-tid="workspace-empty"');
  expect(retained).not.toContain('data-tid="workspace-launcher"');
});

test("Chess install renders every verified capability separately from app prose", async () => {
  const chess = JSON.parse(
    await fs.readFile(path.join(repoRoot, "apps/chess/neutron.json"), "utf8"),
  ) as NeutronManifest;
  const disclosure = configInstallDisclosures(chess);
  const request = fixtureAppInstallRequest({
    id: chess.id,
    size: 100,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 50 }} request={request} />,
  );
  expect(html).toContain('role="alertdialog"');
  expect(html).toContain('aria-modal="true"');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain("Requested access — kernel-verified");
  expect(html).toContain("Installation itself grants no canister or method target");
  expect(html).toContain("8 calls in flight or in one batch");
  expect(html).toContain('data-scope="exact"');
  for (const method of [
    "chess_get_game",
    "chess_create_game",
    "chess_move",
    "chess_sync_game",
    "chess_join_game",
    "chess_action",
    "chess_undo",
    "chess_remote_push_target",
    "chess_remote_exchange_v1",
  ]) {
    expect(html).toContain(method);
  }
  expect(html).toContain("App-provided explanation — unverified");
  expect(html).toContain('data-source="app"');
  expect(html).toContain(
    "Send paid Chess commands and pushed state to an owner-approved peer Neutron",
  );
  expect(html).toContain(
    "400,000,000 cycles accepted by the kernel and attributed to this app",
  );
});

test("API-1 self-call install review shows exact methods and modes", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "attachment_app",
    name: "Attachment App",
    version: 100,
    func: {
      lookup: { type: "query" },
      upload: { type: "update" },
    },
    capabilities: {
      preapproved_self_calls: {
        api: 1,
        methods: ["lookup", "upload"],
      },
    },
  });
  const request = fixtureAppInstallRequest({
    id: "attachment_app",
    size: 100,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 50 }} request={request} />,
  );
  expect(html).toContain("Preapproved same-app calls (2)");
  expect(html).toContain("<code>lookup</code>");
  expect(html).toContain("Query — reads canister state");
  expect(html).toContain("<code>upload</code>");
  expect(html).toContain("Update — may change canister state");
  expect(html).not.toContain("Input attachment");
  expect(html).not.toContain("Output attachment");
  expect(html).not.toContain("Candid transport ABI");
});

test("trusted binary review renders only exact path, size, and SHA-256", () => {
  const sha256 = "ab".repeat(32);
  const html = renderToStaticMarkup(
    <BinaryFieldInspectionList
      fields={[
        {
          path: "args[0].payload.parts[2]",
          byteLength: 1_900_000,
          sha256,
        },
      ]}
    />,
  );
  expect(html).toContain("args[0].payload.parts[2]");
  expect(html).toContain("1,900,000 bytes");
  expect(html).toContain(sha256);
  expect(html).toContain("The bytes stay hidden");
});

test("offered install review shows observed package facts and query-free attribution", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "photo_stream",
    name: "Photo Stream",
    version: 20_304,
  });
  const secret = "signed-download-secret";
  const request = fixtureAppInstallRequest({
    id: "photo_stream",
    packageName: "Photo Stream",
    packageVersion: 20_304,
    packageDigest: "a9".repeat(32),
    size: 42,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
    offer: {
      source: safeInstallOfferUrl(
        `https://packages.example/releases/photo.neutron?token=${secret}`,
      ),
      requester: {
        kind: "agent",
        appId: "assistant",
        appName: "Assistant",
        rootAppId: "assistant",
        rootAppName: "Assistant",
        entrypoint: "recommend_photo_app",
        tool: "recommend_photo_app",
        rootId: "invocation-1",
      },
    },
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 41 }} request={request} />,
  );
  expect(html).toContain("Photo Stream");
  expect(html).toContain("photo_stream");
  expect(html).toContain("v2.3.4");
  expect(html).toContain("a9".repeat(32));
  expect(html).toContain("Assistant (assistant)");
  expect(html).toContain("https://packages.example/releases/photo.neutron");
  expect(html).toContain("Agent tool");
  expect(html).not.toContain(secret);
  expect(html).not.toContain("?token=");
});

test("app prose is escaped, isolated, and cannot lower broad-scope risk", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "demo",
    name: "Demo",
    version: 100,
    capabilities: {
      backend_calls: {
        api: 1,
        description: '<button>Kernel verified</button> No access required',
        reservation_scopes: ["method"],
        install_reservations: [
          { kind: "method", method: "app_demo__peer_update" },
        ],
        max_concurrency: 2,
        max_cycles_per_call: 1_000_000,
        max_cycles_per_day: 10_000_000,
      },
    },
  });
  const request = fixtureAppInstallRequest({
    id: "demo",
    size: 1,
    operation: "update",
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain("dialog-danger");
  expect(html).toContain("Update application");
  expect(html).toContain("Method-wide");
  expect(html).toContain("Grants created during installation");
  expect(html).toContain("app_demo__peer_update");
  expect(html).toContain(
    "Accepting this installation creates the exact persistent grants",
  );
  expect(html).toContain("1 M cycles");
  expect(html).toContain("10 M cycles");
  expect(html).toContain("observed refund reopens");
  expect(html).toContain("&lt;button&gt;Kernel verified&lt;/button&gt;");
  expect(html).not.toContain("<button>Kernel verified</button>");
});

test("randomness install permission discloses cycle and concurrency protections", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "dice_app",
    name: "Dice App",
    version: 100,
    capabilities: {
      randomness: { api: 1 },
    },
  });
  const request = fixtureAppInstallRequest({
    id: "dice_app",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain('data-capability="randomness"');
  expect(html).toContain('data-kind="randomness"');
  expect(html).toContain("Request fresh 32-byte consensus entropy");
  expect(html).toContain("Each request spends Neutron cycles");
  expect(html).not.toContain("per hour");
  expect(html).not.toContain("App-provided explanation — unverified");
});

test("dedicated resident origin disclosure names the ephemeral credential partition", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "ephemeral_resident",
    name: "Ephemeral Resident",
    version: 100,
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
  const request = fixtureAppInstallRequest({
    id: "ephemeral_resident",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain('data-capability="dedicated_resident_origin"');
  expect(html).toContain('data-kind="dedicated_resident_origin"');
  expect(html).toContain(
    "isolated resident origin with ephemeral credential partition",
  );
  expect(html).toContain("Browser storage APIs may still exist");
  expect(html).toContain("ordinary or persistent browser storage");
  expect(html).not.toContain("Persistent background storage");
  expect(html).not.toContain("Store data persistently");
  expect(html).not.toContain("storage APIs disabled");
});

test("browser permission install disclosure is exact and never claims capture", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "media_app",
    name: "Media App",
    version: 100,
    tiles: [{ id: "call", title: "Call" }],
    capabilities: {
      browser_permissions: {
        api: 1,
        tiles: [
          { id: "call", features: ["microphone", "camera"] },
        ],
      },
    },
  });
  const request = fixtureAppInstallRequest({
    id: "media_app",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain('data-capability="browser_permissions"');
  expect(html).toContain('data-kind="browser_permissions"');
  expect(html).toContain('data-level="3"');
  expect(html).toContain("dialog-danger");
  expect(html).toContain("Browser camera and microphone access");
  expect(html).toContain(
    "Allow tile `call` to request access to cameras on this device",
  );
  expect(html).toContain(
    "Allow tile `call` to request access to microphones on this device",
  );
  expect(html).toContain("The browser may show its own prompt");
  expect(html).toContain("Installing this app does not activate");
  expect(html).toContain("including while its workspace is hidden");
  expect(html).toContain("browser&#x27;s device indicator remains authoritative");
  expect(html).toContain("approved upgrades");
  expect(html).toContain("Browser and site settings can separately deny it");
  expect(html).not.toContain("currently active");
});

test("browser permission headline names only the declared feature", () => {
  const cameraHtml = renderToStaticMarkup(
    <PermissionDisclosure
      permission={{
        source: "kernel",
        kind: "browser_permissions",
        tiles: [{ id: "call", features: ["camera"] }],
      }}
    />,
  );
  const microphoneHtml = renderToStaticMarkup(
    <PermissionDisclosure
      permission={{
        source: "kernel",
        kind: "browser_permissions",
        tiles: [{ id: "call", features: ["microphone"] }],
      }}
    />,
  );

  expect(cameraHtml).toContain("Browser camera access");
  expect(cameraHtml).not.toContain("microphone access");
  expect(microphoneHtml).toContain("Browser microphone access");
  expect(microphoneHtml).not.toContain("camera access");
});

test("chain-key consent discloses autonomous bounded assertion authority", () => {
  const purpose = "App claims this signs harmless login challenges";
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "assertion_app",
    name: "Assertion App",
    version: 100,
    capabilities: {
      chain_key_signing: {
        api: 1,
        slots: [{
          id: "login_assertion",
          algorithm: "ecdsa_secp256k1",
          purpose,
          max_assertion_bytes: 1024,
        }],
      },
    },
  });
  const request = fixtureAppInstallRequest({
    id: "assertion_app",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain('data-capability="chain_key_signing"');
  expect(html).toContain('data-kind="chain_key_signing"');
  expect(html).toContain("Autonomous cryptographic assertions");
  expect(html).toContain("assertions it chooses without asking each time");
  expect(html).toContain("login_assertion");
  expect(html).toContain("ecdsa_secp256k1");
  expect(html).toContain("1024 bytes");
  expect(html).not.toContain("assertions per hour");
  expect(html).not.toContain("cycles per hour");
  expect(html).toContain("fixed app, installation, and slot domain");
  expect(html).toContain("prevents direct raw blockchain transaction signing");
  expect(html).toContain("treat an assertion as authorization");
  expect(html).toContain("unknown");
  expect(html).toContain("may still have produced a valid signature");
  expect(html).toContain("live on/off control in Settings");
  expect(html).toContain("App-provided explanation — unverified");
  expect(html).toContain("App-provided purpose — unverified");
  expect(html).toContain(purpose);
  expect(html.match(new RegExp(purpose, "g"))).toHaveLength(1);
});

test("stable-store consent discloses exact quotas and ordinary-state privacy", () => {
  const purpose = "App claims this keeps private notes";
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "notes_app",
    name: "Notes",
    version: 100,
    capabilities: {
      stable_store: {
        api: 1,
        stores: [{
          id: "notes",
          purpose,
          schema_version: 2,
          max_entries: 64,
          max_key_bytes: 48,
          max_value_bytes: 4096,
          max_bytes: 65_536,
        }],
      },
    },
  });
  const request = fixtureAppInstallRequest({
    id: "notes_app",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain('data-capability="stable_store"');
  expect(html).toContain('data-kind="stable_store"');
  expect(html).toContain("Durable backend stores (1)");
  expect(html).toContain("Schema 2");
  expect(html).toContain("48 / 4096 bytes");
  expect(html).toContain("65536 bytes");
  expect(html).toContain("ordinary canister state");
  expect(html).toContain("does not encrypt them");
  expect(html).toContain("certify them for public HTTP reads");
  expect(html).toContain("purged when this installation is removed");
  expect(html).toContain("live on/off control in Settings");
  expect(html).toContain("App-provided purpose — unverified");
  expect(html).toContain(purpose);
  expect(html.match(new RegExp(purpose, "g"))).toHaveLength(1);
});

test("HTTPS consent groups endpoints and discloses cost and plaintext boundaries", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "weather_app",
    name: "Weather",
    version: 100,
    capabilities: {
      https_outcalls: {
        api: 1,
        endpoints: [
          {
            id: "weather",
            url_prefix: "https://api.example.com/v1/",
            methods: ["get", "head", "post"],
            request_headers: ["accept", "authorization"],
            max_request_bytes: 65_536,
            max_response_bytes: 32_768,
            transform: "strip_headers",
          },
          {
            id: "status",
            url_prefix: "https://status.example.com/",
            methods: ["get"],
            request_headers: [],
            max_request_bytes: 4096,
            max_response_bytes: 4096,
            transform: "strip_headers",
          },
        ],
      },
    },
  });
  const request = fixtureAppInstallRequest({
    id: "weather_app",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain('data-capability="https_outcalls"');
  expect(html).toContain('data-kind="https_outcalls"');
  expect(html).toContain("External HTTPS endpoints (2)");
  expect(html).toContain("https://api.example.com/v1/");
  expect(html).toContain("GET, HEAD, POST");
  expect(html).toContain("accept, authorization");
  expect(html).toContain("65536 / 32768 bytes");
  expect(html).toContain("quoted per-call cost");
  expect(html).not.toContain("declared calls per hour");
  expect(html).not.toContain("cycles per hour");
  expect(html).toContain("visible to the IC subnet replicas");
  expect(html).toContain("Redirect responses are rejected");
  expect(html).toContain("single-node HTTPS requests");
  expect(html).toContain("not cross-checked by subnet consensus");
  expect(html).toContain("live on/off control in Settings");
  expect(html).toContain("POST requires a caller-supplied idempotency key");
  expect(html).toContain("Authorization is allowed for a declared endpoint");
  expect(html).not.toContain("management canister actor");
});

test("public protocol consent shows route, caller, mode, byte bounds, and update rate", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "mail_peer",
    name: "Mail Peer",
    version: 100,
    capabilities: {
      public_ingress: {
        api: 1,
        routes: [{
          protocol: "mail_v1",
          id: "receive",
          handler: "mail_receive",
          mode: "update",
          caller: "canister",
          max_request_bytes: 39_199,
          max_response_bytes: 1024,
          max_calls_per_hour: 240,
          max_calls_per_caller_per_hour: 24,
          required_cycles: 250_000_000,
        }],
      },
    },
    func: { mail_receive: { type: "update" } },
  });
  const request = fixtureAppInstallRequest({
    id: "mail_peer",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain('data-kind="public_ingress_route"');
  expect(html).toContain("mail_v1:receive");
  expect(html).toContain("Update — may change canister state");
  expect(html).toContain("Canister calls funding the required base charge");
  expect(html).toContain("39199 / 1024 bytes");
  expect(html).toContain(
    "250,000,000 cycles accepted by the kernel and attributed to this app",
  );
  expect(html).toContain("240 admitted calls per hour");
  expect(html).toContain("24 admitted calls per caller per hour");
  expect(html).toContain("Calls below that base trap before app code runs");
  expect(html).toContain("not a total-cost cap");
  expect(html).toContain(
    "may request additional kernel-mediated cycles later in the call",
  );
  expect(html).not.toContain("authorized Neutron principals bypass");
});

test("direct authenticated ingress consent distinguishes owner-funded updates from paid protocols", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "cli_bridge",
    name: "CLI Bridge",
    version: 100,
    capabilities: {
      public_ingress: {
        api: 1,
        routes: [{
          protocol: "cli_v1",
          id: "commit",
          handler: "cli_commit",
          mode: "update",
          caller: "authenticated",
          max_request_bytes: 8192,
          max_response_bytes: 1024,
          max_calls_per_hour: 60,
        }],
      },
    },
    func: { cli_commit: { type: "update", async: false } },
  });
  const request = fixtureAppInstallRequest({
    id: "cli_bridge",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain("Direct ingress from self-authenticating principals only");
  expect(html).toContain("None accepted; this Neutron funds the ingress and app work");
  expect(html).toContain("anonymous and canister principals are rejected");
  expect(html).not.toContain("Required base charge");
});

test("Settings discloses exact canister payment for public updates while queries stay read-only", () => {
  const entry = registryApp({
    id: "mail_peer",
    name: "Mail Peer",
    func: {
      mail_key: { type: "query" },
      mail_receive: { type: "update" },
    },
    capabilities: {
      public_ingress: {
        api: 1,
        routes: [
          {
            protocol: "mail_v1",
            id: "key",
            handler: "mail_key",
            mode: "query",
            caller: "any",
            max_request_bytes: 128,
            max_response_bytes: 4096,
          },
          {
            protocol: "mail_v1",
            id: "receive",
            handler: "mail_receive",
            mode: "update",
            caller: "canister",
            max_request_bytes: 39_199,
            max_response_bytes: 1024,
            max_calls_per_hour: 240,
            required_cycles: 250_000_000,
          },
        ],
      },
    },
  });
  const renderSettings = (uiMode: "normal" | "developer") =>
    renderToStaticMarkup(
      <table>
        <AppSettingsEntry
          backendReservations={[]}
          capabilityActionsDisabled={false}
          capabilityOperation={null}
          capabilitySummaries={[]}
          dependencies={[]}
          dependents={[]}
          entry={entry}
          id="mail_peer"
          uiMode={uiMode}
          usage={{ kind: "ready", usage: null }}
          memories={[]}
          onRevokeReservation={() => undefined}
          onSetCapabilityEnabled={() => undefined}
          onToggleSelected={() => undefined}
          registry={{ mail_peer: entry }}
          reservationActionsDisabled={false}
          runtimeVersion={100n}
          scheduledTasks={[]}
          transitiveDependentIds={[]}
          selected={false}
          selectionDisabled={false}
          selectionTitle="Select Mail Peer for app actions"
          update={null}
        />
      </table>,
    );

  const developerHtml = renderSettings("developer");
  expect(developerHtml).toContain(
    "Compiler-bound, canister-paid public update protocol",
  );
  expect(developerHtml).toContain(
    "required base charge 250,000,000 cycles",
  );
  expect(developerHtml).toContain("not a total-cost cap");
  expect(developerHtml).toContain(
    "may request additional kernel-mediated cycles later in the call",
  );
  expect(developerHtml).toContain(
    "Compiler-bound public query ingress. Query calls do not change canister state.",
  );

  const normalHtml = renderSettings("normal");
  expect(normalHtml).toContain(
    "inter-canister protocols require their declared base charge",
  );
  expect(normalHtml).toContain(
    "A calling canister must fund the 250,000,000-cycle base charge",
  );
  expect(normalHtml).toContain("mail_v1 reads");
  expect(normalHtml).toContain(
    "Outside callers can read through this endpoint; it cannot change state.",
  );
});

test("Certified Assets install review derives publication policy and routes", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "publisher",
    name: "Publisher",
    version: 100,
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
  const request = fixtureAppInstallRequest({
    id: "publisher",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain('data-kind="http_route"');
  expect(html).toContain("Public certified read route");
  expect(html).toContain("/app/publisher/_route/shares");
  expect(html).toContain("shares");
  expect(html).toContain("GET, HEAD");
  expect(html).toContain("Exact Neutron host (Host-bound)");
  expect(html).toContain("Anyone can read these responses");
  expect(html).toContain("Route disable is separate from write freeze");
  expect(html).toContain("policy-specific certified 404");
  expect(html).toContain('data-kind="certified_assets"');
  expect(html).toContain("Certified public plaintext collections");
  expect(html).toContain("deliberately public plaintext");
  expect(html).toContain("Maximum logical records");
  expect(html).toContain("768");
  expect(html).toContain("192 MiB (201,326,592 bytes)");
  expect(html).toContain("64 MiB (67,108,864 bytes)");
  expect(html).toContain("Active upload stages");
  expect(html).toContain("Maximum batch");
  expect(html).toContain("General receipt lanes");
  expect(html).toContain("2,048");
  expect(html).toContain("Per-record revocation lanes");
  expect(html).toContain("2,816");
  expect(html).toContain("reconcile retries for 24 hours");
  expect(html).toContain(
    "Kernel-allocated opaque path plus a safe filename",
  );
  expect(html).toContain(
    "Host-bound GET and HEAD with bounded ranges",
  );
  expect(html).toContain("inert inline text or a forced-download attachment");
  expect(html).toContain("no-store; no CORS");
  expect(html).toContain(
    "Host-bound, no-store certified 404 without CORS",
  );
  expect(html).toContain("Write freeze does not disable the public route");
  expect(html).toContain("Non-increasing CAS, conditional delete, abort");
  for (const legacy of [
    "Files",
    "Wagyu",
    "public Candid",
    "files_",
    "public_candid_",
  ]) {
    expect(html).not.toContain(legacy);
  }
});

test("Certified Assets install review derives portable blob policies and routes", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "object_store",
    name: "Object Store",
    version: 100,
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
  const request = fixtureAppInstallRequest({
    id: "object_store",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain("/app/object_store/_route/protocol");
  expect(html).toContain("Supported canister gateway (canister-portable proof)");
  expect(html).toContain("GET");
  expect(html).toContain("posts");
  expect(html).toContain(
    "/v1/objects/post/sha256/&lt;64 lowercase body SHA-256 hex&gt;",
  );
  expect(html).toContain("Immutable blob");
  expect(html).toContain("immutable public cache");
  expect(html).toContain("like_heads");
  expect(html).toContain(
    "/v1/heads/likes/&lt;64 lowercase key hex&gt;",
  );
  expect(html).toContain("Mutable blob");
  expect(html).toContain("revalidation cache");
  expect(html).toContain("profile");
  expect(html).toContain("/v1/profile");
  expect(html).toContain("passive application/octet-stream");
  expect(html).toContain(
    "anonymous wildcard CORS without credentials",
  );
  expect(html).toContain(
    "Portable, no-store certified 404 with anonymous wildcard CORS and no credentials",
  );
  expect(html).toContain("Write freeze does not disable the public route");
  for (const legacy of [
    "Files",
    "Wagyu",
    "public Candid",
    "files_",
    "public_candid_",
  ]) {
    expect(html).not.toContain(legacy);
  }
});

test("public POST route consent names handler, bounds, headers, and cycle risk", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "hook_app",
    name: "Hook App",
    version: 100,
    func: {
      receive_hook: { type: "internal", async: false },
    },
    capabilities: {
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "receive",
            surface: "app_host",
            prefix: "/hooks/receive",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "receive_hook",
            max_request_bytes: 32_768,
            max_response_bytes: 8_192,
            max_calls_per_hour: 60,
            forward_headers: ["authorization", "content-type"],
          },
        ],
      },
    },
  });
  const request = fixtureAppInstallRequest({
    id: "hook_app",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain("Public POST → backend handler");
  expect(html).toContain("/hooks/receive");
  expect(html).toContain("receive_hook");
  expect(html).toContain("32768 / 8192 bytes");
  expect(html).toContain("60 accepted non-authorized POSTs per hour");
  expect(html).toContain("Idempotency-Key");
  expect(html).toContain("completed replies replayed for 1 hour");
  expect(html).toContain("authorization");
  expect(html).toContain("content-type");
  expect(html).toContain("spends Neutron cycles");
  expect(html).toContain("authorized Neutron principals bypass");
  expect(html).toContain("240 admissions");
  expect(html).toContain("8 MiB of possible replay replies per hour");
  expect(html).toContain("no separate per-handler instruction allowance");
  expect(html).toContain("a forwarded header is never a Neutron identity");
});

test("shared POST path consent shows the derived path and same-origin boundary", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "shared_routes",
    name: "Shared Routes",
    version: 100,
    func: {
      submit: { type: "internal", async: false },
    },
    capabilities: {
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "submit",
            surface: "shared_app_path",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "submit",
            max_request_bytes: 4096,
            max_response_bytes: 2048,
            max_calls_per_hour: 30,
            forward_headers: ["content-type"],
          },
        ],
      },
    },
  });
  const request = fixtureAppInstallRequest({
    id: "shared_routes",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain("/app/shared_routes/_route/submit");
  expect(html).toContain("Shared Neutron path");
  expect(html).toContain("shares Neutron&#x27;s ordinary browser origin");
  expect(html).toContain("fixed restrictive security headers");
  expect(html).toContain("cannot add CORS, cookies, redirects");
  expect(html).not.toContain("on this app’s dedicated host");
});

test("scheduled task consent names the exact injected capability interface", () => {
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "scheduled_app",
    name: "Scheduled App",
    version: 100,
    func: {
      refresh: { type: "internal", arg: ["task_capabilities"] },
    },
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Refresh remote state",
        reservation_scopes: ["exact"],
        max_concurrency: 1,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
      scheduled_tasks: {
        api: 1,
        tasks: [
          {
            id: "refresh",
            method: "refresh",
            interval_seconds: 3_600,
            run_on_start: false,
            max_backend_calls: 1,
          },
        ],
      },
    },
  });
  const request = fixtureAppInstallRequest({
    id: "scheduled_app",
    size: 1,
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
    appExplanations: disclosure.appExplanations,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 1 }} request={request} />,
  );
  expect(html).toContain("task_capabilities:backend_calls@1");
  expect(html).toContain("Maximum attached per call");
  expect(html).toContain("Maximum charged + unresolved per UTC day");
  expect(html).toContain("A zero per-call ceiling means backend calls cannot attach cycles");
});

test("update consent shows an exact installed-to-target capability diff", () => {
  const previous: NeutronManifest = {
    format: 3,
    id: "update_app",
    name: "Update App",
    version: 100,
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Old unverified explanation",
        reservation_scopes: ["exact"],
        max_concurrency: 2,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
      randomness: { api: 1 },
    },
  };
  const target: NeutronManifest = {
    format: 3,
    id: "update_app",
    name: "Update App",
    version: 101,
    capabilities: {
      randomness: { api: 1 },
      vetkeys: {
        api: 1,
        description: "New unverified explanation",
        slots: [{ id: "private_data", purpose: "Unverified purpose" }],
      },
    },
  };
  const disclosure = configInstallDisclosures(target);
  const diff = diffCapabilityPlans(
    buildCapabilityPlan(previous),
    buildCapabilityPlan(target),
  );
  const request = fixtureAppInstallRequest({
    id: target.id,
    size: 10,
    operation: "update",
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityPlanDiff: diff,
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
  });
  diff.entries.splice(0, diff.entries.length);
  expect(request.capabilityPlanDiff?.entries).toHaveLength(2);
  expect(Object.isFrozen(request.capabilityPlanDiff?.entries)).toBe(true);

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 5 }} request={request} />,
  );
  expect(html).toContain('data-tid="install-capability-diff"');
  expect(html).toContain('data-change="removed"');
  expect(html).not.toContain('data-change="changed"');
  expect(html).toContain('data-change="added"');
  expect(html).toContain("Removed · Backend canister calls");
  expect(html).toContain("Added · Private key slots");
  expect(html).toContain("Installed authority config");
  expect(html).toContain("Target authority config");
  expect(html).not.toContain("max_requests_per_hour");
  expect(html).toContain(
    request.capabilityPlanDiff!.previous.plan_fingerprint,
  );
  expect(html).toContain(request.capabilityPlanDiff!.target.plan_fingerprint);
  expect(html).toContain(
    "does not guess that a JSON change is narrower or safer",
  );
  expect(html).not.toContain("Old unverified explanation");
  expect(html).not.toContain("New unverified explanation");
  expect(html).not.toContain("Unverified purpose");
});

test("browser permission updates show the exact feature change", () => {
  const manifest = (
    version: number,
    features: Array<"camera" | "microphone">,
  ): NeutronManifest => ({
    format: 3,
    id: "media_update",
    name: "Media Update",
    version,
    tiles: [{ id: "call", title: "Call" }],
    capabilities: {
      browser_permissions: {
        api: 1,
        tiles: [{ id: "call", features }],
      },
    },
  });
  const previous = manifest(100, ["camera"]);
  const target = manifest(101, ["microphone", "camera"]);
  const disclosure = configInstallDisclosures(target);
  const request = fixtureAppInstallRequest({
    id: target.id,
    size: 10,
    operation: "update",
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityPlanDiff: diffCapabilityPlans(
      buildCapabilityPlan(previous),
      buildCapabilityPlan(target),
    ),
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 5 }} request={request} />,
  );
  expect(html).toContain('data-change="changed"');
  expect(html).toContain("Changed · Browser device access");
  expect(html).toContain("Installed authority config");
  expect(html).toContain("Target authority config");
  expect(html).toContain('&quot;camera&quot;');
  expect(html).toContain('&quot;microphone&quot;');
  expect(html).toContain(
    "Allow tile `call` to request access to microphones on this device",
  );
  expect(html).not.toContain("currently active");
});

test("update consent identifies a version-only plan change", () => {
  const previous: NeutronManifest = {
    format: 3,
    id: "same_authority",
    name: "Same Authority",
    version: 100,
    capabilities: {
      randomness: { api: 1 },
    },
  };
  const target: NeutronManifest = { ...previous, version: 101 };
  const disclosure = configInstallDisclosures(target);
  const request = fixtureAppInstallRequest({
    id: target.id,
    size: 10,
    operation: "update",
    capabilityPlanFingerprint: disclosure.planFingerprint,
    capabilityPlanDiff: diffCapabilityPlans(
      buildCapabilityPlan(previous),
      buildCapabilityPlan(target),
    ),
    capabilityDisclosures: disclosure.capabilityDisclosures,
    permissions: disclosure.permissions,
  });

  const html = renderToStaticMarkup(
    <AppRequestDialog compiled={{ size: 5 }} request={request} />,
  );
  expect(html).toContain("No capability authority entries changed.");
  expect(html).toContain("Installed plan");
  expect(html).toContain("Target plan");
});

test("runtime backend consent renders its retained source, scope, and complete call", () => {
  const html = renderToStaticMarkup(
    <BackendCallRequest
      request={{
        id: 17,
        attentionToken: "attention-17",
        endpoint: "app:chess:tile:main:instance:game-one",
        endpointSession: "session-one",
        appId: "chess",
        source: {
          role: "tile",
          tileId: "main",
          instanceId: "game-one",
          workspace: 3,
        },
        actions: [
          {
            kind: "reserve",
            scope: {
              kind: "exact",
              principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
              method: "app_chess__chess_remote_exchange_v1",
            },
            reservationPresentAtRequest: false,
          },
        ],
        call: {
          method: "chess_join_game",
          args: [
            {
              tile_id: "game-one",
              host: "ryjl3-tyaaa-aaaaa-aaaba-cai",
              game_id: "invite-123456789012345678901234",
              display_probe: [
                "null",
                null,
                "true",
                true,
                " leading  space ",
                "line\nbreak",
                "Kernel\u202e verified",
                "zero\u200bwidth",
                "variation\u{e0100}",
              ],
            },
          ],
        },
      }}
    />,
  );

  expect(html).toContain('role="alertdialog"');
  expect(html).toContain("game-one");
  expect(html).toContain("Workspace");
  expect(html).toContain("app:chess:tile:main:instance:game-one");
  expect(html).toContain("One canister method");
  expect(html).toContain("ryjl3-tyaaa-aaaaa-aaaba-cai");
  expect(html).toContain("app_chess__chess_remote_exchange_v1");
  expect(html).toContain("Equivalent reservation not stored at request time");
  expect(html).toContain("exact access applies only to the listed canister and method");
  expect(html).toContain("Complete attached-call arguments");
  expect(html).toContain("chess_join_game");
  expect(html).toContain("invite-123456789012345678901234");
  expect(html).toContain("&quot;null&quot;");
  expect(html).toContain("&quot;true&quot;");
  expect(html).toContain("&quot; leading  space &quot;");
  expect(html).toContain("line\\nbreak");
  expect(html).toContain("Kernel\\u202e verified");
  expect(html).toContain("zero\\u200bwidth");
  expect(html).toContain("variation\\udb40\\udd00");
  expect(html).not.toContain("\u202e");
  expect(html).not.toContain("\u200b");
  expect(html).not.toContain("\u{e0100}");
  expect(html).toContain("future app-chosen arguments");
  expect(html).toContain("kernel does not attest their behavior");
});

test("canonical runtime JSON keeps scalar types distinct and escapes spoofing text", () => {
  expect(
    canonicalJsonForDisplay([
      "null",
      null,
      "true",
      true,
      -0,
      "a\tb\nc",
      "safe\u2066spoof\u2069",
      "zero\u200djoin",
      "high\ud800surrogate",
      "low\udfffsurrogate",
    ]),
  ).toBe(
    '[\n  "null",\n  null,\n  "true",\n  true,\n  -0,\n  "a\\tb\\nc",\n  "safe\\u2066spoof\\u2069",\n  "zero\\u200djoin",\n  "high\\ud800surrogate",\n  "low\\udfffsurrogate"\n]',
  );
});

test("generic canister consent review renders exact canonical JSON arguments", () => {
  const html = renderToStaticMarkup(
    <CanonicalJsonReview
      ariaLabel="Canonical JSON for the complete canister call arguments"
      heading="Complete canister call arguments"
      value={[
        "null",
        null,
        "",
        -0,
        "Kernel\u202e verified",
        "zero\u200bwidth",
      ]}
    />,
  );
  expect(html).toContain("Complete canister call arguments");
  expect(html).toContain(
    'aria-label="Canonical JSON for the complete canister call arguments"',
  );
  expect(html).toContain("&quot;null&quot;");
  expect(html).toContain("null");
  expect(html).toContain("&quot;&quot;");
  expect(html).toContain("-0");
  expect(html).toContain("Kernel\\u202e verified");
  expect(html).toContain("zero\\u200bwidth");
  expect(html).not.toContain("\u202e");
  expect(html).not.toContain("\u200b");
});

test("provider-owned tool consent renders the provider review canonically", () => {
  useAppsStore.setState({
    list: {
      requester: registryApp({ id: "requester", name: "Requester" }),
      provider: registryApp({ id: "provider", name: "Provider" }),
    },
  });
  useMsgBusPermissionStore.setState({
    requests: {
      71: {
        cid: 71,
        caller: {
          endpoint: "app:requester:tile:main:instance:requester-one",
          appId: "requester",
          role: "tile",
        },
        target: "app:provider:background",
        tool: "provider_action",
        toolTitle: "Perform Provider Action",
        arguments: {},
        providerReview: {
          action: "create entry",
          cost: "one credit",
          warning: "Kernel\u202e approved\u200b",
        },
        sessionOnly: false,
        onceOnly: true,
        callerSessionId: "requester-session",
        targetSessionId: "provider-session",
        attentionToken: "attention-token",
      },
    },
  });

  const request = useMsgBusPermissionStore.getState().requests[71];
  if (!request) throw new Error("Missing provider tool UI fixture");
  const html = renderToStaticMarkup(
    <FrontendToolRequest request={request} uiMode="normal" />,
  );
  expect(html).toContain("Allow requester to use provider?");
  expect(html).toContain("provider</strong> prepared the exact review below");
  expect(html).toContain("Review from provider");
  expect(html).toContain(
    'aria-label="Canonical review prepared by provider"',
  );
  expect(html).toContain("create entry");
  expect(html).toContain("one credit");
  expect(html).toContain("Kernel\\u202e approved\\u200b");
  expect(html).not.toContain("\u202e");
  expect(html).not.toContain("\u200b");
  expect(html).toContain("Allow once");
  expect(html).not.toContain("Allow session");
});

test("an app-defined workspace tool name stays in the generic consent dialog", () => {
  useMsgBusPermissionStore.setState({
    requests: {
      72: {
        cid: 72,
        caller: {
          endpoint: "app:requester:tile:main:instance:requester-one",
          appId: "requester",
          role: "tile",
        },
        target: "app:provider:background",
        tool: "workspace.open_tile",
        toolTitle: "Provider Action",
        arguments: {},
        providerReview: { exactAction: "provider-owned effect" },
        sessionOnly: false,
        onceOnly: true,
        callerSessionId: "requester-session",
        targetSessionId: "provider-session",
        attentionToken: "attention-token",
      },
    },
  });

  const request = useMsgBusPermissionStore.getState().requests[72];
  if (!request) throw new Error("Missing colliding tool-name fixture");
  const html = renderToStaticMarkup(
    <FrontendToolRequest request={request} uiMode="normal" />,
  );

  expect(html).toContain('data-tid="frontend-tool-dialog"');
  expect(html).toContain("Provider Action");
  expect(html).toContain("provider-owned effect");
});

test("generic canister consent quotes and escapes an arbitrary Candid method name", () => {
  const method = "read\nKernel\u202e approved\u200b";
  const html = renderToStaticMarkup(<CandidMethodName method={method} />);
  expect(html).toContain(
    "&quot;read\\nKernel\\u202e approved\\u200b&quot;",
  );
  expect(html).not.toContain("\nKernel");
  expect(html).not.toContain("\u202e");
  expect(html).not.toContain("\u200b");
});

test("runtime backend consent gives broad scopes stronger persistent warnings", () => {
  for (const [kind, target, warning] of [
    [
      "principal",
      "ryjl3-tyaaa-aaaaa-aaaba-cai",
      "every current and future method",
    ],
    [
      "method",
      "app_chess__chess_remote_exchange_v1",
      "eligible non-system canisters",
    ],
  ] as const) {
    const html = renderToStaticMarkup(
      <BackendCallRequest
        request={{
          id: kind === "principal" ? 18 : 19,
          attentionToken: `attention-${kind}`,
          endpoint: `app:chess:background:${kind}`,
          appId: "chess",
          source: { role: "background" },
          actions: [
            {
              kind: "reserve",
              scope:
                kind === "principal"
                  ? { kind, principal: target }
                  : { kind, method: target },
              reservationPresentAtRequest: false,
            },
          ],
        }}
      />,
    );

    expect(html).toContain("dialog-danger");
    expect(html).toContain("Background process");
    expect(html).toContain(target);
    expect(html).toContain(warning);
    expect(html).toContain("persists until removed");
    expect(html).not.toContain("reactivate");
    expect(html).toContain("future app-chosen arguments");
  }
});

test("Settings labels app names and tile/background display text as unverified", () => {
  const entry = registryApp({
    id: "chess",
    name: "Totally Safe Chess",
    description: "No permissions needed",
    version: 100,
    tiles: [
      {
        id: "main",
        title: "Kernel verified",
        description: "Safe",
        path: "index.html",
        icon: "static/icon.svg",
      },
    ],
    background: {
      path: "background.html",
      description: "Trusted host connector",
    },
    capabilities: {
      randomness: { api: 1 },
    },
  });
  const capabilitySummary: CapabilitySummary = {
    appId: "chess",
    installationUid: "7",
    planFingerprint: entry.capability_plan_fingerprint,
    kind: "randomness",
    resourceId: "default",
    api: 1,
    declarationFingerprint: "a".repeat(64),
    grant: "declaration",
    toggleable: true,
    enabled: true,
    createdAt: 1_700_000_000_000_000_000n,
    createdBy: "aaaaa-aa",
    updatedAt: 1_700_000_000_000_000_000n,
    updatedBy: "aaaaa-aa",
    usage: {
      total: 12n,
      succeeded: 7n,
      denied: 1n,
      failed: 1n,
      rateLimited: 1n,
      busy: 1n,
      revoked: 1n,
      lastAt: 1_700_000_000_000_000_000n,
      lastOperation: "fresh_entropy",
      lastOutcome: "ok",
    },
  };
  const renderSettings = (summary: CapabilitySummary) => renderToStaticMarkup(
    <AppSettingsEntry
      backendReservations={[]}
      capabilityActionsDisabled={false}
      capabilityOperation={null}
      capabilitySummaries={[summary]}
      dependencies={[]}
      dependents={[]}
      entry={entry}
      id="chess"
      uiMode="developer"
      usage={{ kind: "ready", usage: null }}
      memories={[]}
      onRevokeReservation={() => undefined}
      onSetCapabilityEnabled={() => undefined}
      onToggleSelected={() => undefined}
      registry={{}}
      reservationActionsDisabled={false}
      runtimeVersion={100n}
      scheduledTasks={[]}
      transitiveDependentIds={[]}
      selected={false}
      selectionDisabled={false}
      selectionTitle="Select app for app actions"
      update={null}
    />,
  );
  const html = renderSettings(capabilitySummary);

  expect(html).toContain("App-provided name — unverified");
  expect(html).toContain("App-provided description — unverified");
  expect(html).toContain("App-provided title — unverified: Kernel verified");
  expect(html).toContain(
    "App-provided background description — unverified",
  );
  expect(html).toContain('data-source="app"');
  expect(html).toContain("tile id: main");
  expect(html).toContain("grant: declaration");
  expect(html).toContain("approval: owner approval");
  expect(html).toContain("disable: broker enforced");
  expect(html).toContain("revoke: live recheck");
  expect(html).toContain("Bounded concurrency and a kernel low-cycle reserve");
  expect(html).toContain("Persistent bounded outcome totals");
  expect(html).toContain("Active for this app");
  expect(html).toContain('data-capability-resource="default"');
  expect(html).toContain("total 12");
  expect(html).toContain("success 7");
  expect(html).toContain("denied 1");
  expect(html).toContain("failed 1");
  expect(html).not.toContain("rate 1");
  expect(html).toContain("busy 1");
  expect(html).toContain("revoked 1");
  expect(html).toContain("Last fresh entropy");
  expect(html).toContain(
    "Disable randomness resource default for this app",
  );
  const fixedHtml = renderSettings({
    ...capabilitySummary,
    enabled: false,
    toggleable: false,
  });
  expect(fixedHtml).toContain("Disabled for this app");
  expect(fixedHtml).not.toContain(
    "Enable randomness resource default for this app",
  );
});

test("Settings shows preapproved self calls only in Backend functions", () => {
  const entry = registryApp({
    id: "self_call_app",
    name: "Self Call App",
    func: {
      read: { type: "query" },
      refresh: { type: "update" },
    },
    capabilities: {
      preapproved_self_calls: {
        api: 1,
        methods: ["read", "refresh"],
      },
    },
  });
  const html = renderToStaticMarkup(
    <AppSettingsEntry
      backendReservations={[]}
      capabilityActionsDisabled={false}
      capabilityOperation={null}
      capabilitySummaries={[]}
      dependencies={[]}
      dependents={[]}
      entry={entry}
      id="self_call_app"
      uiMode="developer"
      usage={{ kind: "ready", usage: null }}
      memories={[]}
      onRevokeReservation={() => undefined}
      onSetCapabilityEnabled={() => undefined}
      onToggleSelected={() => undefined}
      registry={{}}
      reservationActionsDisabled={false}
      runtimeVersion={100n}
      scheduledTasks={[]}
      transitiveDependentIds={[]}
      selected={false}
      selectionDisabled={false}
      selectionTitle="Select app for app actions"
      update={null}
    />,
  );

  expect(html).toContain("Backend functions");
  expect(html.match(/>preapproved</g)).toHaveLength(2);
  expect(html).not.toContain("Preapproved self calls");
  expect(html).not.toContain("State-changing capability");
  expect(html).not.toContain("Method semantics are app-defined");
});

test("Settings exposes one canonical scheduled-task authority switch", () => {
  const entry = registryApp({
    id: "scheduled_app",
    name: "Scheduled App",
    func: {
      refresh: { type: "internal", arg: ["task_capabilities"] },
    },
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Refresh remote state",
        reservation_scopes: ["exact"],
        max_concurrency: 1,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
      scheduled_tasks: {
        api: 1,
        tasks: [
          {
            id: "refresh",
            method: "refresh",
            interval_seconds: 3_600,
            run_on_start: false,
            max_backend_calls: 1,
          },
        ],
      },
    },
  });
  const summary: CapabilitySummary = {
    appId: "scheduled_app",
    installationUid: "9",
    planFingerprint: entry.capability_plan_fingerprint,
    kind: "scheduled_tasks",
    resourceId: "refresh",
    api: 1,
    declarationFingerprint: "b".repeat(64),
    grant: "declaration",
    toggleable: true,
    enabled: true,
    createdAt: 1_700_000_000_000_000_000n,
    createdBy: "aaaaa-aa",
    updatedAt: 1_700_000_000_000_000_000n,
    updatedBy: "aaaaa-aa",
    usage: {
      total: 0n,
      succeeded: 0n,
      denied: 0n,
      failed: 0n,
      rateLimited: 0n,
      busy: 0n,
      revoked: 0n,
      lastAt: null,
      lastOperation: null,
      lastOutcome: null,
    },
  };
  const html = renderToStaticMarkup(
    <AppSettingsEntry
      backendReservations={[]}
      capabilityActionsDisabled={false}
      capabilityOperation={null}
      capabilitySummaries={[summary]}
      dependencies={[]}
      dependents={[]}
      entry={entry}
      id="scheduled_app"
      uiMode="developer"
      usage={{ kind: "ready", usage: null }}
      memories={[]}
      onRevokeReservation={() => undefined}
      onSetCapabilityEnabled={() => undefined}
      onToggleSelected={() => undefined}
      registry={{}}
      reservationActionsDisabled={false}
      runtimeVersion={100n}
      scheduledTasks={[
        {
          app_id: "scheduled_app",
          installation_uid: 9n,
          id: "refresh",
          method: "refresh",
          interval_seconds: 3_600n,
          run_on_start: false,
          max_backend_calls: 1n,
          enabled: true,
          running: true,
        },
      ]}
      transitiveDependentIds={[]}
      selected={false}
      selectionDisabled={false}
      selectionTitle="Select app for app actions"
      update={null}
    />,
  );

  expect(html).toContain(
    "Disable scheduled_tasks resource refresh for this app",
  );
  expect(html).toContain("0.0000TC maximum gross attached per call");
  expect(html).toContain(
    "0.0000TC maximum charged + unresolved per UTC day",
  );
  expect(html).toContain("refunds reopen dispatch-day headroom");
  expect(html).toContain("running");
  expect(html).not.toContain("Disable Scheduled App task refresh");
});

test("Settings identifies public POST handlers and their exact operating bounds", () => {
  const entry = registryApp({
    id: "hook_app",
    name: "Hook App",
    func: {
      receive_hook: { type: "internal", async: false },
      submit_shared: { type: "internal", async: false },
    },
    capabilities: {
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "receive",
            surface: "app_host",
            prefix: "/hooks/receive",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "receive_hook",
            max_request_bytes: 32_768,
            max_response_bytes: 8_192,
            max_calls_per_hour: 60,
            forward_headers: ["authorization", "content-type"],
          },
          {
            id: "shared_submit",
            surface: "shared_app_path",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "submit_shared",
            max_request_bytes: 1024,
            max_response_bytes: 512,
            max_calls_per_hour: 10,
            forward_headers: [],
          },
        ],
      },
    },
  });
  const summary: CapabilitySummary = {
    appId: "hook_app",
    installationUid: "10",
    planFingerprint: entry.capability_plan_fingerprint,
    kind: "http_routes",
    resourceId: "receive",
    api: 1,
    declarationFingerprint: "c".repeat(64),
    grant: "declaration",
    toggleable: true,
    enabled: true,
    createdAt: 1_700_000_000_000_000_000n,
    createdBy: "aaaaa-aa",
    updatedAt: 1_700_000_000_000_000_000n,
    updatedBy: "aaaaa-aa",
    usage: {
      total: 2n,
      succeeded: 1n,
      denied: 1n,
      failed: 0n,
      rateLimited: 0n,
      busy: 0n,
      revoked: 0n,
      lastAt: 1_700_000_000_000_000_000n,
      lastOperation: "POST",
      lastOutcome: "ok",
    },
  };
  const html = renderToStaticMarkup(
    <AppSettingsEntry
      backendReservations={[]}
      capabilityActionsDisabled={false}
      capabilityOperation={null}
      capabilitySummaries={[summary]}
      dependencies={[]}
      dependents={[]}
      entry={entry}
      id="hook_app"
      uiMode="developer"
      usage={{ kind: "ready", usage: null }}
      memories={[]}
      onRevokeReservation={() => undefined}
      onSetCapabilityEnabled={() => undefined}
      onToggleSelected={() => undefined}
      registry={{}}
      reservationActionsDisabled={false}
      runtimeVersion={100n}
      scheduledTasks={[]}
      transitiveDependentIds={[]}
      selected={false}
      selectionDisabled={false}
      selectionTitle="Select app for app actions"
      update={null}
    />,
  );

  expect(html).toContain("Public POST handler");
  expect(html).toContain("POST /hooks/receive → receive_hook");
  expect(html).toContain("request ≤ 32768 bytes");
  expect(html).toContain("reply ≤ 8192 bytes");
  expect(html).toContain("60/hour");
  expect(html).toContain("Idempotency-Key required");
  expect(html).toContain("forwards authorization, content-type");
  expect(html).toContain("spends Neutron cycles");
  expect(html).toContain("no separate instruction allowance");
  expect(html).toContain("Forwarded headers are not a Neutron identity");
  expect(html).toContain("Shared public POST handler");
  expect(html).toContain(
    "POST /app/hook_app/_route/shared_submit → submit_shared",
  );
  expect(html).toContain("shared Neutron path");
  expect(html).toContain("ordinary origin");
  expect(html).toContain('data-capability-resource="receive"');
});

test("Settings shows HTTPS endpoint authority beside its live toggle", () => {
  const entry = registryApp({
    id: "weather_app",
    name: "Weather",
    backend: { capabilities: { https_outcalls: { api: 1 } } },
    capabilities: {
      https_outcalls: {
        api: 1,
        endpoints: [{
          id: "weather",
          url_prefix: "https://api.example.com/v1/",
          methods: ["get", "post"],
          request_headers: ["accept", "authorization"],
          max_request_bytes: 65_536,
          max_response_bytes: 32_768,
          transform: "strip_headers",
        }],
      },
    },
  });
  const summary: CapabilitySummary = {
    appId: "weather_app",
    installationUid: "11",
    planFingerprint: entry.capability_plan_fingerprint,
    kind: "https_outcalls",
    resourceId: "weather",
    api: 1,
    declarationFingerprint: "d".repeat(64),
    grant: "declaration",
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
      lastAt: 1_700_000_000_000_000_000n,
      lastOperation: "GET",
      lastOutcome: "ok",
    },
  };
  const html = renderToStaticMarkup(
    <AppSettingsEntry
      backendReservations={[]}
      capabilityActionsDisabled={false}
      capabilityOperation={null}
      capabilitySummaries={[summary]}
      dependencies={[]}
      dependents={[]}
      entry={entry}
      id="weather_app"
      uiMode="developer"
      usage={{ kind: "ready", usage: null }}
      memories={[]}
      onRevokeReservation={() => undefined}
      onSetCapabilityEnabled={() => undefined}
      onToggleSelected={() => undefined}
      registry={{}}
      reservationActionsDisabled={false}
      runtimeVersion={100n}
      scheduledTasks={[]}
      transitiveDependentIds={[]}
      selected={false}
      selectionDisabled={false}
      selectionTitle="Select app for app actions"
      update={null}
    />,
  );

  expect(html).toContain("HTTPS transport policy");
  expect(html).toContain("Paid single-node HTTPS");
  expect(html).toContain("no response consensus");
  expect(html).toContain("External HTTPS endpoint");
  expect(html).toContain("https://api.example.com/v1/");
  expect(html).toContain("GET, POST");
  expect(html).toContain("headers: accept, authorization");
  expect(html).toContain("request ≤ 65536 bytes");
  expect(html).toContain("reply ≤ 32768 bytes");
  expect(html).toContain("bounded concurrency and per-call cost safety");
  expect(html).not.toContain("24/hour");
  expect(html).not.toContain("300000000000 cycles/hour");
  expect(html).toContain("visible to subnet replicas");
  expect(html).toContain("response headers stripped");
  expect(html).toContain("POST requires an idempotency key");
  expect(html).toContain('data-capability-resource="weather"');
  expect(html).toContain(
    "Disable https_outcalls resource weather for this app",
  );
});

test("Settings shows chain-key slot authority, unverified purpose, and live toggle", () => {
  const purpose = "App claims this proves a login";
  const entry = registryApp({
    id: "assertion_app",
    name: "Assertion App",
    backend: { capabilities: { chain_key_signing: { api: 1 } } },
    capabilities: {
      chain_key_signing: {
        api: 1,
        slots: [{
          id: "login_assertion",
          algorithm: "ecdsa_secp256k1",
          purpose,
          max_assertion_bytes: 1024,
        }],
      },
    },
  });
  const summary: CapabilitySummary = {
    appId: "assertion_app",
    installationUid: "12",
    planFingerprint: entry.capability_plan_fingerprint,
    kind: "chain_key_signing",
    resourceId: "login_assertion",
    api: 1,
    declarationFingerprint: "e".repeat(64),
    grant: "declaration",
    toggleable: true,
    enabled: true,
    createdAt: 1_700_000_000_000_000_000n,
    createdBy: "aaaaa-aa",
    updatedAt: 1_700_000_000_000_000_000n,
    updatedBy: "aaaaa-aa",
    usage: {
      total: 2n,
      succeeded: 1n,
      denied: 0n,
      failed: 0n,
      rateLimited: 0n,
      busy: 0n,
      revoked: 1n,
      lastAt: 1_700_000_000_000_000_000n,
      lastOperation: "sign_assertion",
      lastOutcome: "ok",
    },
  };
  const html = renderToStaticMarkup(
    <AppSettingsEntry
      backendReservations={[]}
      capabilityActionsDisabled={false}
      capabilityOperation={null}
      capabilitySummaries={[summary]}
      dependencies={[]}
      dependents={[]}
      entry={entry}
      id="assertion_app"
      uiMode="developer"
      usage={{ kind: "ready", usage: null }}
      memories={[]}
      onRevokeReservation={() => undefined}
      onSetCapabilityEnabled={() => undefined}
      onToggleSelected={() => undefined}
      registry={{}}
      reservationActionsDisabled={false}
      runtimeVersion={100n}
      scheduledTasks={[]}
      transitiveDependentIds={[]}
      selected={false}
      selectionDisabled={false}
      selectionTitle="Select app for app actions"
      update={null}
    />,
  );

  expect(html).toContain("Assertion-signing authority");
  expect(html).toContain("Autonomous cryptographic assertions");
  expect(html).toContain("without asking each time");
  expect(html).toContain("prevents direct raw blockchain transaction signing");
  expect(html).toContain("treat an assertion as authorization");
  expect(html).toContain("unknown outcome may still have produced");
  expect(html).toContain("Assertion-signing authority");
  expect(html).toContain("slot login_assertion");
  expect(html).toContain("ecdsa_secp256k1");
  expect(html).toContain("assertion ≤ 1024 bytes");
  expect(html).toContain("bounded concurrency and per-call cost safety");
  expect(html).not.toContain("12/hour");
  expect(html).not.toContain("50000000000 app cycles/hour");
  expect(html).toContain("App-provided purpose — unverified");
  expect(html).toContain(purpose);
  expect(html).toContain('data-capability-resource="login_assertion"');
  expect(html).toContain(
    "Disable chain_key_signing resource login_assertion for this app",
  );
});

test("Settings shows stable-store authority, unverified purpose, and live toggle", () => {
  const purpose = "App claims this keeps private notes";
  const entry = registryApp({
    id: "notes_app",
    name: "Notes",
    backend: { capabilities: { stable_store: { api: 1 } } },
    capabilities: {
      stable_store: {
        api: 1,
        stores: [{
          id: "notes",
          purpose,
          schema_version: 2,
          max_entries: 64,
          max_key_bytes: 48,
          max_value_bytes: 4096,
          max_bytes: 65_536,
        }],
      },
    },
  });
  const summary: CapabilitySummary = {
    appId: "notes_app",
    installationUid: "13",
    planFingerprint: entry.capability_plan_fingerprint,
    kind: "stable_store",
    resourceId: "notes",
    api: 1,
    declarationFingerprint: "f".repeat(64),
    grant: "declaration",
    toggleable: true,
    enabled: true,
    createdAt: 1_700_000_000_000_000_000n,
    createdBy: "aaaaa-aa",
    updatedAt: 1_700_000_000_000_000_000n,
    updatedBy: "aaaaa-aa",
    usage: {
      total: 4n,
      succeeded: 3n,
      denied: 0n,
      failed: 1n,
      rateLimited: 0n,
      busy: 0n,
      revoked: 0n,
      lastAt: 1_700_000_000_000_000_000n,
      lastOperation: "put",
      lastOutcome: "ok",
    },
  };
  const html = renderToStaticMarkup(
    <AppSettingsEntry
      backendReservations={[]}
      capabilityActionsDisabled={false}
      capabilityOperation={null}
      capabilitySummaries={[summary]}
      dependencies={[]}
      dependents={[]}
      entry={entry}
      id="notes_app"
      uiMode="developer"
      usage={{ kind: "ready", usage: null }}
      memories={[]}
      onRevokeReservation={() => undefined}
      onSetCapabilityEnabled={() => undefined}
      onToggleSelected={() => undefined}
      registry={{}}
      reservationActionsDisabled={false}
      runtimeVersion={100n}
      scheduledTasks={[]}
      transitiveDependentIds={[]}
      selected={false}
      selectionDisabled={false}
      selectionTitle="Select app for app actions"
      update={null}
    />,
  );

  expect(html).toContain("Durable backend storage policy");
  expect(html).toContain("64 declared entries");
  expect(html).toContain("65536 declared bytes");
  expect(html).toContain("ordinary canister state, not encrypted or certified");
  expect(html).toContain("Durable store authority");
  expect(html).toContain("store notes");
  expect(html).toContain("schema 2");
  expect(html).toContain("64 entries");
  expect(html).toContain("65536 bytes");
  expect(html).toContain("key ≤ 48 bytes");
  expect(html).toContain("value ≤ 4096 bytes");
  expect(html).toContain("App-provided purpose — unverified");
  expect(html).toContain(purpose);
  expect(html).toContain('data-capability-resource="notes"');
  expect(html).toContain("Disable stable_store resource notes for this app");
});
