import { beforeAll, expect, test } from "bun:test";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  REPOSITORY_LIMITS,
  repositoryReleasePath,
  serializeRepositoryReleaseRecord,
  type RepositoryReleaseRecord,
} from "neutron-tools/repository";
import {
  fetchUpdatePackage,
  fetchUpdateRelease,
} from "../src/updates/client.ts";
import { checkForAppUpdates } from "../src/updates/check.ts";
import {
  assertSelectedUpdateBounds,
  installedUpdateApps,
  type AvailableUpdate,
} from "../src/updates/helpers.ts";
import {
  UPDATE_CHECK_WAVE_SIZE,
  type FetchedRelease,
  type InstalledUpdateApp,
} from "../src/updates/model.ts";
import { loadIcRuntimeFixture } from "./runtime_fixture.ts";
import { parseInstallProvenance } from "../src/repository/provenance.ts";

const SOURCE = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const CERTIFICATE =
  "certificate=:Y2VydGlmaWNhdGU=:, tree=:dHJlZQ==:, expr_path=:cGF0aA==:, version=2";

beforeAll(loadIcRuntimeFixture);

function certifiedHeaders(
  entries: Record<string, string> = {},
): Record<string, string> {
  return {
    "ic-certificate": CERTIFICATE,
    "ic-certificateexpression": "default_certification(ValidationArgs{certification: Certification{}})",
    ...entries,
  };
}

function release(
  id: string,
  version = 101,
  bytes = new Uint8Array([1, 2, 3]),
): RepositoryReleaseRecord {
  return {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    id,
    version,
    sha256: hashContent(bytes),
    size: bytes.byteLength,
  };
}

test("release checks use one fixed credentialless certified asset path", async () => {
  const record = release("mail");
  let requested = "";
  let requestedInit: RequestInit | undefined;
  const fetched = await fetchUpdateRelease(SOURCE, "mail", {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested = String(input);
      requestedInit = init;
      return new Response(
        serializeRepositoryReleaseRecord(record) as unknown as BodyInit,
        {
        headers: certifiedHeaders({
          "content-type": "application/json; charset=utf-8",
        }),
        },
      );
    }) as unknown as typeof fetch,
  });

  expect(requested).toBe(
    `https://${SOURCE}.icp0.io/repo/v1/releases/mail.json`,
  );
  expect(requested).not.toContain(String(record.version));
  expect(new URL(requested).search).toBe("");
  expect(requestedInit).toMatchObject({
    cache: "no-cache",
    credentials: "omit",
    method: "GET",
    mode: "cors",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  expect(requestedInit?.body).toBeUndefined();
  expect(requestedInit?.referrer).toBeUndefined();
  expect([...new Headers(requestedInit?.headers).entries()]).toEqual([
    ["accept", "application/json"],
  ]);
  expect(new Headers(requestedInit?.headers).has("authorization")).toBe(false);
  expect(fetched).toEqual({
    source: SOURCE,
    record,
    releaseDigest: hashContent(serializeRepositoryReleaseRecord(record)),
  });
});

test("release checks distinguish not-published and reject malformed transport", async () => {
  await expect(
    fetchUpdateRelease(SOURCE, "mail", {
      fetch: (async () =>
        new Response("missing", {
          status: 404,
          headers: certifiedHeaders(),
        })) as unknown as typeof fetch,
    }),
  ).resolves.toBeNull();

  await expect(
    fetchUpdateRelease(SOURCE, "mail", {
      fetch: (async () =>
        new Response(JSON.stringify(release("mail")), {
          headers: certifiedHeaders({ "content-type": "text/html" }),
        })) as unknown as typeof fetch,
    }),
  ).rejects.toMatchObject({ code: "wrong_content_type" });

  await expect(
    fetchUpdateRelease(SOURCE, "mail", {
      fetch: (async () =>
        new Response(new Uint8Array(16_385) as unknown as BodyInit, {
          headers: certifiedHeaders({
            "content-length": "16385",
            "content-type": "application/json",
          }),
        })) as unknown as typeof fetch,
    }),
  ).rejects.toMatchObject({ code: "too_large" });
});

