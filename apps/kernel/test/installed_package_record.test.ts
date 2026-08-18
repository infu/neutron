import { expect, test } from "bun:test";
import { hashContent } from "neutron-tools/src/hash.ts";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX,
  NEUTRON_PACKAGE_RECORD_PATH,
  neutronAppSourceArchiveFilename,
} from "neutron-tools/package_record.js";
import {
  HTTPS_SOURCE_BROWSER_DOWNLOAD_MAX_BYTES,
  downloadAndVerifyHttpsSourceOffer,
  downloadAndVerifyInstalledPackageFile,
  fetchAndVerifyHttpsSourceOffer,
  fetchAndVerifyInstalledPackageFile,
  installedPackageAssetBasePath,
  loadInstalledPackageRecord,
  loadInstalledPackageRecordInventory,
  type InstalledPackageAssetReader,
  type InstalledPackageDownloadEnvironment,
} from "../src/settings/installed_package_record.ts";
import { registryApp } from "./app_registry_fixture.ts";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function installedFixture(
  id = "hello",
  version = 100,
): {
  assets: Record<string, Uint8Array>;
  recordBytes: Uint8Array;
} {
  const base = installedPackageAssetBasePath(id);
  const manifestBytes = encode(
    JSON.stringify({
      format: 3,
      id,
      name: "Hello",
      version,
      entry: "a".repeat(64),
    }),
  );
  const licenseBytes = encode("GNU General Public License version 3\n");
  const record = {
    format: 1,
    package: {
      id,
      version,
      manifest: embeddedRef("neutron.json", manifestBytes),
    },
    license: {
      id: "GPL-3.0-only",
      texts: [
        {
          id: "GPL-3.0-only",
          ...embeddedRef("legal/LICENSE.GPL-3.0.txt", licenseBytes),
        },
      ],
    },
    source: {
      kind: "https",
      revision: "git:0123456789abcdef",
      url: "https://source.example/releases/hello-v1.tar.gz",
      sha256: "f".repeat(64),
      bytes: 500,
    },
    dependencies: [],
    notices: [],
    memory: null,
    build: { inputs: [], commands: [] },
  };
  const recordBytes = encode(JSON.stringify(record));
  return {
    assets: {
      [`${base}neutron.json`]: manifestBytes,
      [`${base}legal/LICENSE.GPL-3.0.txt`]: licenseBytes,
      [`${base}${NEUTRON_PACKAGE_RECORD_PATH}`]: recordBytes,
    },
    recordBytes,
  };
}

test("installed package inspection distinguishes a missing legacy record", async () => {
  const calls: string[] = [];
  const inspection = await loadInstalledPackageRecord(
    { id: "hello", version: 100 },
    async (path) => {
      calls.push(path);
      return undefined;
    },
  );

  expect(inspection).toEqual({
    status: "legacy",
    recordPath: "/app/hello/pkg/legal/package-record.v1.json",
  });
  expect(calls).toEqual(["/app/hello/pkg/legal/package-record.v1.json"]);
});

test("installed inspection applies bounded parsing and manifest binding without fetching an HTTPS source offer", async () => {
  const { assets, recordBytes } = installedFixture();
  const calls: string[] = [];
  const reader: InstalledPackageAssetReader = async (path, maximumBytes) => {
    calls.push(path);
    const value = assets[path];
    if (value && value.byteLength > maximumBytes) throw new Error("too large");
    return value;
  };

  const inspection = await loadInstalledPackageRecord(
    { id: "hello", version: 100 },
    reader,
  );

  expect(inspection.status).toBe("declared");
  if (inspection.status !== "declared") throw new Error("expected record");
  expect(inspection.record.license.id).toBe("GPL-3.0-only");
  expect(inspection.record.source).toEqual({
    kind: "https",
    revision: "git:0123456789abcdef",
    url: "https://source.example/releases/hello-v1.tar.gz",
    sha256: "f".repeat(64),
    bytes: 500,
  });
  expect(inspection.recordSha256).toBe(hashContent(recordBytes));
  expect(calls).toEqual([
    "/app/hello/pkg/legal/package-record.v1.json",
    "/app/hello/pkg/neutron.json",
  ]);
  expect(calls).not.toContain(
    "https://source.example/releases/hello-v1.tar.gz",
  );
});

test("embedded source and license payloads remain lazy during Settings inspection", async () => {
  const fixture = installedFixture();
  const recordPath = "/app/hello/pkg/legal/package-record.v1.json";
  const record = JSON.parse(new TextDecoder().decode(fixture.recordBytes));
  record.features = [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE];
  record.source = {
    kind: "embedded",
    revision: "git:0123456789abcdef",
    path: NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
    sha256: "9".repeat(64),
    bytes: NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.encodedBytes,
  };
  fixture.assets[recordPath] = encode(JSON.stringify(record));
  const calls: string[] = [];

  const inspection = await loadInstalledPackageRecord(
    { id: "hello", version: 100 },
    async (path) => {
      calls.push(path);
      return fixture.assets[path];
    },
  );

  expect(inspection.status).toBe("declared");
  expect(calls).toEqual([
    recordPath,
    "/app/hello/pkg/neutron.json",
  ]);
  expect(calls).not.toContain(
    `/app/hello/pkg/${NEUTRON_APP_SOURCE_SNAPSHOT_PATH}`,
  );
  expect(calls).not.toContain(
    "/app/hello/pkg/legal/LICENSE.GPL-3.0.txt",
  );
});

