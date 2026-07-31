import { describe, expect, test } from "bun:test";
import { IDL } from "@icp-sdk/core/candid";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  REPOSITORY_LIMITS,
  REPOSITORY_PENDING_STORAGE_KEY,
  RepositoryProtocolError,
  appendInternalHandoffFragment,
  appendRepositorySetupFragment,
  captureRepositorySetupFragment,
  parseInternalSetupFragment,
  parseProviderSetupFragment,
  parseRepositorySetupUrl,
  parseRepositoryInfo,
  parseRepositoryManifest,
  parseRepositoryManifestIndex,
  parseRepositoryReleaseRecord,
  readPendingRepositorySetup,
  repositoryIdlFactory,
  repositoryInfoPath,
  repositoryManifestIndexPath,
  repositoryManifestPath,
  repositoryPackagePath,
  repositoryReleasePath,
  serializeInternalSetupFragment,
  serializeProviderSetupFragment,
  serializeRepositoryManifest,
  serializeRepositoryReleaseRecord,
  stagePendingRepositorySetup,
  type RepositoryHistory,
  type RepositoryManifest,
  type RepositoryStorage,
} from "../src/repository.ts";

const repo = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const digest = "a".repeat(64);
const setup = { repo, manifest: "demopack", digest };

class MemoryStorage implements RepositoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function historyCalls(): { history: RepositoryHistory; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    history: {
      state: { retained: true },
      replaceState(_state, _unused, url) {
        calls.push(String(url));
      },
    },
  };
}

function validInfo() {
  return {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    name: "Example repository",
    description: "Local examples",
    provider: {
      name: "Example provider",
      website: "https://example.invalid",
      terms: "https://example.invalid/terms",
      privacy: "https://example.invalid/privacy",
      support: "https://example.invalid/support",
    },
  };
}

function manifestPackage(id = "hello", sha256 = digest) {
  return {
    id,
    version: 100,
    sha256,
    size: 123,
    publisher: {
      name: "Example publisher",
      website: "https://example.invalid/publisher",
    },
    source: "https://example.invalid/source",
  };
}

function validManifest(): RepositoryManifest {
  return {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    id: "demopack",
    revision: 1,
    name: "Demo Pack",
    description: "Two examples",
    packages: [manifestPackage()],
  };
}

describe("neutron-repo-v1 wire contract", () => {
  test("exposes only the four fixed query methods", () => {
    const service = repositoryIdlFactory({ IDL });
    const names = service._fields.map(([name]) => name).sort();
    expect(names).toEqual([
      "repo_info",
      "repo_manifest",
      "repo_manifests",
      "repo_package",
    ]);
    for (const [, method] of service._fields as [
      string,
      { annotations: string[] },
    ][]) {
      expect(method.annotations).toEqual(["query"]);
    }
  });

  test("binds identifiers to exact certified paths", () => {
    expect(repositoryInfoPath()).toBe("/repo/v1/info.json");
    expect(repositoryManifestIndexPath()).toBe("/repo/v1/manifests.json");
    expect(repositoryManifestPath("demo_pack-1")).toBe(
      "/repo/v1/manifests/demo_pack-1.json",
    );
    expect(repositoryPackagePath(digest)).toBe(
      `/repo/v1/packages/${digest}.neutron`,
    );
    expect(repositoryReleasePath("demo_app")).toBe(
      "/repo/v1/releases/demo_app.json",
    );
    expect(repositoryReleasePath("kernel")).toBe(
      "/repo/v1/releases/kernel.json",
    );
    expect(() => repositoryManifestPath("../demo")).toThrow(
      RepositoryProtocolError,
    );
    expect(() => repositoryPackagePath(digest.toUpperCase())).toThrow(
      RepositoryProtocolError,
    );
    for (const id of [
      "../demo",
      "abc",
      "constructor",
      "%",
      "%2",
      "%GG",
      "%6dail",
      "mail%2Fcontacts",
      "mail%252Fcontacts",
      "mail%00",
    ]) {
      expect(() => repositoryReleasePath(id)).toThrow(
        RepositoryProtocolError,
      );
    }
  });
});

