import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppRegistry } from "neutron-compiler/src/install.js";
import { AppInstallRecoveryPanelView } from "../src/settings/AppInstallRecoveryPanel.tsx";

const deploymentId = "deploy00000000000000000000000000";
const noop = () => undefined;
const apps = {
  mail: { name: "Mail" },
} as AppRegistry;

test("pending install recovery is an inline Settings panel, not a global modal", () => {
  const html = renderToStaticMarkup(
    <AppInstallRecoveryPanelView
      apps={apps}
      busy={null}
      feedback={null}
      onAbort={noop}
      onInspect={noop}
      onRelease={noop}
      onRetry={noop}
      recovery={{
        deploymentId,
        runningTarget: false,
        blockers: [],
      }}
      uiMode="normal"
    />,
  );

  expect(html).toContain('data-tid="install-recovery-panel"');
  expect(html).toContain('role="status"');
  expect(html).toContain("Check again");
  expect(html).toContain("Discard staged install");
  expect(html).not.toContain("backdrop");
  expect(html).not.toContain("aria-modal");
  expect(html).not.toContain('role="alertdialog"');
});

test("running-target recovery shows the exact safe blocker and retry actions", () => {
  const html = renderToStaticMarkup(
    <AppInstallRecoveryPanelView
      apps={apps}
      busy={null}
      feedback={null}
      onAbort={noop}
      onInspect={noop}
      onRelease={noop}
      onRetry={noop}
      recovery={{
        deploymentId,
        runningTarget: true,
        blockers: [
          {
            id: 7n,
            appId: "mail",
            installationUid: 4n,
            scope: "aaaaa-aa · app_mail__mail_v1_update",
            reason: "scope_conflict",
          },
        ],
      }}
      uiMode="developer"
    />,
  );

  expect(html).toContain("Mail");
  expect(html).toContain(
    "This saved connection overlaps access the new version needs.",
  );
  expect(html).toContain("Remove saved access &amp; retry");
  expect(html).toContain("Retry installation");
  expect(html).toContain(deploymentId);
  expect(html).not.toContain("Discard staged install");
});

test("recovery actions expose busy and still-pending feedback", () => {
  const html = renderToStaticMarkup(
    <AppInstallRecoveryPanelView
      apps={apps}
      busy="retry"
      feedback="The installation is still pending."
      onAbort={noop}
      onInspect={noop}
      onRelease={noop}
      onRetry={noop}
      recovery={{
        deploymentId,
        runningTarget: true,
        blockers: [],
      }}
      uiMode="normal"
    />,
  );

  expect(html).toContain('aria-busy="true"');
  expect(html).toContain("Retrying…");
  expect(html).toContain('data-tid="install-recovery-feedback"');
  expect(html).toContain("The installation is still pending.");
  expect(html).toContain("disabled");
});