test("a present malformed or mismatched record fails visibly without hiding other apps", async () => {
  const hello = installedFixture("hello", 100);
  const brokenBase = installedPackageAssetBasePath("broken_app");
  const assets: Record<string, Uint8Array> = {
    ...hello.assets,
    [`${brokenBase}${NEUTRON_PACKAGE_RECORD_PATH}`]: encode(
      '{"format":1,"unexpected":true}',
    ),
  };
  const inventory = await loadInstalledPackageRecordInventory(
    {
      hello: registryApp({ id: "hello", name: "Hello", version: 100 }),
      broken_app: registryApp({
        id: "broken_app",
        name: "Broken",
        version: 100,
      }),
    },
    async (path) => assets[path],
  );

  expect(inventory.hello?.status).toBe("declared");
  expect(inventory.broken_app?.status).toBe("invalid");
  if (inventory.broken_app?.status !== "invalid") {
    throw new Error("expected invalid record");
  }
  expect(inventory.broken_app.message).toContain(
    "legal/package-record.v1.json",
  );
});

test("installed inspection rejects a record whose manifest digest no longer matches", async () => {
  const fixture = installedFixture();
  fixture.assets["/app/hello/pkg/neutron.json"] = encode(
    JSON.stringify({
      format: 3,
      id: "hello",
      name: "Jello",
      version: 100,
      entry: "a".repeat(64),
    }),
  );

  const inspection = await loadInstalledPackageRecord(
    { id: "hello", version: 100 },
    async (path) => fixture.assets[path],
  );

  expect(inspection.status).toBe("invalid");
  if (inspection.status !== "invalid") throw new Error("expected invalid");
  expect(inspection.message).toContain("package.manifest.sha256");
});

test("record transport failures remain distinct from malformed installed data", async () => {
  const inspection = await loadInstalledPackageRecord(
    { id: "kernel", version: 306 },
    async () => {
      throw new Error("gateway is offline");
    },
  );

  expect(inspection).toEqual({
    status: "unavailable",
    recordPath: "/pkg/legal/package-record.v1.json",
    message: "gateway is offline",
  });
});

test("explicit installed-asset downloads verify bytes before creating and always revoke the Blob URL", async () => {
  const content = encode("verified notice bytes");
  const file = embeddedRef("legal/NOTICE.txt", content);
  const events: string[] = [];
  const environment: InstalledPackageDownloadEnvironment = {
    createObjectUrl(value) {
      events.push(`create:${hashContent(value)}`);
      return "blob:verified";
    },
    triggerDownload(url, filename) {
      events.push(`download:${url}:${filename}`);
    },
    revokeObjectUrl(url) {
      events.push(`revoke:${url}`);
    },
  };

  await downloadAndVerifyInstalledPackageFile({
    assetBasePath: "/app/hello/pkg/",
    file,
    readAsset: async (path, maximumBytes) => {
      events.push(`read:${path}:${maximumBytes}`);
      return content;
    },
    environment,
  });

  expect(events).toEqual([
    `read:/app/hello/pkg/legal/NOTICE.txt:${file.bytes}`,
    `create:${file.sha256}`,
    "download:blob:verified:NOTICE.txt",
    "revoke:blob:verified",
  ]);

  events.length = 0;
  await expect(
    downloadAndVerifyInstalledPackageFile({
      assetBasePath: "/app/hello/pkg/",
      file,
      readAsset: async () => new Uint8Array(content.byteLength),
      environment,
    }),
  ).rejects.toThrow(/SHA-256 does not match/);
  expect(events).toEqual([]);
});

test("HTTPS source download is user-initiated, bounded, and digest verified before download", async () => {
  const content = encode("deterministic gzip source bytes");
  const source = {
    kind: "https" as const,
    revision: "release-1",
    url: "https://source.example/repo/v1/sources/source.msgpack.gz",
    sha256: hashContent(content),
    bytes: content.byteLength,
  };
  const events: string[] = [];
  const environment: InstalledPackageDownloadEnvironment = {
    createObjectUrl(value) {
      events.push(`create:${hashContent(value)}`);
      return "blob:source";
    },
    triggerDownload(url, filename) {
      events.push(`download:${url}:${filename}`);
    },
    revokeObjectUrl(url) {
      events.push(`revoke:${url}`);
    },
  };
  const fetchSource = async (input: RequestInfo | URL, init?: RequestInit) => {
    events.push(`fetch:${String(input)}`);
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "GET",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(new Headers(init?.headers).get("accept")).toContain(
      "application/gzip",
    );
    return new Response(content.slice().buffer, {
      headers: {
        "content-length": String(content.byteLength),
        "content-type": "application/gzip",
      },
    });
  };

  await downloadAndVerifyHttpsSourceOffer({
    environment,
    fetch: fetchSource,
    source,
  });

  expect(events).toEqual([
    `fetch:${source.url}`,
    `create:${source.sha256}`,
    `download:blob:source:${neutronAppSourceArchiveFilename(source.sha256)}`,
    "revoke:blob:source",
  ]);
});

