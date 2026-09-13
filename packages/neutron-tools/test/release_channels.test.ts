import { describe, expect, test } from "bun:test";
import { parseRepositoryManifest, REPOSITORY_LIMITS } from "../src/repository.ts";
import {
  assertRepositoryChannelSelectionManifest,
  parseRepositoryChannelHeads,
  parseRepositoryChannelsDescriptor,
  parseRepositoryChannelSelection,
  parseRepositorySetupManifest,
  repositoryBetaReleasePath,
  repositoryChannelHeadsPath,
  repositoryChannelSelectionPath,
  repositoryChannelsPath,
  selectRepositoryChannelRelease,
} from "../src/release_channels.ts";

const source = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const digest = "a".repeat(64);
const release = (version = 117, sha256 = digest) => ({
  protocol: "neutron-repo-v1" as const, id: "notes", version, sha256, size: 1024,
});
const head = (version = 117, candidate_id = "1") => ({
  revision: "9007199254740993", candidate_id, release: release(version),
});
const heads = () => ({
  protocol: "neutron-repo-channel-heads-v1", source, id: "notes",
  stable: head(), beta: head(118, "2"),
});
const selection = () => ({
  protocol: "neutron-repo-channel-selection-v1", source, mode: "beta",
  manifest_id: "selection-1", manifest_sha256: digest,
  packages: [{ id: "notes", candidate_id: "2", version: 118, sha256: digest, size: 1024, channel: "beta", revision: "3" }],
});