test("release checks reject redirected and wrong-origin responses", async () => {
  const body = serializeRepositoryReleaseRecord(release("mail"));
  const redirected = new Response(body as unknown as BodyInit, {
    headers: certifiedHeaders({ "content-type": "application/json" }),
  });
  Object.defineProperty(redirected, "redirected", { value: true });
  await expect(
    fetchUpdateRelease(SOURCE, "mail", {
      fetch: (async () => redirected) as unknown as typeof fetch,
    }),
  ).rejects.toMatchObject({ code: "redirected" });

  const wrongOrigin = new Response(body as unknown as BodyInit, {
    headers: certifiedHeaders({ "content-type": "application/json" }),
  });
  Object.defineProperty(wrongOrigin, "url", {
    value: "https://example.com/repo/v1/releases/mail.json",
  });
  await expect(
    fetchUpdateRelease(SOURCE, "mail", {
      fetch: (async () => wrongOrigin) as unknown as typeof fetch,
    }),
  ).rejects.toMatchObject({ code: "wrong_origin" });
});

test("release checks reject encoded aliases and malformed encoded response paths", async () => {
  const body = serializeRepositoryReleaseRecord(release("mail"));
  for (const path of [
    "/repo/v1/releases/%6dail.json",
    "/repo/v1/releases/mail%2Ejson",
    "/repo/v1/releases/%ZZ.json",
  ]) {
    const response = new Response(body as unknown as BodyInit, {
      headers: certifiedHeaders({ "content-type": "application/json" }),
    });
    Object.defineProperty(response, "url", {
      value: `https://${SOURCE}.icp0.io${path}`,
    });
    await expect(
      fetchUpdateRelease(SOURCE, "mail", {
        fetch: (async () => response) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "wrong_origin" });
  }
});

test("release checks reject a valid record for a different app ID", async () => {
  await expect(
    fetchUpdateRelease(SOURCE, "mail", {
      fetch: (async () =>
        new Response(
          serializeRepositoryReleaseRecord(
            release("contacts"),
          ) as unknown as BodyInit,
          {
            headers: certifiedHeaders({
              "content-type": "application/json; charset=utf-8",
            }),
          },
        )) as unknown as typeof fetch,
    }),
  ).rejects.toMatchObject({ code: "wrong_id" });
});

test("package headers fail before a large response body is read", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(1024));
    },
  });
  await expect(
    fetchUpdatePackage(SOURCE, release("mail"), {
      fetch: (async () =>
        new Response(body, {
          headers: certifiedHeaders({ "content-type": "text/html" }),
        })) as unknown as typeof fetch,
    }),
  ).rejects.toMatchObject({ code: "wrong_content_type" });
  expect(pulls).toBeLessThanOrEqual(1);
});

test("release checks bound a stalled response body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
  });
  await expect(
    fetchUpdateRelease(SOURCE, "mail", {
      fetch: (async () =>
        new Response(body, {
          headers: certifiedHeaders({ "content-type": "application/json" }),
        })) as unknown as typeof fetch,
      timeoutMs: 5,
    }),
  ).rejects.toMatchObject({ code: "timed_out" });
  expect(cancelled).toBe(true);
});