describe("repository update release records", () => {
  const release = {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    id: "demo_app",
    version: 199,
    sha256: digest,
    size: 123,
  } as const;

  test("parses and serializes one closed bounded release identity", () => {
    expect(parseRepositoryReleaseRecord(release)).toEqual(release);
    expect(
      parseRepositoryReleaseRecord(JSON.stringify(release)),
    ).toEqual(release);
    const serialized = serializeRepositoryReleaseRecord(release);
    expect(parseRepositoryReleaseRecord(serialized)).toEqual(release);
    expect(new TextDecoder().decode(serialized)).toBe(
      `${JSON.stringify(release, null, 2)}\n`,
    );
  });

  test("rejects unknown, duplicate, malformed, and oversized records", () => {
    const invalid: unknown[] = [
      { ...release, protocol: "other" },
      { ...release, id: "../demo" },
      { ...release, version: 99 },
      { ...release, sha256: digest.toUpperCase() },
      { ...release, size: 0 },
      { ...release, size: REPOSITORY_LIMITS.packageBytes + 1 },
      { ...release, extra: true },
      { ...release, version: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const value of invalid) {
      expect(() => parseRepositoryReleaseRecord(value)).toThrow(
        RepositoryProtocolError,
      );
    }

    const duplicate = `{"protocol":"${NEUTRON_REPOSITORY_PROTOCOL}","id":"demo_app","version":198,"version":199,"sha256":"${digest}","size":123}`;
    expect(() => parseRepositoryReleaseRecord(duplicate)).toThrow(
      /repeats property 'version'/,
    );
    expect(() =>
      parseRepositoryReleaseRecord(
        JSON.stringify({ ...release, padding: "x".repeat(16 * 1024) }),
      ),
    ).toThrow(/exceeds 16384 UTF-8 bytes/);
  });
});

describe("repository setup fragments", () => {
  test("round-trips one exact canonical provider setup", () => {
    const fragment = serializeProviderSetupFragment(setup);
    expect(fragment).toBe(`#repo=${repo}&manifest=demopack&digest=${digest}`);
    expect(parseProviderSetupFragment(fragment)).toEqual(setup);
  });

  test("rejects partial, duplicate, unknown, and noncanonical principals", () => {
    const invalid = [
      `#repo=${repo}&manifest=demopack`,
      `#repo=${repo}&manifest=demopack&digest=${digest}&digest=${digest}`,
      `#repo=${repo}&manifest=demopack&digest=${digest}&track=x`,
      `#repo=${repo}&manifest=demopack&digest=${digest}&extra=removed`,
      `#repo=2vxsx-fae&manifest=demopack&digest=${digest}`,
      `#repo=aaaaa-aa&manifest=demopack&digest=${digest}`,
    ];
    for (const fragment of invalid) {
      expect(() => parseProviderSetupFragment(fragment)).toThrow(
        RepositoryProtocolError,
      );
    }
  });

  test("round-trips the internal setup handoff", () => {
    expect(parseInternalSetupFragment(serializeInternalSetupFragment(setup))).toEqual(
      setup,
    );
  });

  test("appends fragments without moving fields into queries", () => {
    expect(appendRepositorySetupFragment("https://neutron.example/", setup)).toBe(
      `https://neutron.example/#repo=${repo}&manifest=demopack&digest=${digest}`,
    );
    expect(
      appendInternalHandoffFragment("http://localhost:8000/?x=1", setup),
    ).toBe(
      `http://localhost:8000/?x=1#repo=${repo}&manifest=demopack&digest=${digest}`,
    );
    expect(() =>
      appendRepositorySetupFragment("https://neutron.example/?repo=leak", setup),
    ).toThrow(RepositoryProtocolError);
    expect(() =>
      appendRepositorySetupFragment("https://user:pass@neutron.example/", setup),
    ).toThrow(RepositoryProtocolError);
  });
});

describe("repository setup carrier URLs", () => {
  test("extracts the pinned setup without depending on the outer URL", () => {
    const url =
      `https://catalog.example/setup/apps?campaign=mail` +
      serializeProviderSetupFragment(setup);
    expect(parseRepositorySetupUrl(url)).toEqual(setup);
  });

  test("allows loopback HTTP only under the explicit local policy", () => {
    const fragment = serializeProviderSetupFragment(setup);
    const local = `http://neutron.localhost:8000/setup${fragment}`;
    expect(() => parseRepositorySetupUrl(local)).toThrow(
      /must use HTTPS/,
    );
    expect(
      parseRepositorySetupUrl(local, { allowLoopbackHttp: true }),
    ).toEqual(setup);
    expect(
      parseRepositorySetupUrl(
        `http://127.0.0.1:8000/setup${fragment}`,
        { allowLoopbackHttp: true },
      ),
    ).toEqual(setup);
    expect(() =>
      parseRepositorySetupUrl(
        `http://catalog.example/setup${fragment}`,
        { allowLoopbackHttp: true },
      ),
    ).toThrow(/must use HTTPS/);
  });

  test("rejects credentials, non-absolute URLs, query setup fields, and bad fragments", () => {
    const fragment = serializeProviderSetupFragment(setup);
    const invalid = [
      `https://user:pass@catalog.example/setup${fragment}`,
      `/setup${fragment}`,
      `ftp://catalog.example/setup${fragment}`,
      `https://catalog.example/setup?repo=${repo}${fragment}`,
      "https://catalog.example/setup",
      `https://catalog.example/setup#repo=${repo}&manifest=demopack`,
      `https://catalog.example/setup${fragment}&extra=true`,
      `https://catalog.example/setup${fragment}&digest=${digest}`,
    ];
    for (const value of invalid) {
      expect(() => parseRepositorySetupUrl(value)).toThrow(
        RepositoryProtocolError,
      );
    }
  });

  test("bounds both source and normalized URL length", () => {
    const fragment = serializeProviderSetupFragment(setup);
    expect(() =>
      parseRepositorySetupUrl(
        `https://catalog.example/${"x".repeat(REPOSITORY_LIMITS.externalUrlCharacters)}${fragment}`,
      ),
    ).toThrow(/at most 2048 characters/);
    expect(() =>
      parseRepositorySetupUrl(
        `https://catalog.example/${"é".repeat(700)}${fragment}`,
      ),
    ).toThrow(/at most 2048 characters/);
  });
});

describe("transient setup capture", () => {
  test("stores a usable copy before stripping the address bar", () => {
    const storage = new MemoryStorage();
    const { history, calls } = historyCalls();
    const result = captureRepositorySetupFragment({
      mode: "internal",
      location: {
        href: `https://neutron.example/?keep=1${serializeInternalSetupFragment(setup)}`,
        hash: serializeInternalSetupFragment(setup),
      },
      storage,
      history,
      now: 1000,
    });
    expect(result.status).toBe("captured");
    expect(calls).toEqual(["https://neutron.example/?keep=1"]);
    expect(readPendingRepositorySetup(storage, 1001)).toEqual({
      capturedAt: 1000,
      reference: setup,
    });
  });

  test("does not strip when storage rejects the only usable copy", () => {
    const { history, calls } = historyCalls();
    const result = captureRepositorySetupFragment({
      mode: "provider",
      location: {
        href: `https://dispenser.example/${serializeProviderSetupFragment(setup)}`,
        hash: serializeProviderSetupFragment(setup),
      },
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("denied");
        },
        removeItem: () => undefined,
      },
      history,
      now: 1000,
    });
    expect(result.status).toBe("storage_error");
    expect(calls).toEqual([]);
  });

  test("ignores unrelated fragments but strips malformed reserved input", () => {
    const storage = new MemoryStorage();
    const first = historyCalls();
    expect(
      captureRepositorySetupFragment({
        mode: "provider",
        location: { href: "https://example/#workspace", hash: "#workspace" },
        storage,
        history: first.history,
      }),
    ).toEqual({ status: "none" });
    expect(first.calls).toEqual([]);

    const second = historyCalls();
    const result = captureRepositorySetupFragment({
      mode: "provider",
      location: {
        href: `https://example/#repo=${repo}`,
        hash: `#repo=${repo}`,
      },
      storage,
      history: second.history,
    });
    expect(result.status).toBe("invalid");
    expect(second.calls).toEqual(["https://example/"]);

    const removed = historyCalls();
    const removedResult = captureRepositorySetupFragment({
      mode: "internal",
      location: {
        href: "https://example/#claim=retired",
        hash: "#claim=retired",
      },
      storage,
      history: removed.history,
    });
    expect(removedResult.status).toBe("invalid");
    expect(removed.calls).toEqual(["https://example/"]);
  });

  test("a stripped malformed fragment retires stale setup", () => {
    const providerStorage = new MemoryStorage();
    captureRepositorySetupFragment({
      mode: "provider",
      location: {
        href: `https://example/${serializeProviderSetupFragment(setup)}`,
        hash: serializeProviderSetupFragment(setup),
      },
      storage: providerStorage,
      history: historyCalls().history,
      now: 1_000,
    });
    const providerInvalid = captureRepositorySetupFragment({
      mode: "provider",
      location: { href: `https://example/#repo=${repo}`, hash: `#repo=${repo}` },
      storage: providerStorage,
      history: historyCalls().history,
      now: 2_000,
    });
    expect(providerInvalid.status).toBe("invalid");
    expect(readPendingRepositorySetup(providerStorage, 2_001)).toBeNull();
  });

  test("removes the pending setup after one hour", () => {
    const storage = new MemoryStorage();
    const { history } = historyCalls();
    captureRepositorySetupFragment({
      mode: "internal",
      location: {
        href: `https://example/${serializeInternalSetupFragment(setup)}`,
        hash: serializeInternalSetupFragment(setup),
      },
      storage,
      history,
      now: 1000,
    });
    expect(
      readPendingRepositorySetup(
        storage,
        1000 + REPOSITORY_LIMITS.pendingSetupLifetimeMs + 1,
      ),
    ).toBeNull();
    expect(storage.getItem(REPOSITORY_PENDING_STORAGE_KEY)).toBeNull();
  });

  test("stages a trusted normalized setup in the canonical pending format", () => {
    const storage = new MemoryStorage();
    expect(stagePendingRepositorySetup(storage, setup, 1234)).toEqual({
      reference: setup,
      capturedAt: 1234,
    });
    expect(
      JSON.parse(storage.getItem(REPOSITORY_PENDING_STORAGE_KEY)!),
    ).toEqual({
      format: 1,
      captured_at_ms: 1234,
      reference: setup,
    });
    expect(readPendingRepositorySetup(storage, 1235)).toEqual({
      reference: setup,
      capturedAt: 1234,
    });
  });

  test("validates trusted staged input before replacing pending storage", () => {
    const storage = new MemoryStorage();
    stagePendingRepositorySetup(storage, setup, 1234);
    const original = storage.getItem(REPOSITORY_PENDING_STORAGE_KEY);
    expect(() =>
      stagePendingRepositorySetup(
        storage,
        { ...setup, digest: digest.toUpperCase() },
        2000,
      ),
    ).toThrow(RepositoryProtocolError);
    expect(() =>
      stagePendingRepositorySetup(storage, setup, Number.NaN),
    ).toThrow(RepositoryProtocolError);
    expect(storage.getItem(REPOSITORY_PENDING_STORAGE_KEY)).toBe(original);
  });
});

