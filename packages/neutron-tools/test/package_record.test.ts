import { expect, test } from "bun:test";
import { hashContent } from "../src/hash.ts";
import {
  assertNeutronPackageRecordManifestContext,
  discoverNeutronPackageRecordEmbeddedPaths,
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_APP_SOURCE_MEDIA_TYPE,
  NEUTRON_APP_SOURCE_TRANSPORT_LIMITS,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  NEUTRON_PACKAGE_RECORD_LIMITS,
  NEUTRON_PACKAGE_RECORD_PATH,
  PACKAGE_INFORMATION_RECORD_PATH,
  neutronAppSourceArchiveFilename,
  neutronAppSourceHttpsUrl,
  neutronAppSourceRepositoryPath,
  parseNeutronPackageRecord,
  parseNeutronPackageRecordStructure,
  readNeutronPackageRecord,
} from "../src/package_record.ts";
import type { PackagedNeutronManifest } from "../src/schema.ts";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

test("builds one canonical content-addressed HTTPS source location", () => {
  const digest = "a".repeat(64);
  const filename = `${digest}.source.v1.msgpack.gz`;

  expect(neutronAppSourceArchiveFilename(digest)).toBe(filename);
  expect(neutronAppSourceRepositoryPath(digest)).toBe(
    `/repo/v1/sources/${filename}`,
  );
  expect(neutronAppSourceHttpsUrl("https://sources.example", digest)).toBe(
    `https://sources.example/repo/v1/sources/${filename}`,
  );
  expect(NEUTRON_APP_SOURCE_TRANSPORT_LIMITS.compressedBytes).toBe(
    17 * 1024 * 1024,
  );
  expect(NEUTRON_APP_SOURCE_MEDIA_TYPE).toBe("application/gzip");
});

test("source-location helpers reject ambiguous origins and digests", () => {
  for (const digest of ["A".repeat(64), "a".repeat(63), ` ${"a".repeat(64)}`]) {
    expect(() => neutronAppSourceArchiveFilename(digest)).toThrow(
      "lowercase SHA-256 digest",
    );
  }

  const digest = "a".repeat(64);
  for (const origin of [
    "http://sources.example",
    "https://user@sources.example",
    "https://sources.example/releases",
    "https://sources.example?mirror=one",
    "https://sources.example#latest",
  ]) {
    expect(() => neutronAppSourceHttpsUrl(origin, digest)).toThrow(
      "must be an HTTPS origin",
    );
  }
});

type MutableRecord = {
  format: number;
  features?: string[];
  package: {
    id: string;
    version: number;
    manifest: { path: string; sha256: string; bytes: number };
  };
  license: {
    id: string;
    texts: Array<{
      id: string;
      path: string;
      sha256: string;
      bytes: number;
    }>;
  };
  source:
    | {
        kind: "embedded";
        revision: string;
        path: string;
        sha256: string;
        bytes: number;
      }
    | {
        kind: "https";
        revision: string;
        url: string;
        sha256: string;
        bytes: number;
      }
    | {
        kind: "status";
        status: "not-provided" | "not-required" | "unknown";
      };
  dependencies: Array<{
    alias: string;
    app: string;
    min_version: number;
    functions: string[];
  }>;
  notices: Array<{ path: string; sha256: string; bytes: number }>;
  memory: { lock: { path: string; sha256: string; bytes: number } } | null;
  build: {
    inputs: Array<{ path: string; sha256: string; bytes: number }>;
    commands: Array<{ purpose: string; cwd: string; argv: string[] }>;
  };
};

function embeddedRef(path: string, content: Uint8Array) {
  return { path, sha256: hashContent(content), bytes: content.byteLength };
}