describe("certified repository release channel contract", () => {
  test("binds validated IDs to distinct fixed paths", () => {
    expect(repositoryChannelsPath()).toBe("/repo/v1/channels.json");
    expect(repositoryBetaReleasePath("kernel")).toBe("/repo/v1/channels/beta/releases/kernel.json");
    expect(repositoryChannelHeadsPath("notes")).toBe("/repo/v1/channels/apps/notes.json");
    expect(repositoryChannelSelectionPath("selection-1")).toBe("/repo/v1/channels/manifests/selection-1.json");
    for (const id of ["../notes", "__proto__", "notes?stable", ""]) {
      expect(() => repositoryChannelHeadsPath(id)).toThrow();
    }
  });

  test("requires a closed, canonical source descriptor", () => {
    const descriptor = { protocol: "neutron-repo-channels-v1" as const, source };
    expect(parseRepositoryChannelsDescriptor(descriptor)).toEqual(descriptor);
    expect(parseRepositoryChannelsDescriptor(new TextEncoder().encode(JSON.stringify(descriptor)))).toEqual(descriptor);
    for (const invalid of [
      { ...descriptor, beta: true },
      { ...descriptor, source: "2vxsx-fae" },
      { ...descriptor, source: "aaaaa-aa" },
      { ...descriptor, source: source.toUpperCase() },
      { ...descriptor, protocol: "neutron-repo-v1" },
      '{"protocol":"neutron-repo-channels-v1","source":"2vxsx-fae","source":"' + source + '"}',
      new Uint8Array([255]),
      " ".repeat(REPOSITORY_LIMITS.metadataJsonBytes + 1),
    ]) expect(() => parseRepositoryChannelsDescriptor(invalid)).toThrow();
  });

  test("defaults selection to stable, opts into newer beta, and promotes without changing bytes", () => {
    const parsed = parseRepositoryChannelHeads(heads());
    expect(parsed.stable.revision).toBe("9007199254740993");
    expect(selectRepositoryChannelRelease(parsed, "stable")?.head.release.version).toBe(117);
    expect(selectRepositoryChannelRelease(parsed, "beta")?.head.release.version).toBe(118);
    const promoted = parseRepositoryChannelHeads({ ...heads(), stable: head(118, "2") });
    expect(selectRepositoryChannelRelease(promoted, "beta")?.channel).toBe("stable");
    expect(selectRepositoryChannelRelease(promoted, "stable")?.head.release).toEqual(release(118));
  });

  test("handles beta-only apps and revoked heads without reviving historical versions", () => {
    const betaOnly = parseRepositoryChannelHeads({ ...heads(), stable: { revision: "0", candidate_id: null, release: null } });
    expect(selectRepositoryChannelRelease(betaOnly, "stable")).toBeNull();
    expect(selectRepositoryChannelRelease(betaOnly, "beta")?.head.release.version).toBe(118);
    const revoked = parseRepositoryChannelHeads({ ...heads(), beta: { revision: "4", candidate_id: "2", release: null } });
    expect(selectRepositoryChannelRelease(revoked, "beta")?.head.release.version).toBe(117);
    expect(revoked.beta.candidate_id).toBe("2");
  });

  test("rejects ambiguous nested keys, identities, and same-version byte equivocation", () => {
    const wire = JSON.stringify(heads());
    expect(() => parseRepositoryChannelHeads(wire.replace('"revision":"9007199254740993"', '"revision":"1","revision":"2"'))).toThrow();
    expect(() => parseRepositoryChannelHeads(wire.replace('"version":117', '"version":116,"versi\\u006fn":117'))).toThrow();
    for (const stable of [
      { ...head(), revision: 3 },
      { ...head(), revision: "03" },
      { ...head(), candidate_id: "-1" },
      { ...head(), candidate_id: null },
      { ...head(), release: { ...release(), id: "wallet" } },
      { ...head(), release: JSON.stringify(release()) },
    ]) expect(() => parseRepositoryChannelHeads({ ...heads(), stable })).toThrow();
    expect(() => parseRepositoryChannelHeads({ ...heads(), beta: { ...head(), release: release(117, "b".repeat(64)) } })).toThrow();
  });

  test("does not permit relabeling beta as a stable install selection", () => {
    const parsed = parseRepositoryChannelSelection(selection());
    expect(parsed.packages[0]?.channel).toBe("beta");
    expect(() => parseRepositoryChannelSelection({ ...selection(), mode: "stable" })).toThrow();
    expect(() => parseRepositoryChannelSelection({ ...selection(), packages: [...selection().packages, ...selection().packages] })).toThrow();
    expect(() => parseRepositoryChannelSelection({ ...selection(), packages: [{ ...selection().packages[0], id: "kernel" }] })).toThrow();
  });

  test("binds the full manifest, exact bytes, source and manifest digest", () => {
    const parsed = parseRepositoryChannelSelection(selection());
    const manifest = parseRepositorySetupManifest({
      protocol: "neutron-repo-channel-manifest-v1", channel: "beta", id: "selection-1", revision: 1, name: "Install notes",
      packages: [{ id: "notes", version: 118, sha256: digest, size: 1024 }],
    });
    expect(() => assertRepositoryChannelSelectionManifest(parsed, manifest, source, digest)).not.toThrow();
    expect(() => assertRepositoryChannelSelectionManifest(parsed, manifest, "ryjl3-tyaaa-aaaaa-aaaba-cai", digest)).toThrow();
    expect(() => assertRepositoryChannelSelectionManifest(parsed, manifest, source, "b".repeat(64))).toThrow();
    expect(() => assertRepositoryChannelSelectionManifest(parsed, { ...manifest, packages: [] }, source, digest)).toThrow();
    expect(() => assertRepositoryChannelSelectionManifest(parsed, { ...manifest, packages: [{ ...manifest.packages[0]!, version: 119 }] }, source, digest)).toThrow();
  });

  test("old Kernel parsers reject beta manifests and new parsers require bound beta proofs", () => {
    const wire = {
      protocol: "neutron-repo-channel-manifest-v1", channel: "beta", id: "selection-1", revision: 1, name: "Install notes",
      packages: [{ id: "notes", version: 118, sha256: digest, size: 1024 }],
    };
    expect(() => parseRepositoryManifest(JSON.stringify(wire))).toThrow();
    const betaManifest = parseRepositorySetupManifest(JSON.stringify(wire));
    expect(betaManifest.protocol).toBe("neutron-repo-channel-manifest-v1");
    expect(() => parseRepositorySetupManifest({ ...wire, channel: "stable" })).toThrow();
    expect(() => parseRepositorySetupManifest({ ...wire, channel: undefined })).toThrow();
    const stableWire = { ...wire, protocol: "neutron-repo-v1" };
    const { channel: _channel, ...stable } = stableWire;
    const stableManifest = parseRepositorySetupManifest(stable);
    expect(stableManifest.protocol).toBe("neutron-repo-v1");
    const betaSelection = parseRepositoryChannelSelection(selection());
    expect(() => assertRepositoryChannelSelectionManifest(betaSelection, stableManifest, source, digest)).toThrow();
    const stableSelection = parseRepositoryChannelSelection({
      ...selection(), mode: "stable", packages: selection().packages.map((entry) => ({ ...entry, channel: "stable" })),
    });
    expect(() => assertRepositoryChannelSelectionManifest(stableSelection, betaManifest, source, digest)).toThrow();
  });
});