test("content-addressed update packages require exact bytes and identity encoding", async () => {
  const bytes = new Uint8Array([7, 8, 9, 10]);
  const record = release("mail", 102, bytes);
  let init: RequestInit | undefined;
  const received = await fetchUpdatePackage(SOURCE, record, {
    fetch: (async (_input: RequestInfo | URL, request?: RequestInit) => {
      init = request;
      return new Response(bytes as unknown as BodyInit, {
        headers: certifiedHeaders({
          "content-encoding": "identity",
          "content-type": "application/vnd.neutron.package",
        }),
      });
    }) as unknown as typeof fetch,
  });
  expect(received).toEqual(bytes);
  expect(init).toMatchObject({
    cache: "default",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });

  await expect(
    fetchUpdatePackage(SOURCE, record, {
      fetch: (async () =>
        new Response(
          new Uint8Array([7, 8, 9]) as unknown as BodyInit,
          {
            headers: certifiedHeaders({
              "content-type": "application/vnd.neutron.package",
            }),
          },
        )) as unknown as typeof fetch,
    }),
  ).rejects.toThrow("size does not match");
  await expect(
    fetchUpdatePackage(SOURCE, record, {
      fetch: (async () =>
        new Response(
          new Uint8Array([7, 8, 9, 11]) as unknown as BodyInit,
          {
            headers: certifiedHeaders({
              "content-type": "application/vnd.neutron.package",
            }),
          },
        )) as unknown as typeof fetch,
    }),
  ).rejects.toThrow("digest does not match");
  await expect(
    fetchUpdatePackage(SOURCE, record, {
      fetch: (async () =>
        new Response(bytes as unknown as BodyInit, {
          headers: certifiedHeaders({
            "content-encoding": "gzip",
            "content-type": "application/vnd.neutron.package",
          }),
        })) as unknown as typeof fetch,
    }),
  ).rejects.toThrow("without content transformation");
});