function fixture(): {
  files: Record<string, Uint8Array>;
  manifest: PackagedNeutronManifest;
  record: MutableRecord;
} {
  const manifest: PackagedNeutronManifest = {
    format: 3,
    id: "hello",
    name: "Hello",
    version: 100,
    entry: "a".repeat(64),
    dependencies: {
      contacts: {
        app: "contacts",
        min_version: 100,
        functions: ["lookup", "add"],
      },
    },
    memory: {
      state: {
        version: 1,
        schemas: {
          "1": { entry: "b".repeat(64), hash: "c".repeat(64) },
        },
      },
    },
  };
  const manifestBytes = encode(JSON.stringify(manifest));
  const licenseBytes = encode("Example License\n");
  const companionLicenseBytes = encode("Required System License\n");
  const noticeBytes = encode("Third-party notices\n");
  const sourceBytes = encode("exact compressed source archive bytes");
  const lockBytes = encode(
    JSON.stringify({ format: 2, app: "hello", memory: {} }),
  );
  const files: Record<string, Uint8Array> = {
    "neutron.json": manifestBytes,
    "neutron.lock.json": lockBytes,
    "legal/LICENSE.APP.txt": licenseBytes,
    "legal/LICENSE.NPL.txt": companionLicenseBytes,
    "legal/THIRD-PARTY-NOTICES.txt": noticeBytes,
    [NEUTRON_APP_SOURCE_SNAPSHOT_PATH]: sourceBytes,
  };
  const record: MutableRecord = {
    format: 1,
    features: [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE],
    package: {
      id: "hello",
      version: 100,
      manifest: embeddedRef("neutron.json", manifestBytes),
    },
    license: {
      id: "LicenseRef-Neutron-Sovereign-Application-License-1.0",
      texts: [
        {
          id: "LicenseRef-Neutron-Sovereign-Application-License-1.0",
          ...embeddedRef("legal/LICENSE.APP.txt", licenseBytes),
        },
        {
          id: "LicenseRef-Neutron-Public-License-1.0",
          ...embeddedRef("legal/LICENSE.NPL.txt", companionLicenseBytes),
        },
      ],
    },
    source: {
      kind: "embedded",
      revision: "git:0123456789abcdef",
      ...embeddedRef(NEUTRON_APP_SOURCE_SNAPSHOT_PATH, sourceBytes),
    },
    dependencies: [
      {
        alias: "contacts",
        app: "contacts",
        min_version: 100,
        functions: ["add", "lookup"],
      },
    ],
    notices: [embeddedRef("legal/THIRD-PARTY-NOTICES.txt", noticeBytes)],
    memory: { lock: embeddedRef("neutron.lock.json", lockBytes) },
    build: {
      inputs: [
        {
          path: "neutron.json",
          sha256: "d".repeat(64),
          bytes: 200,
        },
        {
          path: "package-lock.json",
          sha256: "e".repeat(64),
          bytes: 300,
        },
      ],
      commands: [
        {
          purpose: "package",
          cwd: ".",
          argv: ["npm", "--workspace", "neutron-hello", "run", "package"],
        },
      ],
    },
  };
  writeRecord(files, record);
  return { files, manifest, record };
}

function writeRecord(
  files: Record<string, Uint8Array>,
  record: MutableRecord,
): void {
  files[NEUTRON_PACKAGE_RECORD_PATH] = encode(JSON.stringify(record));
}

test("reads and freezes a complete digest-bound package record", () => {
  expect(PACKAGE_INFORMATION_RECORD_PATH).toBe(NEUTRON_PACKAGE_RECORD_PATH);
  const { files, manifest } = fixture();
  const parsed = readNeutronPackageRecord({ files, manifest });

  expect(parsed?.package).toEqual({
    id: "hello",
    version: 100,
    manifest: embeddedRef("neutron.json", files["neutron.json"]!),
  });
  expect(parsed?.source.kind).toBe("embedded");
  expect(parsed?.features).toEqual([NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE]);
  expect(parsed?.dependencies[0]?.functions).toEqual(["add", "lookup"]);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed?.license.texts)).toBe(true);
  expect(Object.isFrozen(parsed?.build.commands[0]?.argv)).toBe(true);
});

