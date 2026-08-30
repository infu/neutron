import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppUninstallRequestDialog } from "../src/AppDialogs.tsx";
import {
  appsUninstallDeploymentRecordFixture,
  uninstallDeploymentRecordFixture,
} from "./deployment_record_fixture.ts";

test("final uninstall confirmation renders the exact deployment review", () => {
  const record = uninstallDeploymentRecordFixture({
    appId: "files",
    memoryIds: ["files", "archive"],
  });
  const request = {
    apps: [
      {
        appId: "files",
        appName: "Files",
        memoryIds: ["files", "archive"],
      },
    ],
    deploymentReview: Object.freeze({
      record,
      suppliedPackages: Object.freeze([]),
    }),
  } as const;

  const normalHtml = renderToStaticMarkup(
    <AppUninstallRequestDialog request={request} />,
  );
  expect(normalHtml).toContain("Deployment ready");
  expect(normalHtml).toContain("review items need attention");
  expect(normalHtml).not.toContain("Download exact build-record JSON");
  expect(normalHtml).not.toContain(record.deployment_id);
  expect(normalHtml).not.toContain(record.wasm.raw.sha256);

  const html = renderToStaticMarkup(
    <AppUninstallRequestDialog request={request} uiMode="developer" />,
  );

  expect(html).toContain('data-tid="uninstall-dialog"');
  expect(html).toContain('role="alertdialog"');
  expect(html).toContain('data-tid="deployment-build-review"');
  expect(html).toContain("Build and installation details");
  expect(html).toContain(record.deployment_id);
  expect(html).toContain(record.wasm.raw.sha256);
  expect(html).toContain(record.wasm.transport.sha256);
  expect(html).toContain("Removed apps");
  expect(html).toContain("files/files");
  expect(html).toContain("files/archive");
  expect(html).toContain("Download exact build-record JSON");
  expect(html).not.toContain("Download exact kernel archive");
  expect(html.indexOf('data-tid="uninstall-cancel"')).toBeLessThan(
    html.indexOf('data-tid="uninstall-confirm"'),
  );
});

test("one uninstall review lists every selected app and owned memory", () => {
  const apps = [
    { appId: "contacts", appName: "Contacts", memoryIds: ["people"] },
    { appId: "mail", appName: "Mail", memoryIds: ["messages"] },
  ];
  const record = appsUninstallDeploymentRecordFixture({ apps });
  const html = renderToStaticMarkup(
    <AppUninstallRequestDialog
      request={{
        apps,
        deploymentReview: Object.freeze({
          record,
          suppliedPackages: Object.freeze([]),
        }),
      }}
    />,
  );

  expect(html).toContain("Uninstall applications");
  expect(html).toContain("Contacts");
  expect(html).toContain("contacts");
  expect(html).toContain("Mail");
  expect(html).toContain("mail");
  expect(html).toContain("contacts/people");
  expect(html).toContain("mail/messages");
  expect(html).toContain("Uninstall 2 apps");
});
