import { describe, expect, test } from "bun:test";
import {
  EMPTY_INSTALL_PROVENANCE,
  parseInstallProvenance,
  serializeInstallProvenance,
  withInstallProvenance,
  withoutInstallProvenance,
} from "../src/repository/provenance.ts";

const repository = {
  kind: "repository" as const,
  repository: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  manifest_id: "demo",
  manifest_digest: "a".repeat(64),
  package_digest: "b".repeat(64),
};
const updateSource = {
  kind: "update_source" as const,
  source_canister: repository.repository,
  release_digest: "c".repeat(64),
  package_digest: "d".repeat(64),
  checked_at: 1_700_000_000_000,
};
const legacyApps = {
  repository_app: repository,
  updated_app: updateSource,
  manual_file: { kind: "manual" as const, acquisition: "file" as const, package_digest: "e".repeat(64) },
  manual_url: { kind: "manual" as const, acquisition: "url" as const, package_digest: "f".repeat(64) },
  provisioned_app: { kind: "provisioned" as const, package_digest: "0".repeat(64) },
};

test("legacy provenance converts to format 2 without changing any installed entry", () => {
  const parsed = parseInstallProvenance({ format: 1, apps: legacyApps });
  expect(parsed).toEqual({ format: 2, apps: legacyApps });
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.apps)).toBe(true);
  expect(JSON.parse(new TextDecoder().decode(serializeInstallProvenance(parsed))))
    .toEqual({ format: 2, apps: legacyApps });
  expect(EMPTY_INSTALL_PROVENANCE.format).toBe(2);

  const merged = withInstallProvenance(parsed, {
    beta_app: {
      ...repository,
      release_channel: "beta",
      release_preferences_revision: "123456789012345678901234567890",
      channel_aware: true,
    },
  });
  expect(withoutInstallProvenance(merged, ["beta_app"]))
    .toEqual({ format: 2, apps: legacyApps });
  const serialized = new TextDecoder().decode(serializeInstallProvenance(merged));
  expect(parseInstallProvenance(JSON.parse(serialized))).toEqual(merged);
});

describe.each([repository, updateSource])("release selection provenance for $kind", (entry) => {
  test.each([
    { release_channel: "stable" },
    { release_channel: "beta" },
    { release_preferences_revision: "0" },
    { release_preferences_revision: "123456789012345678901234567890" },
    { release_channel: "beta", release_preferences_revision: "2" },
    { channel_aware: true },
    { release_channel: "stable", release_preferences_revision: "0", channel_aware: true },
  ])("format 2 preserves optional fields %p, format 1 rejects them", (fields) => {
    const apps = { hello: { ...entry, ...fields } };
    expect(parseInstallProvenance({ format: 2, apps })).toEqual({ format: 2, apps });
    expect(() => parseInstallProvenance({ format: 1, apps }))
      .toThrow(/Invalid install provenance entry/);
  });

  test.each([
    { release_channel: "preview" },
    { release_channel: undefined },
    { release_channel: null },
    { channel_aware: false },
    { channel_aware: undefined },
    { channel_aware: null },
    { channel_aware: "true" },
    { channel_aware: 1 },
    { release_preferences_revision: undefined },
    { release_preferences_revision: null },
    { release_preferences_revision: 1 },
    { release_preferences_revision: "" },
    { release_preferences_revision: "01" },
    { release_preferences_revision: "-1" },
    { release_preferences_revision: "+1" },
    { release_preferences_revision: "1.0" },
    { release_preferences_revision: "1e3" },
    { release_preferences_revision: " 1" },
    { release_preferences_revision: "1\n" },
    { unexpected: "field" },
  ])("format 2 rejects malformed or unknown fields %p", (fields) => {
    expect(() => parseInstallProvenance({
      format: 2,
      apps: { hello: { ...entry, ...fields } },
    })).toThrow(/Invalid install provenance entry/);
  });
});

test("manual and provisioned provenance retain their closed shapes in both formats", () => {
  for (const format of [1, 2]) {
    for (const entry of [legacyApps.manual_file, legacyApps.provisioned_app]) {
      for (const fields of [
        { release_channel: "beta" },
        { release_preferences_revision: "0" },
        { channel_aware: true },
      ]) {
        expect(() => parseInstallProvenance({
          format,
          apps: { hello: { ...entry, ...fields } },
        })).toThrow(/Invalid install provenance entry/);
      }
    }
  }
});

test("format 2 rejects missing original entry fields and unknown envelope fields", () => {
  const { manifest_digest: _digest, ...incomplete } = repository;
  expect(() => parseInstallProvenance({ format: 2, apps: { hello: incomplete } }))
    .toThrow(/Invalid install provenance entry/);
  expect(() => parseInstallProvenance({ format: 2, apps: {}, release_channel: "beta" }))
    .toThrow(/Invalid install provenance/);
  expect(() => parseInstallProvenance({ format: 3, apps: {} }))
    .toThrow(/Unsupported install provenance format/);
});
