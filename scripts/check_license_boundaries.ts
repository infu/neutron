import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

const NSAL_LICENSE = "LicenseRef-Neutron-Sovereign-Application-License-1.0";

// The Kernel is a control-plane workspace, not an ordinary Application. Its
// release license is checked by the Kernel release/conformance gates. Keep the
// app-facing boundary here explicit so a new ordinary app cannot silently
// inherit the root or Kernel license.
const nsalAppWorkspaces = [
  "apps/agent",
  "apps/chess",
  "apps/contacts",
  "apps/hello",
  "apps/hullshift",
  "apps/jetcreeper",
  "apps/kitchensink",
  "apps/mail",
  "apps/mysubnet",
  "apps/spreadsheet",
  "apps/vetkeys_fixture_test",
  "apps/vfs",
  "apps/wagyu",
  "apps/wallet",
];

const apacheAppWorkspaces = ["apps/gemma"];
const kernelWorkspaces = ["apps/kernel"];

const expectedLicenses = new Map<string, string>([
  ["", "SEE LICENSE IN LICENSES.md"],
  ...nsalAppWorkspaces.map((workspace) => [workspace, NSAL_LICENSE] as const),
  ...apacheAppWorkspaces.map((workspace) => [workspace, "Apache-2.0"] as const),
  ...kernelWorkspaces.map(
    (workspace) => [workspace, "SEE LICENSE IN LICENSE"] as const,
  ),
  ["packages/neutron-cli", "SEE LICENSE IN LICENSE"],
  ["packages/neutron-compiler", "SEE LICENSE IN LICENSE"],
  ["packages/neutron-design-system", "Apache-2.0"],
  ["packages/neutron-motoko-capabilities", "Apache-2.0"],
  ["packages/neutron-motoko-wasm", "SEE LICENSE IN LICENSES.md"],
  ["packages/neutron-provision", "SEE LICENSE IN LICENSE"],
  ["packages/neutron-scripts", "Apache-2.0"],
  ["packages/neutron-security", "SEE LICENSE IN LICENSE"],
  ["packages/neutron-tools", "Apache-2.0"],
  ["support/dispenser", "Apache-2.0"],
  ["support/repository", "Apache-2.0"],
  ["support/update-source", "Apache-2.0"],
]);

const nplPackages = [
  "packages/neutron-cli",
  "packages/neutron-compiler",
  "packages/neutron-provision",
  "packages/neutron-security",
];

const apachePackages = [
  "packages/neutron-design-system",
  "packages/neutron-motoko-capabilities",
  "packages/neutron-scripts",
  "packages/neutron-tools",
  "support/dispenser",
  "support/repository",
  "support/update-source",
];

const read = (relativePath: string) =>
  readFile(path.join(root, relativePath), "utf8");

const classifiedAppWorkspaces = new Set([
  ...nsalAppWorkspaces,
  ...apacheAppWorkspaces,
  ...kernelWorkspaces,
]);
for (const entry of await readdir(path.join(root, "apps"), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory()) continue;
  const workspace = `apps/${entry.name}`;
  try {
    await read(`${workspace}/package.json`);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      continue;
    }
    throw error;
  }
  if (!classifiedAppWorkspaces.has(workspace)) {
    throw new Error(`Unclassified application workspace: ${workspace}`);
  }
}

const digest = (contents: string) =>
  createHash("sha256").update(contents).digest("hex");

const assertEqual = (actual: unknown, expected: unknown, label: string) => {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
};

const assertContains = (contents: string, expected: string, label: string) => {
  if (!contents.includes(expected)) {
    throw new Error(`${label}: missing ${JSON.stringify(expected)}`);
  }
};

const assertNotice = async (
  workspace: string,
  requiredMarkers: readonly string[],
) => {
  const noticePath = `${workspace}/NOTICE`;
  const notice = await read(noticePath);
  if (notice.trim().length === 0) {
    throw new Error(`${noticePath} must not be empty`);
  }
  for (const marker of requiredMarkers) {
    assertContains(notice, marker, noticePath);
  }
};

const packageLock = JSON.parse(await read("package-lock.json"));
for (const [workspace, expected] of expectedLicenses) {
  const manifestPath = workspace ? `${workspace}/package.json` : "package.json";
  const manifest = JSON.parse(await read(manifestPath));
  assertEqual(manifest.license, expected, `${manifestPath} license`);
  assertEqual(
    packageLock.packages[workspace]?.license,
    expected,
    `package-lock.json packages[${JSON.stringify(workspace)}].license`,
  );
}

const npl = await read("LICENSE");
for (const workspace of nplPackages) {
  assertEqual(await read(`${workspace}/LICENSE`), npl, `${workspace}/LICENSE`);
  await read(`${workspace}/NOTICE`);
}