describe("closed repository metadata", () => {
  test("normalizes and validates repository info", () => {
    const parsed = parseRepositoryInfo(validInfo());
    expect(parsed.provider.website).toBe("https://example.invalid/");
    expect(() => parseRepositoryInfo({ ...validInfo(), executable: "x" })).toThrow(
      RepositoryProtocolError,
    );
    expect(() =>
      parseRepositoryInfo({
        ...validInfo(),
        provider: { name: "Provider", website: "http://example.invalid" },
      }),
    ).toThrow(RepositoryProtocolError);
    expect(() =>
      parseRepositoryInfo({ ...validInfo(), name: "Spoof\u202e" }),
    ).toThrow(RepositoryProtocolError);
  });

  test("validates package identity, uniqueness, kernel exclusion, and totals", () => {
    expect(parseRepositoryManifest(validManifest())).toEqual(validManifest());
    expect(() =>
      parseRepositoryManifest({ ...validManifest(), unknown: true }),
    ).toThrow(RepositoryProtocolError);
    expect(() =>
      parseRepositoryManifest({
        ...validManifest(),
        packages: [manifestPackage("kernel")],
      }),
    ).toThrow(RepositoryProtocolError);
    expect(() =>
      parseRepositoryManifest({
        ...validManifest(),
        packages: [manifestPackage(), manifestPackage()],
      }),
    ).toThrow(RepositoryProtocolError);
    expect(() =>
      parseRepositoryManifest({
        ...validManifest(),
        packages: [
          { ...manifestPackage("hello", "b".repeat(64)), size: 32 * 1024 * 1024 },
          { ...manifestPackage("other", "c".repeat(64)), size: 32 * 1024 * 1024 },
          { ...manifestPackage("third", "d".repeat(64)), size: 1 },
        ],
      }),
    ).toThrow(RepositoryProtocolError);
  });

  test("requires a sorted, unique, closed manifest index", () => {
    const summary = {
      id: "demopack",
      revision: 1,
      name: "Demo Pack",
      digest,
      package_count: 1,
    };
    expect(
      parseRepositoryManifestIndex({
        protocol: NEUTRON_REPOSITORY_PROTOCOL,
        manifests: [summary, { ...summary, id: "hello", digest: "b".repeat(64) }],
      }).manifests.map((entry) => entry.id),
    ).toEqual(["demopack", "hello"]);
    expect(() =>
      parseRepositoryManifestIndex({
        protocol: NEUTRON_REPOSITORY_PROTOCOL,
        manifests: [{ ...summary, id: "hello" }, summary],
      }),
    ).toThrow(RepositoryProtocolError);
  });

  test("serializes exact manifest bytes deterministically", () => {
    const first = serializeRepositoryManifest(validManifest());
    const second = serializeRepositoryManifest(
      JSON.parse(new TextDecoder().decode(first)),
    );
    expect(first).toEqual(second);
    expect(new TextDecoder().decode(first)).toEndWith("\n");
  });
});
