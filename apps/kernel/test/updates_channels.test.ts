import { beforeAll, expect, test } from "bun:test";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  serializeRepositoryReleaseRecord,
  type RepositoryReleaseRecord,
} from "neutron-tools/repository";
import { parseInstallProvenance } from "../src/repository/provenance.ts";
import { checkForAppUpdates } from "../src/updates/check.ts";
import {
  installedUpdateApps,
  selectedCandidates,
  selectionFingerprint,
  type AvailableUpdate,
} from "../src/updates/helpers.ts";
import type { FetchedRelease, InstalledUpdateApp } from "../src/updates/model.ts";
import { loadIcRuntimeFixture } from "./runtime_fixture.ts";

const SOURCE = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const PACKAGE_DIGEST = "a".repeat(64);
const installedBeta: InstalledUpdateApp = {
  appId: "mail",
  name: "Mail",
  version: 102,
  updateSource: SOURCE,
  packageDigest: PACKAGE_DIGEST,
  releaseChannel: "beta",
};

beforeAll(loadIcRuntimeFixture);

function fetchedRelease(
  version: number,
  channel: "stable" | "beta" = "stable",
  sha256 = PACKAGE_DIGEST,
): FetchedRelease {
  const record: RepositoryReleaseRecord = {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    id: "mail",
    version,
    sha256,
    size: 123,
  };
  return {
    source: SOURCE,
    record,
    releaseDigest: hashContent(serializeRepositoryReleaseRecord(record)),
    channel,
  };
}

test("an opted-out beta install waits for lower or absent stable without offering a downgrade", async () => {
  for (const fetched of [fetchedRelease(101), null]) {
    const summary = await checkForAppUpdates([installedBeta], {
      betaEnabled: false,
      async fetchRelease() { return fetched; },
    });
    expect(summary.results).toEqual([{
      kind: "ahead_of_stable",
      appId: "mail",
      name: "Mail",
      installed: 102,
      source: SOURCE,
      ...(fetched ? { advertised: 101 } : {}),
    }]);
    expect(selectedCandidates(summary.results, ["mail"])).toEqual([]);
  }
});

test("default stable checks recognize beta provenance without inventing it for legacy installs", async () => {
  const { releaseChannel: _channel, ...legacyInstall } = installedBeta;
  for (const releaseChannel of ["beta", "stable", undefined] as const) {
    const summary = await checkForAppUpdates([{
      ...legacyInstall,
      ...(releaseChannel ? { releaseChannel } : {}),
    }], {
      async fetchRelease() { return fetchedRelease(101); },
    });
    expect(summary.results[0]?.kind).toBe(
      releaseChannel === "beta" ? "ahead_of_stable" : "source_regression",
    );
  }
});

test("beta opt-in retains source regression and not-published diagnostics", async () => {
  for (const fetched of [fetchedRelease(101), null]) {
    const summary = await checkForAppUpdates([installedBeta], {
      betaEnabled: true,
      async fetchRelease() { return fetched; },
    });
    expect(summary.results[0]?.kind).toBe(fetched ? "source_regression" : "not_published");
  }
});

test("stable promotion of installed beta bytes is current and records the checked preference revision", async () => {
  const fetched = {
    ...fetchedRelease(installedBeta.version),
    channelRevision: "3",
    candidateId: "mail-102",
  };
  const summary = await checkForAppUpdates([installedBeta], {
    betaEnabled: false,
    preferenceRevision: "7",
    async fetchRelease() { return fetched; },
  });
  expect(summary.results).toEqual([{
    kind: "current",
    appId: "mail",
    name: "Mail",
    installed: 102,
    source: SOURCE,
    release: fetched.record,
    releaseDigest: fetched.releaseDigest,
    releaseChannel: "stable",
    preferenceRevision: "7",
    channelRevision: "3",
    candidateId: "mail-102",
  }]);
});