test("archive-only paths require the closed feature while legacy v1 records remain valid", () => {
  {
    const { files, manifest, record } = fixture();
    delete record.features;
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      `features must include ${NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE}`,
    );
  }

  {
    const { files, manifest, record } = fixture();
    record.source = { kind: "status", status: "not-provided" };
    record.license.texts[0]!.path = "legal/LICENSE.APP.txt";
    record.license.texts[1]!.path = "legal/LICENSE.NPL.txt";
    record.notices[0]!.path = "legal/THIRD-PARTY-NOTICES.txt";
    delete record.features;
    writeRecord(files, record);
    expect(
      readNeutronPackageRecord({ files, manifest })?.features,
    ).toBeUndefined();
  }
});

test("features reject unknown, repeated, and noncanonical declarations", () => {
  {
    const { files, manifest, record } = fixture();
    record.features = ["unknown-feature"];
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      "features[0] is unknown",
    );
  }
  {
    const { files, manifest, record } = fixture();
    record.features = [
      NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
      NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
    ];
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      "features must be unique and canonically ordered",
    );
  }
});

test("the record feature is an intentional v0.3.7 defense-in-depth rejection", () => {
  const { record } = fixture();
  const v307Fields = new Set([
    "build",
    "dependencies",
    "format",
    "license",
    "memory",
    "notices",
    "package",
    "source",
  ]);
  expect(Object.keys(record).filter((key) => !v307Fields.has(key))).toEqual([
    "features",
  ]);
});

test("discovers only bounded embedded paths before installed assets are fetched", () => {
  const { files } = fixture();
  const content = files[NEUTRON_PACKAGE_RECORD_PATH]!;

  expect(discoverNeutronPackageRecordEmbeddedPaths(content)).toEqual([
    "neutron.json",
    "legal/LICENSE.APP.txt",
    "legal/LICENSE.NPL.txt",
    NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
    "legal/THIRD-PARTY-NOTICES.txt",
    "neutron.lock.json",
  ]);
  expect(
    discoverNeutronPackageRecordEmbeddedPaths(content, {
      include: ["manifest", "license"],
    }),
  ).toEqual([
    "neutron.json",
    "legal/LICENSE.APP.txt",
    "legal/LICENSE.NPL.txt",
  ]);

  const parsed = JSON.parse(new TextDecoder().decode(content));
  parsed.source = {
    kind: "https",
    revision: "release-1",
    url: "https://source.example/hello-v1.tar.gz",
    sha256: "f".repeat(64),
    bytes: 500,
  };
  expect(
    discoverNeutronPackageRecordEmbeddedPaths(encode(JSON.stringify(parsed))),
  ).not.toContain("https://source.example/hello-v1.tar.gz");
});

test("missing records remain explicitly optional for legacy packages", () => {
  const { files, manifest } = fixture();
  delete files[NEUTRON_PACKAGE_RECORD_PATH];
  expect(readNeutronPackageRecord({ files, manifest })).toBeUndefined();
});

