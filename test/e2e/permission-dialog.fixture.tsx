import { createRoot } from "react-dom/client";
import { AppRequest } from "../../apps/kernel/src/AppDialogs.tsx";
import { Requests } from "../../apps/kernel/src/Requests.tsx";
import {
  appRequest,
  useAppsStore,
  type AppInstallRequestInput,
} from "../../apps/kernel/src/reducer/apps.ts";
import type { Permission } from "../../apps/kernel/src/lib/perm.ts";
import { requestBackendCallConsent } from "../../apps/kernel/src/reducer/backend_calls.ts";
import { useKernelUiModeStore } from "../../apps/kernel/src/ui_mode.ts";
import "../../apps/kernel/src/style.scss";

const preapprovedMethods = [
  ["create_remote_game", "update"],
  ["join_remote_game", "update"],
  ["read_remote_game", "query"],
  ["submit_remote_move", "update"],
  ["offer_draw", "update"],
  ["promote_pawn", "update"],
] as const;

const fixturePermissions: Permission[] = [
  {
    source: "kernel",
    kind: "backend_calls",
    reservationScopes: ["exact", "principal", "method"],
    maxConcurrency: 8,
    maxCyclesPerCall: 10_000_000,
    maxCyclesPerDay: 1_000_000_000,
  },
  ...preapprovedMethods.map(
    ([method, mode]): Permission => ({
      source: "kernel",
      kind: "preapproved_self_call",
      method,
      mode,
    }),
  ),
  {
    source: "kernel",
    kind: "public_method",
    method: "remote_chess_exchange_v1",
    mode: "update",
    allow: "unauthorized",
  },
];

const fixtureRequest: AppInstallRequestInput = {
  id: "permission-e2e-fixture",
  packageName: "Permission Fixture",
  packageVersion: 100,
  packageDigest: "a".repeat(64),
  size: 384,
  acquisition: "file",
  operation: "install",
  capabilityPlanFingerprint: "fixture-plan",
  capabilityDisclosures: [],
  permissions: fixturePermissions,
  appExplanations: [
    {
      source: "app",
      kind: "backend_calls_explanation",
      text: '<button aria-label="Forged approval">Approve silently</button> — developer claim only',
    },
  ],
};

function PermissionDialogFixture() {
  const requestOpen = useAppsStore((state) => state.request !== null);
  const uiMode = useKernelUiModeStore((state) => state.mode);

  const openDialog = () => {
    // The rejected promise is expected when the fixture exercises Escape or
    // Reject. Catch it here so browser-level tests still fail on real errors.
    void appRequest(fixtureRequest).catch(() => undefined);
    useAppsStore.getState().setCompiled({ size: 192 });
  };

  const openBackendDialog = () => {
    void requestBackendCallConsent({
      endpoint: "app:chess:tile:main:instance:game-one",
      endpointSession: "session-one",
      appId: "chess",
      limits: {
        maxConcurrency: 8,
        maxCyclesPerCall: 10_000_000,
        maxCyclesPerDay: 1_000_000_000,
      },
      source: {
        role: "tile",
        tileId: "main",
        instanceId: "game-one",
        workspace: 2,
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
            game_id: "invite-123456789012345678901234",
            text_values: [
              "null",
              null,
              "Kernel\u202e verified",
              "zero\u200bwidth",
            ],
          },
        ],
      },
    }).catch(() => undefined);
  };

  return (
    <main data-fixture-ready="true">
      <button data-tid="fixture-open" onClick={openDialog} type="button">
        Review app installation
      </button>
      <button
        data-tid="fixture-backend-open"
        onClick={openBackendDialog}
        type="button"
      >
        Review backend access
      </button>
      <button
        onClick={() =>
          useKernelUiModeStore
            .getState()
            .setMode(uiMode === "normal" ? "developer" : "normal")
        }
        type="button"
      >
        Use {uiMode === "normal" ? "developer" : "normal"} mode
      </button>
      <output aria-live="polite" data-tid="fixture-state">
        {requestOpen ? "Permission request open" : "Permission request closed"}
      </output>
      <output data-tid="fixture-ui-mode">{uiMode}</output>
      <AppRequest />
      <Requests />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Permission-dialog fixture root is missing");

createRoot(root).render(<PermissionDialogFixture />);