test("equal-version stable promotion cannot bypass installed digest verification", async () => {
  const { packageDigest: _digest, ...unverifiedInstall } = installedBeta;
  for (const packageDigest of ["b".repeat(64), undefined]) {
    const summary = await checkForAppUpdates([{
      ...unverifiedInstall,
      ...(packageDigest ? { packageDigest } : {}),
    }], {
      betaEnabled: false,
      async fetchRelease() { return fetchedRelease(installedBeta.version); },
    });
    expect(summary.results[0]).toMatchObject({
      kind: "failed",
      reason: packageDigest ? "equivocation" : "unverifiable",
    });
  }
});

test("newer eligible releases retain selected channel and preference revision for review", async () => {
  for (const channel of ["stable", "beta"] as const) {
    const fetched = {
      ...fetchedRelease(103, channel),
      channelRevision: "4",
      candidateId: "mail-103",
    };
    const summary = await checkForAppUpdates([installedBeta], {
      betaEnabled: channel === "beta",
      preferenceRevision: "0",
      async fetchRelease() { return fetched; },
    });
    expect(summary.results[0]).toMatchObject({
      kind: "available",
      release: fetched.record,
      releaseDigest: fetched.releaseDigest,
      releaseChannel: channel,
      preferenceRevision: "0",
      channelRevision: "4",
      candidateId: "mail-103",
    });
  }
});

test("installed channels come from repository and update provenance while legacy entries stay unknown", () => {
  const apps = installedUpdateApps({
    legacy: { name: "Legacy", version: 102, update_source: SOURCE },
    repository_app: { name: "Repository", version: 102, update_source: SOURCE },
    updated_app: { name: "Updated", version: 102, update_source: SOURCE },
  } as never, parseInstallProvenance({
    format: 2,
    apps: {
      legacy: { kind: "provisioned", package_digest: PACKAGE_DIGEST },
      repository_app: {
        kind: "repository",
        repository: SOURCE,
        manifest_id: "apps",
        manifest_digest: "c".repeat(64),
        package_digest: PACKAGE_DIGEST,
        release_channel: "beta",
        release_preferences_revision: "7",
      },
      updated_app: {
        kind: "update_source",
        source_canister: SOURCE,
        release_digest: "d".repeat(64),
        package_digest: PACKAGE_DIGEST,
        checked_at: 100,
        release_channel: "stable",
        release_preferences_revision: "8",
      },
    },
  }));
  expect(apps.map(({ appId, releaseChannel }) => ({ appId, releaseChannel }))).toEqual([
    { appId: "legacy", releaseChannel: undefined },
    { appId: "repository_app", releaseChannel: "beta" },
    { appId: "updated_app", releaseChannel: "stable" },
  ]);
  expect(apps.every(({ packageDigest }) => packageDigest === PACKAGE_DIGEST)).toBe(true);
});

test("checked selection identity binds the channel and preference revision even for identical bytes", () => {
  const fetched = fetchedRelease(103);
  const candidate: AvailableUpdate = {
    kind: "available",
    appId: "mail",
    name: "Mail",
    installed: 102,
    source: SOURCE,
    release: fetched.record,
    releaseDigest: fetched.releaseDigest,
    releaseChannel: "stable",
    preferenceRevision: "1",
    channelRevision: "3",
    candidateId: "release-103",
  };
  const fingerprint = selectionFingerprint([candidate]);
  expect(selectionFingerprint([{ ...candidate }])).toBe(fingerprint);
  expect(selectionFingerprint([{ ...candidate, releaseChannel: "beta" }])).not.toBe(fingerprint);
  expect(selectionFingerprint([{ ...candidate, preferenceRevision: "2" }])).not.toBe(fingerprint);
  expect(selectionFingerprint([{ ...candidate, channelRevision: "4" }])).not.toBe(fingerprint);
  expect(selectionFingerprint([{ ...candidate, candidateId: "replacement-103" }])).not.toBe(fingerprint);
});

test("duplicate installed snapshots with different channel provenance are conflicting", async () => {
  await expect(checkForAppUpdates([
    installedBeta,
    { ...installedBeta, releaseChannel: "stable" },
  ], { async fetchRelease() { return null; } })).rejects.toThrow(
    "Conflicting installed snapshots for mail",
  );
});