test("accepts clean HTTPS offers and explicit source availability status", () => {
  const httpsFixture = fixture();
  httpsFixture.record.source = {
    kind: "https",
    revision: "release-1",
    url: "https://source.example/releases/hello-v1.tar.gz",
    sha256: "f".repeat(64),
    bytes: 500,
  };
  delete httpsFixture.record.features;
  delete httpsFixture.files[NEUTRON_APP_SOURCE_SNAPSHOT_PATH];
  writeRecord(httpsFixture.files, httpsFixture.record);
  expect(
    readNeutronPackageRecord({
      files: httpsFixture.files,
      manifest: httpsFixture.manifest,
    })?.source,
  ).toEqual(httpsFixture.record.source);
  expect(
    readNeutronPackageRecord({
      files: httpsFixture.files,
      manifest: httpsFixture.manifest,
    })?.features,
  ).toBeUndefined();

  const statusFixture = fixture();
  statusFixture.record.source = {
    kind: "status",
    status: "not-provided",
  };
  statusFixture.record.build = { inputs: [], commands: [] };
  writeRecord(statusFixture.files, statusFixture.record);
  expect(
    readNeutronPackageRecord({
      files: statusFixture.files,
      manifest: statusFixture.manifest,
    })?.source,
  ).toEqual({ kind: "status", status: "not-provided" });

  const unknownFixture = fixture();
  unknownFixture.record.source = { kind: "status", status: "unknown" };
  writeRecord(unknownFixture.files, unknownFixture.record);
  expect(
    readNeutronPackageRecord({
      files: unknownFixture.files,
      manifest: unknownFixture.manifest,
    })?.source,
  ).toEqual({ kind: "status", status: "unknown" });
});

test("reserves one exact archive path for an embedded source snapshot", () => {
  const { files, manifest, record } = fixture();
  if (record.source.kind !== "embedded") throw new Error("fixture source");
  record.source.path = "legal/source/other.msgpack";
  writeRecord(files, record);

  expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
    `source.path must be ${NEUTRON_APP_SOURCE_SNAPSHOT_PATH}`,
  );
});

test("structural inspection defers large payloads but verifies manifest context", () => {
  const { files, manifest } = fixture();
  const content = files[NEUTRON_PACKAGE_RECORD_PATH]!;
  const structure = parseNeutronPackageRecordStructure(content);
  const manifestOnlyFiles = {
    "neutron.json": files["neutron.json"]!,
  };

  expect(structure.source.kind).toBe("embedded");
  expect(() =>
    assertNeutronPackageRecordManifestContext(structure, {
      files: manifestOnlyFiles,
      manifest,
    }),
  ).not.toThrow();

  manifestOnlyFiles["neutron.json"] = encode("tampered manifest");
  expect(() =>
    assertNeutronPackageRecordManifestContext(structure, {
      files: manifestOnlyFiles,
      manifest,
    }),
  ).toThrow(/package\.manifest.*does not match|byte length/);
});

test("rejects non-durable or credential-bearing source URLs", () => {
  for (const url of [
    "http://source.example/hello.tar.gz",
    "https://user:secret@source.example/hello.tar.gz",
    "https://source.example/hello.tar.gz?token=secret",
    "https://source.example/hello.tar.gz#digest",
  ]) {
    const { files, manifest, record } = fixture();
    record.source = {
      kind: "https",
      revision: "release-1",
      url,
      sha256: "f".repeat(64),
      bytes: 500,
    };
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /HTTPS URL without credentials, query, or fragment/,
    );
  }
});

test("keeps anonymously readable metadata free of private deployment inputs", () => {
  {
    const { files, manifest, record } = fixture();
    if (record.source.kind !== "embedded") throw new Error("fixture source");
    record.source.revision = "Bearer abcdefghijklmnop";
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /credentials or private material/,
    );
  }

  for (const argument of [
    "/home/alice/neutron",
    "C:\\Users\\alice\\neutron",
    "--token",
    "--controller=aaaaa-aa",
    "aaaaa-aa",
    "password=hunter2",
  ]) {
    const { files, manifest, record } = fixture();
    record.build.commands[0]!.argv = ["npm", argument];
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /machine-local absolute path|deployment authority or identity|credentials or private material/,
    );
  }
});

test("cross-checks package identity, dependencies, and memory declarations", () => {
  {
    const { files, manifest, record } = fixture();
    record.package.id = "other";
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /package\.id other does not match/,
    );
  }
  {
    const { files, manifest, record } = fixture();
    record.package.version = 101;
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /package\.version 101 does not match/,
    );
  }
  {
    const { files, manifest, record } = fixture();
    record.dependencies[0]!.app = "wallet";
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /dependencies do not match neutron\.json/,
    );
  }
  {
    const { files, manifest, record } = fixture();
    record.memory = null;
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /must bind neutron\.lock\.json/,
    );
  }
  {
    const { files, manifest, record } = fixture();
    delete manifest.memory;
    record.memory = { lock: embeddedRef("neutron.lock.json", files["neutron.lock.json"]!) };
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /memory must be null/,
    );
  }
});