test("update assets accept jointly hidden proofs and reject every incomplete visible envelope", async () => {
  const body = serializeRepositoryReleaseRecord(release("mail"));
  await expect(
    fetchUpdateRelease(SOURCE, "mail", {
      fetch: (async () =>
        new Response(body as unknown as BodyInit, {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    }),
  ).resolves.toMatchObject({ record: { id: "mail" } });

  const incompleteProofs: Record<string, string>[] = [
    { "ic-certificateexpression": "default_certification()" },
    { "ic-certificate": CERTIFICATE },
    {
      "ic-certificate": "tree=:dHJlZQ==:, expr_path=:cGF0aA==:, version=2",
      "ic-certificateexpression": "default_certification()",
    },
    {
      "ic-certificate": "certificate=:Y2VydA==:, expr_path=:cGF0aA==:, version=2",
      "ic-certificateexpression": "default_certification()",
    },
    {
      "ic-certificate": "certificate=:Y2VydA==:, tree=:dHJlZQ==:, version=2",
      "ic-certificateexpression": "default_certification()",
    },
    {
      "ic-certificate":
        "certificate=:Y2VydA==:, tree=:dHJlZQ==:, expr_path=:cGF0aA==:, version=1",
      "ic-certificateexpression": "default_certification()",
    },
    {
      "ic-certificate":
        "certificate=:not!base64:, tree=:dHJlZQ==:, expr_path=:cGF0aA==:, version=2",
      "ic-certificateexpression": "default_certification()",
    },
    {
      "ic-certificate": CERTIFICATE,
      "ic-certificateexpression": "no_certification",
    },
  ];

  for (const proof of incompleteProofs) {
    await expect(
      fetchUpdateRelease(SOURCE, "mail", {
        fetch: (async () =>
          new Response(body as unknown as BodyInit, {
            headers: { "content-type": "application/json", ...proof },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "uncertified" });
  }
});

test("update assets trust proof verification only at the exact fixed gateway", async () => {
  const body = serializeRepositoryReleaseRecord(release("mail"));
  const response = new Response(body as unknown as BodyInit, {
    headers: certifiedHeaders({ "content-type": "application/json" }),
  });
  Object.defineProperty(response, "url", {
    value: "https://fake-gateway.example/repo/v1/releases/mail.json",
  });

  await expect(
    fetchUpdateRelease(SOURCE, "mail", {
      fetch: (async () => response) as unknown as typeof fetch,
    }),
  ).rejects.toMatchObject({ code: "wrong_origin" });

  await expect(
    fetchUpdateRelease(SOURCE, "mail", {
      // A real verified gateway rejects an invalid cryptographic proof before
      // exposing any Response to browser code.
      fetch: (async () => {
        throw new TypeError("gateway certificate verification failed");
      }) as unknown as typeof fetch,
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
});

test("checks request only installed IDs in bounded waves of 20", async () => {
  const orderedApps: InstalledUpdateApp[] = Array.from(
    { length: 57 },
    (_, index) => ({
      appId: `app_${String(index).padStart(2, "0")}`,
      name: `App ${index}`,
      version: 100,
      updateSource: SOURCE,
    }),
  );
  const apps = [...orderedApps].reverse();
  const requested: string[] = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  let completed = 0;
  const completedWhenStarted: number[] = [];
  const observedResults: string[] = [];
  const summary = await checkForAppUpdates(apps, {
    async fetchRelease(source, appId): Promise<FetchedRelease> {
      expect(source).toBe(SOURCE);
      requested.push(appId);
      completedWhenStarted.push(completed);
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      completed += 1;
      const record = release(appId);
      return {
        source,
        record,
        releaseDigest: hashContent(
          serializeRepositoryReleaseRecord(record),
        ),
      };
    },
    onResult(result) {
      observedResults.push(`${result.kind}:${result.appId}`);
    },
  });

  expect(requested).toEqual(orderedApps.map(({ appId }) => appId));
  expect(maximumInFlight).toBeLessThanOrEqual(UPDATE_CHECK_WAVE_SIZE);
  expect(completedWhenStarted).toEqual([
    ...Array<number>(20).fill(0),
    ...Array<number>(20).fill(20),
    ...Array<number>(17).fill(40),
  ]);
  expect(summary.results).toHaveLength(57);
  expect(summary.results.every(({ kind }) => kind === "available")).toBe(true);
  expect(observedResults.slice(0, 20)).toEqual(
    orderedApps.slice(0, 20).map(({ appId }) => `checking:${appId}`),
  );
  expect(observedResults).toContain("available:app_56");
});

test("checks only exact installed paths in a source with 100 unrelated releases", async () => {
  const installed: InstalledUpdateApp[] = [
    {
      appId: "zulu_app",
      name: "Zulu",
      version: 7_301,
      updateSource: SOURCE,
    },
    {
      appId: "alpha_app",
      name: "Alpha",
      version: 4_201,
      updateSource: SOURCE,
    },
    {
      appId: "middle_app",
      name: "Middle",
      version: 6_101,
      updateSource: SOURCE,
    },
  ];
  const sourceAssets = new Map<string, RepositoryReleaseRecord>();
  for (let index = 0; index < 100; index += 1) {
    const appId = `unrelated_${String(index).padStart(3, "0")}`;
    sourceAssets.set(repositoryReleasePath(appId), release(appId));
  }
  for (const app of installed) {
    sourceAssets.set(
      repositoryReleasePath(app.appId),
      release(app.appId, app.version + 1),
    );
  }

  const requestedPaths: string[] = [];
  const requestInits: RequestInit[] = [];
  const summary = await checkForAppUpdates([...installed].reverse(), {
    fetchRelease(source, appId, { signal }) {
      return fetchUpdateRelease(source, appId, {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          requestedPaths.push(path);
          requestInits.push(init ?? {});
          const record = sourceAssets.get(path);
          return record
            ? new Response(
                serializeRepositoryReleaseRecord(record) as unknown as BodyInit,
                {
                  headers: certifiedHeaders({
                    "content-type": "application/json; charset=utf-8",
                  }),
                },
              )
            : new Response("missing", {
                status: 404,
                headers: certifiedHeaders(),
              });
        }) as unknown as typeof fetch,
        ...(signal ? { signal } : {}),
      });
    },
  });

  const expectedApps = [...installed].sort((left, right) =>
    left.appId.localeCompare(right.appId),
  );
  expect(sourceAssets.size).toBe(103);
  expect(requestedPaths).toEqual(
    expectedApps.map(({ appId }) => repositoryReleasePath(appId)),
  );
  expect(requestedPaths.some((path) => path.includes("unrelated_"))).toBe(
    false,
  );
  expect(summary.results.every(({ kind }) => kind === "available")).toBe(true);
  for (const init of requestInits) {
    const headers = new Headers(init.headers);
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe("omit");
    expect(init.referrer).toBeUndefined();
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(headers.has("authorization")).toBe(false);
    expect([...headers.entries()]).toEqual([["accept", "application/json"]]);
    for (const { version } of installed) {
      expect(
        JSON.stringify({ headers: [...headers], body: init.body }),
      ).not.toContain(String(version));
    }
  }
});

test("checker maps a certified 404 to not published and isolates HTTP 500", async () => {
  const apps: InstalledUpdateApp[] = [
    {
      appId: "available_app",
      name: "Available",
      version: 100,
      updateSource: SOURCE,
    },
    {
      appId: "broken_app",
      name: "Broken",
      version: 100,
      updateSource: SOURCE,
    },
    {
      appId: "missing_app",
      name: "Missing",
      version: 100,
      updateSource: SOURCE,
    },
  ];
  const summary = await checkForAppUpdates(apps, {
    fetchRelease(source, appId, { signal }) {
      return fetchUpdateRelease(source, appId, {
        fetch: (async () => {
          if (appId === "missing_app") {
            return new Response("missing", {
              status: 404,
              headers: certifiedHeaders(),
            });
          }
          if (appId === "broken_app") {
            return new Response("failure", {
              status: 500,
              headers: certifiedHeaders(),
            });
          }
          return new Response(
            serializeRepositoryReleaseRecord(
              release(appId),
            ) as unknown as BodyInit,
            {
              headers: certifiedHeaders({
                "content-type": "application/json; charset=utf-8",
              }),
            },
          );
        }) as unknown as typeof fetch,
        ...(signal ? { signal } : {}),
      });
    },
  });

  expect(
    Object.fromEntries(
      summary.results.map((result) => [result.appId, result.kind]),
    ),
  ).toEqual({
    available_app: "available",
    broken_app: "failed",
    missing_app: "not_published",
  });
  expect(
    summary.results.find(({ appId }) => appId === "broken_app"),
  ).toMatchObject({ reason: "unavailable" });
});

test("equal version and provisioned installed digest is current", async () => {
  const record = release("current_app", 101, new Uint8Array([4, 5, 6]));
  const installed = installedUpdateApps(
    {
      current_app: {
        name: "Current",
        version: record.version,
        update_source: SOURCE,
      },
    } as never,
    parseInstallProvenance({
      format: 1,
      apps: {
        current_app: {
          kind: "provisioned",
          package_digest: record.sha256,
        },
      },
    }),
  );

  expect(installed).toEqual([
    {
      appId: record.id,
      name: "Current",
      version: record.version,
      updateSource: SOURCE,
      packageDigest: record.sha256,
    },
  ]);
  const summary = await checkForAppUpdates(
    installed,
    {
      async fetchRelease(source): Promise<FetchedRelease> {
        return {
          source,
          record,
          releaseDigest: hashContent(serializeRepositoryReleaseRecord(record)),
        };
      },
    },
  );

  expect(summary.results).toEqual([
    expect.objectContaining({
      appId: "current_app",
      kind: "current",
      release: record,
    }),
  ]);
});

test("Update All selection bounds reject too many apps and aggregate bytes", () => {
  const candidate = (appId: string, size: number): AvailableUpdate => ({
    kind: "available",
    appId,
    name: appId,
    installed: 100,
    source: SOURCE,
    release: {
      protocol: NEUTRON_REPOSITORY_PROTOCOL,
      id: appId,
      version: 101,
      sha256: "a".repeat(64),
      size,
    },
    releaseDigest: "b".repeat(64),
  });
  const maximumCount = Array.from(
    { length: REPOSITORY_LIMITS.packagesPerManifest },
    (_, index) => candidate(`app_${String(index).padStart(2, "0")}`, 1),
  );

  expect(() => assertSelectedUpdateBounds(maximumCount)).not.toThrow();
  expect(() =>
    assertSelectedUpdateBounds([
      ...maximumCount,
      candidate("app_over_limit", 1),
    ]),
  ).toThrow("at most");
  expect(() =>
    assertSelectedUpdateBounds([
      candidate("large_one", REPOSITORY_LIMITS.manifestPackageBytes / 2),
      candidate("large_two", REPOSITORY_LIMITS.manifestPackageBytes / 2),
      candidate("large_three", 1),
    ]),
  ).toThrow("aggregate download limit");
});

test("checks deduplicate identical IDs and never mix source groups", async () => {
  const secondSource = "ryjl3-tyaaa-aaaaa-aaaba-cai";
  const duplicate = {
    appId: "mail",
    name: "Mail",
    version: 100,
    updateSource: SOURCE,
  } as const;
  const requested: Array<[string, string]> = [];
  const summary = await checkForAppUpdates(
    [
      duplicate,
      { ...duplicate },
      {
        appId: "contacts",
        name: "Contacts",
        version: 100,
        updateSource: secondSource,
      },
    ],
    {
      async fetchRelease(source, appId): Promise<FetchedRelease> {
        requested.push([source, appId]);
        const record = release(appId);
        return {
          source,
          record,
          releaseDigest: hashContent(serializeRepositoryReleaseRecord(record)),
        };
      },
    },
  );

  expect(requested).toEqual([
    [SOURCE, "mail"],
    [secondSource, "contacts"],
  ]);
  expect(summary.results.map(({ appId }) => appId)).toEqual([
    "contacts",
    "mail",
  ]);

  await expect(
    checkForAppUpdates(
      [duplicate, { ...duplicate, version: 99 }],
      { async fetchRelease() { return null; } },
    ),
  ).rejects.toThrow("Conflicting installed snapshots for mail");
});

test("partial failures, regressions, manual apps, and equivocation remain isolated", async () => {
  const apps: InstalledUpdateApp[] = [
    {
      appId: "current_app",
      name: "Current",
      version: 101,
      updateSource: SOURCE,
      packageDigest: "a".repeat(64),
    },
    {
      appId: "failed_app",
      name: "Failed",
      version: 100,
      updateSource: SOURCE,
    },
    {
      appId: "unknown_digest",
      name: "Unknown digest",
      version: 101,
      updateSource: SOURCE,
    },
    {
      appId: "manual_app",
      name: "Manual",
      version: 100,
    },
    {
      appId: "old_app",
      name: "Old",
      version: 102,
      updateSource: SOURCE,
    },
  ];
  const summary = await checkForAppUpdates(apps, {
    async fetchRelease(source, appId): Promise<FetchedRelease> {
      if (appId === "failed_app") throw new Error("private transport detail");
      const record =
        appId === "current_app"
          ? {
              ...release(appId, 101),
              sha256: "b".repeat(64),
            }
          : release(appId, 101);
      return {
        source,
        record,
        releaseDigest: hashContent(
          serializeRepositoryReleaseRecord(record),
        ),
      };
    },
  });
  expect(
    Object.fromEntries(summary.results.map((result) => [result.appId, result.kind])),
  ).toEqual({
    current_app: "failed",
    failed_app: "failed",
    manual_app: "manual_only",
    old_app: "source_regression",
    unknown_digest: "failed",
  });
  expect(
    summary.results.find(({ appId }) => appId === "current_app"),
  ).toMatchObject({ reason: "equivocation" });
  expect(
    summary.results.find(({ appId }) => appId === "failed_app"),
  ).toMatchObject({ reason: "unavailable" });
  expect(
    summary.results.find(({ appId }) => appId === "unknown_digest"),
  ).toMatchObject({ reason: "unverifiable" });
});

test("cancelling a check rejects late work without a final summary", async () => {
  const controller = new AbortController();
  let started = false;
  const checking = checkForAppUpdates(
    [
      {
        appId: "mail",
        name: "Mail",
        version: 100,
        updateSource: SOURCE,
      },
    ],
    {
      signal: controller.signal,
      fetchRelease(_source, _appId, { signal }) {
        started = true;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("cancelled");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      },
    },
  );
  await Promise.resolve();
  expect(started).toBe(true);
  controller.abort();
  await expect(checking).rejects.toMatchObject({ name: "AbortError" });
});