const apache = await read("packages/neutron-tools/LICENSE");
for (const workspace of apachePackages) {
  assertEqual(
    await read(`${workspace}/LICENSE`),
    apache,
    `${workspace}/LICENSE`,
  );
  await read(`${workspace}/NOTICE`);
}

for (const workspace of nsalAppWorkspaces) {
  await assertNotice(workspace, [NSAL_LICENSE, "See LICENSE.APP"]);
}
// The peer is a second packaged Application produced by the fixture workspace,
// but it is deliberately not an npm workspace and therefore has no lock entry.
await assertNotice("apps/vetkeys_fixture_test/peer", [
  NSAL_LICENSE,
  "See LICENSE.APP",
]);

for (const workspace of apacheAppWorkspaces) {
  assertEqual(
    await read(`${workspace}/LICENSE`),
    apache,
    `${workspace}/LICENSE`,
  );
  await assertNotice(workspace, ["SPDX-License-Identifier: Apache-2.0"]);
}

const capabilitiesMops = await read(
  "packages/neutron-motoko-capabilities/mops.toml",
);
assertContains(
  capabilitiesMops,
  'license = "Apache-2.0"',
  "capabilities mops license",
);

const pinnedLicenseDigests = new Map<string, string>([
  [
    "apps/mysubnet/LICENSE.DFINITY-IC-1.0",
    "3ba11e25f86c79b944d0ee682d978b66230e12032eae32fd9d4ce2f327683162",
  ],
  [
    "apps/mysubnet/LICENSE.DFINITY-IC-Apache-2.0",
    "663dab5e2a11fed35cd86d277d83f52cbeac29eb2b08581d10aaacbaa3ced4ef",
  ],
  [
    "packages/neutron-motoko-wasm/LICENSE",
    "907f6cd96b832f00713d86983eede6ce20e8cf8e3a70d2537f57215b7504db95",
  ],
  [
    "packages/neutron-motoko-wasm/LICENSE.js_of_ocaml",
    "ade61810946164eda728c580946f52b70e709f3f5dbcba68534b2f41a8104cb6",
  ],
  [
    "support/dispenser/LICENSE.Motoko-Core",
    "840e3d57a38a8061f55d04470fbd58b9345326fa04ea10ee42add5c6e3b2aa08",
  ],
  [
    "support/dispenser/LICENSE.Motoko-Base",
    "166bd8e8cf7790087d1fd18a9fa4d060cc0d0b3e5ab30689aa5f3a59a93386bf",
  ],
  [
    "support/dispenser/LICENSE.Enzoh-Motoko-SHA",
    "c40ad81ae283a698516dbff4959219d6ba96cbec1c545647af1f11f715a73d2a",
  ],
  [
    "support/repository/LICENSE.Motoko-Core",
    "840e3d57a38a8061f55d04470fbd58b9345326fa04ea10ee42add5c6e3b2aa08",
  ],
  [
    "support/repository/LICENSE.Motoko-Base",
    "166bd8e8cf7790087d1fd18a9fa4d060cc0d0b3e5ab30689aa5f3a59a93386bf",
  ],
]);

for (const [licensePath, expected] of pinnedLicenseDigests) {
  assertEqual(
    digest(await read(licensePath)),
    expected,
    `${licensePath} SHA-256`,
  );
}

const motokoLicenseIndex = await read(
  "packages/neutron-motoko-wasm/LICENSES.md",
);
for (const expression of [
  "Apache-2.0 WITH LLVM-exception",
  "LGPL-2.1-or-later WITH OCaml-LGPL-linking-exception",
]) {
  assertContains(
    motokoLicenseIndex,
    expression,
    "packages/neutron-motoko-wasm/LICENSES.md",
  );
}

for (const required of [
  "LICENSES.md",
  "LICENSE.APP",
  "packages/neutron-motoko-wasm/LICENSES.md",
  "packages/neutron-motoko-wasm/NOTICE",
  "support/dispenser/THIRD_PARTY_NOTICES.md",
  "support/repository/THIRD_PARTY_NOTICES.md",
  "support/update-source/THIRD_PARTY_NOTICES.md",
]) {
  await read(required);
}

const cappedLicenseTexts = new Set([
  "LICENSE",
  "LICENSE.APP",
  "LICENSE.GPL-3.0",
  "LICENSE.NPL-0.2",
  "apps/gemma/LICENSE",
  "apps/kernel/LICENSE",
  ...nplPackages.map((workspace) => `${workspace}/LICENSE`),
  ...apachePackages.map((workspace) => `${workspace}/LICENSE`),
  ...pinnedLicenseDigests.keys(),
]);

for (const licensePath of cappedLicenseTexts) {
  const contents = await read(licensePath);
  const lines = contents.endsWith("\n")
    ? contents.split("\n").length - 1
    : contents.split("\n").length;
  if (lines > 675) {
    throw new Error(
      `${licensePath} exceeds the 675-line license-text limit (${lines})`,
    );
  }
}

console.log("License boundaries and required local license materials match.");
