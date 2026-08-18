import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX,
} from "neutron-tools/package_record.js";
import {
  InstalledPackageDownloadFeedback,
  InstalledPackageLegalDetails,
} from "../src/settings/InstalledPackageLegalDetails.tsx";
import type { InstalledPackageRecordInspection } from "../src/settings/installed_package_record.ts";

const RECORD_SHA256 = "a".repeat(64);
const ARCHIVE_SHA256 = "b".repeat(64);
const LICENSE_SHA256 = "c".repeat(64);
const SOURCE_SHA256 = "d".repeat(64);
const NOTICE_SHA256 = "f".repeat(64);

const declaredInspection: InstalledPackageRecordInspection = {
  status: "declared",
  assetBasePath: "/app/hello/pkg/",
  recordPath: "/app/hello/pkg/legal/package-record.v1.json",
  recordSha256: RECORD_SHA256,
  record: {
    format: 1,
    package: {
      id: "hello",
      version: 100,
      manifest: {
        path: "neutron.json",
        sha256: "e".repeat(64),
        bytes: 100,
      },
    },
    license: {
      id: "GPL-3.0-only",
      texts: [
        {
          id: "GPL-3.0-only",
          path: "legal/LICENSE.GPL-3.0.txt",
          sha256: LICENSE_SHA256,
          bytes: 35_149,
        },
      ],
    },
    source: {
      kind: "https",
      revision: "git:0123456789abcdef",
      url: "https://source.example/releases/hello-v1.tar.gz",
      sha256: SOURCE_SHA256,
      bytes: 42_000,
    },
    dependencies: [],
    notices: [
      {
        path: "legal/THIRD-PARTY-NOTICES.txt",
        sha256: NOTICE_SHA256,
        bytes: 321,
      },
    ],
    memory: null,
    build: { inputs: [], commands: [] },
  },
};

test("normal mode shows a concise license and plainly labelled source download", () => {
  const html = renderToStaticMarkup(
    <InstalledPackageLegalDetails
      appId="hello"
      inspection={declaredInspection}
      provenancePackageSha256={ARCHIVE_SHA256}
      uiMode="normal"
    />,
  );

  expect(html).toContain('data-tid="settings-app-legal-hello"');
  expect(html).toContain("License and source");
  expect(html).toContain("GPL-3.0-only");
  expect(html).toContain("/app/hello/pkg/legal/LICENSE.GPL-3.0.txt");
  expect(html).toContain('aria-label="Copy license text path"');
  expect(html).toContain('aria-label="Download and verify license text"');
  expect(html).not.toContain(
    'href="/app/hello/pkg/legal/LICENSE.GPL-3.0.txt"',
  );
  expect(html).toContain("Source code");
  expect(html).toContain("Available from the package publisher");
  expect(html).toContain("Verified by size and SHA-256 before download");
  expect(html).toContain('aria-label="Download and verify source code"');
  expect(html).toContain("Download source code");
  expect(html).not.toContain("Publisher offer");
  expect(html).not.toContain(
    'href="https://source.example/releases/hello-v1.tar.gz"',
  );
  expect(html).not.toContain("Package record SHA-256");
  expect(html).not.toContain(ARCHIVE_SHA256);
});

test("developer mode keeps the package-record and outer archive digests separate", () => {
  const html = renderToStaticMarkup(
    <InstalledPackageLegalDetails
      appId="hello"
      inspection={declaredInspection}
      provenancePackageSha256={ARCHIVE_SHA256}
      uiMode="developer"
    />,
  );

  expect(html).toContain("Package record SHA-256");
  expect(html).toContain("License, source, and package-record details");
  expect(html).toContain('<details class="settings-app-legal-developer">');
  expect(html).not.toContain(
    '<details class="settings-app-legal-developer" open=""',
  );
  expect(html).toContain(RECORD_SHA256);
  expect(html).toContain("Installed package archive SHA-256");
  expect(html).toContain(ARCHIVE_SHA256);
  expect(html).toContain("Package-declared license texts");
  expect(html).toContain(
    "Referenced license and notice files remain installed",
  );
  expect(html).toContain(
    "source archive is fetched only when you choose Download source code",
  );
  expect(html).not.toContain("archive-only license");
  expect(html).toContain("legal/LICENSE.GPL-3.0.txt");
  expect(html).toContain(LICENSE_SHA256);
  expect(html).toContain("Package-declared notices");
  expect(html).toContain("legal/THIRD-PARTY-NOTICES.txt");
  expect(html).toContain(NOTICE_SHA256);
  expect(html).toContain('aria-label="Download and verify notice 1"');
  expect(html).toContain("Source revision");
  expect(html).toContain(SOURCE_SHA256);
  expect(html).toContain("Open source URL without verification");
  expect(html).toContain(
    'href="https://source.example/releases/hello-v1.tar.gz"',
  );
  expect(html).toContain('aria-label="Copy Package record SHA-256"');
  expect(html).toContain(
    'aria-label="Copy Installed package archive SHA-256"',
  );
});