test("fails closed for every tampered embedded byte reference", () => {
  for (const path of [
    "neutron.json",
    "legal/LICENSE.APP.txt",
    NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
    "legal/THIRD-PARTY-NOTICES.txt",
    "neutron.lock.json",
  ]) {
    const { files, manifest } = fixture();
    files[path] = encode(`tampered ${path}`);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      new RegExp(`does not match|byte length`),
    );
  }
});

test("rejects missing embedded files and ambiguous or escaping paths", () => {
  {
    const { files, manifest } = fixture();
    delete files["legal/LICENSE.APP.txt"];
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /is missing from the package/,
    );
  }
  for (const path of [
    "../LICENSE",
    "/legal/LICENSE",
    "legal/LICENSE?raw=1",
    "legal/LICENSE#fragment",
    "legal/%2e%2e/LICENSE",
    NEUTRON_PACKAGE_RECORD_PATH,
  ]) {
    const { files, manifest, record } = fixture();
    record.license.texts[0]!.path = path;
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /Unsafe|HTTP-ambiguous|cannot reference|must be under/,
    );
  }
});

test("rejects unknown and duplicate JSON fields", () => {
  {
    const { files, manifest, record } = fixture();
    const withUnknown = { ...record, target_canister: "secret" };
    files[NEUTRON_PACKAGE_RECORD_PATH] = encode(JSON.stringify(withUnknown));
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /unknown field target_canister/,
    );
  }
  {
    const { files, manifest } = fixture();
    const text = new TextDecoder().decode(files[NEUTRON_PACKAGE_RECORD_PATH]!);
    files[NEUTRON_PACKAGE_RECORD_PATH] = encode(
      text.replace('"format":1', '"format":1,"format":1'),
    );
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /duplicate JSON field format/,
    );
  }
});

test("enforces record, list, text, digest, and declared-size bounds", () => {
  {
    const { files, manifest } = fixture();
    files[NEUTRON_PACKAGE_RECORD_PATH] = new Uint8Array(
      NEUTRON_PACKAGE_RECORD_LIMITS.jsonBytes + 1,
    );
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /byte limit/,
    );
  }
  {
    const { files, manifest, record } = fixture();
    record.license.texts[0]!.sha256 = "A".repeat(64);
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /lowercase SHA-256/,
    );
  }
  {
    const { files, manifest, record } = fixture();
    record.notices = Array.from(
      { length: NEUTRON_PACKAGE_RECORD_LIMITS.notices + 1 },
      () => embeddedRef(
        "legal/THIRD-PARTY-NOTICES.txt",
        files["legal/THIRD-PARTY-NOTICES.txt"]!,
      ),
    );
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /notices must contain/,
    );
  }
  {
    const { files, manifest, record } = fixture();
    record.build.inputs[0]!.bytes =
      NEUTRON_PACKAGE_RECORD_LIMITS.declaredSourceBytes + 1;
    writeRecord(files, record);
    expect(() => readNeutronPackageRecord({ files, manifest })).toThrow(
      /build\.inputs\[0\]\.bytes must be an integer/,
    );
  }
});

test("parse errors consistently identify the fixed package-record path", () => {
  const { files, manifest } = fixture();
  const malformed = encode("{");
  files[NEUTRON_PACKAGE_RECORD_PATH] = malformed;
  expect(() => parseNeutronPackageRecord(malformed, { files, manifest })).toThrow(
    `Invalid ${NEUTRON_PACKAGE_RECORD_PATH}:`,
  );
});
