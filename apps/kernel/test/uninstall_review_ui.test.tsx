import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppUninstallRequestDialog } from "../src/AppDialogs.tsx";
import { uninstallDeploymentRecordFixture } from "./deployment_record_fixture.ts";

test("final uninstall confirmation renders the exact deployment review", () => {
  const record = uninstallDeploymentRecordFixture({
    appId: "files",
    memoryIds: ["files", "archive"],
  });
  const request = {
    appId: "files",
    appName: "Files",
    memoryIds: ["files", "archive"],
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