test("missing records are labelled as legacy without guessing a license", () => {
  const html = renderToStaticMarkup(
    <InstalledPackageLegalDetails
      appId="legacy_app"
      inspection={{
        status: "legacy",
        recordPath: "/app/legacy_app/pkg/legal/package-record.v1.json",
      }}
      uiMode="normal"
    />,
  );

  expect(html).toContain("Legacy / not declared by package");
  expect(html).toContain("does not infer a license or source offer");
  expect(html).not.toContain("GPL");
  expect(html).not.toContain("NPL");
});

test("a malformed present record is a visible escaped per-app error", () => {
  const html = renderToStaticMarkup(
    <InstalledPackageLegalDetails
      appId="broken_app"
      inspection={{
        status: "invalid",
        recordPath: "/app/broken_app/pkg/legal/package-record.v1.json",
        message: "bad <img src=x onerror=alert(1)> record",
      }}
      uiMode="normal"
    />,
  );

  expect(html).toContain('data-tid="settings-app-legal-broken_app"');
  expect(html).toContain('role="alert"');
  expect(html).toContain("Installed package record is invalid");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).not.toContain("<img");
});

test("an explicit package source status is shown as a claim, not an offer", () => {
  if (declaredInspection.status !== "declared") {
    throw new Error("expected declared fixture");
  }
  const inspection: InstalledPackageRecordInspection = {
    ...declaredInspection,
    record: {
      ...declaredInspection.record,
      source: { kind: "status", status: "not-provided" },
    },
  };
  const html = renderToStaticMarkup(
    <InstalledPackageLegalDetails
      appId="hello"
      inspection={inspection}
      uiMode="normal"
    />,
  );

  expect(html).toContain("Not provided");
  expect(html).toContain("Package-declared status");
  expect(html).not.toContain("Open source offer");
});

test("embedded source is described as package-only rather than an installed download", () => {
  if (declaredInspection.status !== "declared") {
    throw new Error("expected declared fixture");
  }
  const inspection: InstalledPackageRecordInspection = {
    ...declaredInspection,
    record: {
      ...declaredInspection.record,
      source: {
        kind: "embedded",
        revision: "release-1",
        path: NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
        sha256: SOURCE_SHA256,
        bytes: 42_000,
      },
    },
  };
  const html = renderToStaticMarkup(
    <InstalledPackageLegalDetails
      appId="hello"
      inspection={inspection}
      uiMode="normal"
    />,
  );

  expect(html).toContain("Included in original package");
  expect(html).toContain(
    "Package-only source snapshot; not installed as a public asset.",
  );
  expect(html).not.toContain(
    `/app/hello/pkg/${NEUTRON_APP_SOURCE_SNAPSHOT_PATH}`,
  );
  expect(html).not.toContain("Download and verify embedded source");

  const developerHtml = renderToStaticMarkup(
    <InstalledPackageLegalDetails
      appId="hello"
      inspection={inspection}
      uiMode="developer"
    />,
  );
  expect(developerHtml).toContain("Package archive path");
  expect(developerHtml).toContain(NEUTRON_APP_SOURCE_SNAPSHOT_PATH);
  expect(developerHtml).toContain(
    "Package-only; not installed as a static asset",
  );
  expect(developerHtml).not.toContain(
    `/app/hello/pkg/${NEUTRON_APP_SOURCE_SNAPSHOT_PATH}`,
  );
  expect(developerHtml).not.toContain("Download and verify embedded source");
});

test("archive-only licenses and third-party notices are not presented as installed assets", () => {
  if (declaredInspection.status !== "declared") {
    throw new Error("expected declared fixture");
  }
  const licensePath =
    `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}LICENSE.APP.txt`;
  const noticesPath =
    `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}THIRD_PARTY_NOTICES.md`;
  const inspection: InstalledPackageRecordInspection = {
    ...declaredInspection,
    record: {
      ...declaredInspection.record,
      license: {
        id: "LicenseRef-Neutron-Sovereign-Application-License-1.0",
        texts: [{
          id: "LicenseRef-Neutron-Sovereign-Application-License-1.0",
          path: licensePath,
          sha256: LICENSE_SHA256,
          bytes: 40_000,
        }],
      },
      notices: [{
        path: noticesPath,
        sha256: NOTICE_SHA256,
        bytes: 20_000,
      }],
    },
  };
  const html = renderToStaticMarkup(
    <InstalledPackageLegalDetails
      appId="hello"
      inspection={inspection}
      uiMode="developer"
    />,
  );

  expect(html).toContain(licensePath);
  expect(html).toContain(noticesPath);
  expect(html).toContain(
    "Retained in original package; not installed as a public asset.",
  );
  expect(html).toContain("archive-only license");
  expect(html).not.toContain(`/app/hello/pkg/${licensePath}`);
  expect(html).not.toContain(`/app/hello/pkg/${noticesPath}`);
  expect(html).not.toContain("Download and verify license text");
  expect(html).not.toContain("Download and verify notice 1");
});

test("download verification errors are visible text and never rendered as markup", () => {
  const html = renderToStaticMarkup(
    <InstalledPackageDownloadFeedback
      state={{
        status: "error",
        message: "digest mismatch <script>alert(1)</script>",
      }}
    />,
  );

  expect(html).toContain('role="alert"');
  expect(html).toContain("Download failed. digest mismatch");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});