test("HTTPS source verification fails closed on changed bytes and transport encoding", async () => {
  const content = encode("expected source bytes");
  const source = {
    kind: "https" as const,
    revision: "release-1",
    url: "https://source.example/repo/v1/sources/source.msgpack.gz",
    sha256: hashContent(content),
    bytes: content.byteLength,
  };

  await expect(
    fetchAndVerifyHttpsSourceOffer(source, {
      fetch: async () =>
        new Response(new Uint8Array(content.byteLength).buffer),
    }),
  ).rejects.toThrow("SHA-256 does not match");

  await expect(
    fetchAndVerifyHttpsSourceOffer(source, {
      fetch: async () =>
        new Response(content.slice().buffer, {
          headers: { "content-encoding": "gzip" },
        }),
    }),
  ).rejects.toThrow("without HTTP content encoding");

  const redirected = new Response(content.slice().buffer);
  Object.defineProperty(redirected, "redirected", { value: true });
  await expect(
    fetchAndVerifyHttpsSourceOffer(source, {
      fetch: async () => redirected,
    }),
  ).rejects.toThrow("source offer redirected");
});

test("HTTPS source verification rejects unsafe URLs and oversized offers before fetching", async () => {
  let fetches = 0;
  const fetchSource = async () => {
    fetches += 1;
    return new Response("unused");
  };
  const base = {
    kind: "https" as const,
    revision: "release-1",
    sha256: "a".repeat(64),
    bytes: 1,
  };

  await expect(
    fetchAndVerifyHttpsSourceOffer(
      { ...base, url: "https://source.example/file.gz?token=secret" },
      { fetch: fetchSource },
    ),
  ).rejects.toThrow("without credentials, query, or fragment");

  await expect(
    fetchAndVerifyHttpsSourceOffer(
      {
        ...base,
        url: "https://source.example/file.gz",
        bytes: HTTPS_SOURCE_BROWSER_DOWNLOAD_MAX_BYTES + 1,
      },
      { fetch: fetchSource },
    ),
  ).rejects.toThrow("17 MiB");
  expect(fetches).toBe(0);
});

test("the package-only source snapshot cannot be fetched as an installed asset", async () => {
  const calls: string[] = [];

  await expect(
    fetchAndVerifyInstalledPackageFile(
      "/app/hello/pkg/",
      {
        path: NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
        sha256: "a".repeat(64),
        bytes: 100,
      },
      async (path) => {
        calls.push(path);
        return undefined;
      },
    ),
  ).rejects.toThrow(
    "retained only in the original package archive and is not installed as a public asset",
  );
  expect(calls).toEqual([]);
});

test("archive-only legal materials cannot be fetched as installed assets", async () => {
  const calls: string[] = [];
  const path = `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}LICENSE.APP.txt`;

  await expect(
    fetchAndVerifyInstalledPackageFile(
      "/app/hello/pkg/",
      { path, sha256: "a".repeat(64), bytes: 100 },
      async (installedPath) => {
        calls.push(installedPath);
        return undefined;
      },
    ),
  ).rejects.toThrow(
    "retained only in the original package archive and is not installed as a public asset",
  );
  expect(calls).toEqual([]);
});

test("Blob URLs are revoked even when the browser download trigger fails", async () => {
  const content = encode("license bytes");
  const events: string[] = [];
  const environment: InstalledPackageDownloadEnvironment = {
    createObjectUrl() {
      events.push("create");
      return "blob:license";
    },
    triggerDownload() {
      events.push("trigger");
      throw new Error("download blocked");
    },
    revokeObjectUrl() {
      events.push("revoke");
    },
  };

  await expect(
    downloadAndVerifyInstalledPackageFile({
      assetBasePath: "/pkg/",
      file: embeddedRef("legal/LICENSE.txt", content),
      readAsset: async () => content,
      environment,
    }),
  ).rejects.toThrow("download blocked");
  expect(events).toEqual(["create", "trigger", "revoke"]);
});

test("the default embedded reader stops an oversized response stream at the declared bound", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  try {
    await expect(
      fetchAndVerifyInstalledPackageFile("/pkg/", {
        path: "legal/LICENSE.txt",
        sha256: "0".repeat(64),
        bytes: 3,
      }),
    ).rejects.toThrow("exceeds the 3-byte read limit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function embeddedRef(path: string, content: Uint8Array) {
  return { path, sha256: hashContent(content), bytes: content.byteLength };
}
