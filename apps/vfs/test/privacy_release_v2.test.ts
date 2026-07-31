import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { parse } from "acorn";
import { transform } from "esbuild";
import {
  NEUTRON_TOOL_AUDIT_METADATA_ONLY,
} from "neutron-tools/app";
import type { FilesResidentFilePort } from "../src/resident/service_contract.ts";
import { parseCanonicalNat64 } from "../src/protocol/ids.ts";
import {
  deriveVaultKeys,
  encryptMetadata,
  vaultContext,
} from "../src/crypto/index.ts";
import {
  classifyFilesWorkerError,
} from "../src/crypto/worker_runtime.ts";
// @ts-ignore service.ts is dual-compiled by tsconfig.app.json while tests
// exercise its registration surface from tsconfig.scripts.json.
import { installFilesV2Tools, type FilesToolExposure } from "../src/service.ts";
import {
  filesReleaseSourcePaths,
} from "../scripts/release.ts";

const FILES_ROOT = new URL("../", import.meta.url);
const VAULT_SENTINEL =
  "NEUTRON_FILES_VAULT_SENTINEL_9F4B2C7D1A6E";

type UnknownRecord = Record<string, unknown>;

type CapturedTool = Readonly<{
  name: string;
  attachment: boolean;
  options: UnknownRecord;
  invoke: (...args: unknown[]) => unknown;
}>;

type CandidType =
  | Readonly<{ kind: "atom"; name: string }>
  | Readonly<{
      kind: "unary";
      operator: "opt" | "vec";
      value: CandidType;
    }>
  | Readonly<{
      kind: "aggregate";
      aggregate: "record" | "variant";
      fields: readonly Readonly<{
        name: string;
        value: CandidType | null;
      }>[];
    }>;

type LexToken = Readonly<{
  kind: "atom" | "string" | "symbol";
  value: string;
  line: number;
}>;

type AuditedTimerInventory = Readonly<{
  setTimeout: number;
  clearTimeout: number;
  maximumDelayMs: number;
  rationale: string;
  authorityCleanup: string;
}>;

const AUDITED_TIMER_IDENTIFIERS: ReadonlyMap<
  string,
  AuditedTimerInventory
> = new Map<string, AuditedTimerInventory>([
  [
    "src/crypto/worker_client.ts",
    Object.freeze({
      setTimeout: 1,
      clearTimeout: 3,
      maximumDelayMs: 120_000,
      rationale:
        "One deadline bounds each worker request; every response, post failure, or client stop clears it.",
      authorityCleanup:
        "A timeout terminates the worker and rejects all pending calls, so late key or plaintext results cannot cross the fence.",
    }),
  ],
  [
    "src/crypto/worker_runtime.ts",
    Object.freeze({
      setTimeout: 1,
      clearTimeout: 1,
      maximumDelayMs: 60 * 60_000,
      rationale:
        "One re-armed deadline expires unlock challenges and inactive in-worker key material.",
      authorityCleanup:
        "Reconfiguration, lock, and reset cancel the prior deadline while synchronously wiping volatile keys and retry frames.",
    }),
  ],
  [
    "src/index.tsx",
    Object.freeze({
      setTimeout: 7,
      clearTimeout: 5,
      maximumDelayMs: 2_500,
      rationale:
        "One-shot timers cover query-only message-bus reconnect, delayed busy UI, transfer dismissal, copy feedback, abortable upload polling, and download cleanup.",
      authorityCleanup:
        "Effect and abortable timers clear on teardown; remaining bounded callbacks recheck the mounted authority generation before state or client work.",
    }),
  ],
  [
    "src/resident/blob_urls.ts",
    Object.freeze({
      setTimeout: 1,
      clearTimeout: 1,
      maximumDelayMs: 10 * 60_000,
      rationale:
        "Delayed Blob URL revocation gives the browser a bounded download handoff window.",
      authorityCleanup:
        "Authority teardown calls revokeAll, which clears every timer and synchronously revokes every private Blob URL.",
    }),
  ],
  [
    "src/resident/plain_port.ts",
    Object.freeze({
      setTimeout: 2,
      clearTimeout: 1,
      maximumDelayMs: 120_000,
      rationale:
        "A zero-delay one-shot yields the attachment handler, while one bounded inactivity deadline prevents abandoned plain uploads retaining resident bytes.",
      authorityCleanup:
        "The yield captures only its resolver; the inactivity callback is epoch- and identity-bound, and cancel or authority clear disarms it and wipes deferred bytes.",
    }),
  ],
  [
    "src/resident/reconciliation.ts",
    Object.freeze({
      setTimeout: 1,
      clearTimeout: 1,
      maximumDelayMs: 80_000,
      rationale:
        "A bounded exponential retry wait reconciles at most four ambiguous update attempts.",
      authorityCleanup:
        "The caller signal clears the timer and the abort listener is removed on both cancellation and normal completion.",
    }),
  ],
  [
    "src/resident/tools_runtime.ts",
    Object.freeze({
      setTimeout: 1,
      clearTimeout: 2,
      maximumDelayMs: 300_000,
      rationale:
        "One identity-bound inactivity deadline retains verified download bytes or a final replay chunk only for a bounded window.",
      authorityCleanup:
        "Cancel, lock, authority clear, and re-arm clear the deadline and wipe bytes; the callback can drop only its exact stage object.",
    }),
  ],
  [
    "src/vault/transfer_engine.ts",
    Object.freeze({
      setTimeout: 1,
      clearTimeout: 1,
      maximumDelayMs: 200,
      rationale:
        "A bounded retry delay backs off the three-attempt private write reconciliation loop.",
      authorityCleanup:
        "Vault lock and disposal abort the operation signal; abort clears the timer and both completion paths remove the listener.",
    }),
  ],
]);

const FORBIDDEN_BACKGROUND_TIMERS = new Set([
  "cancelIdleCallback",
  "clearInterval",
  "requestIdleCallback",
  "setInterval",
]);

test("production Files authority has persistent storage without background polling", async () => {
  const sourcePaths = await sourceFiles("src");
  const findings: string[] = [];
  const timerCounts = new Map<
    string,
    { setTimeout: number; clearTimeout: number }
  >();

  for (const path of sourcePaths) {
    const source = await readFile(new URL(path, FILES_ROOT), "utf8");
    const compiled = await transform(source, {
      format: "esm",
      jsx: "automatic",
      loader: extname(path) === ".tsx" ? "tsx" : "ts",
      sourcefile: path,
      target: "es2022",
    });
    const ast = parse(compiled.code, {
      ecmaVersion: "latest",
      locations: true,
      sourceType: "module",
    }) as unknown as UnknownRecord;
    const counts = { setTimeout: 0, clearTimeout: 0 };

    walkAst(ast, (node) => {
      const type = stringField(node, "type");
      if (type === "Identifier") {
        const name = stringField(node, "name");
        if (FORBIDDEN_BACKGROUND_TIMERS.has(name)) {
          findings.push(`${path}:${nodeLine(node)} references ${name}`);
        }
        if (name === "setTimeout") counts.setTimeout += 1;
        if (name === "clearTimeout") counts.clearTimeout += 1;
        if (name === "console") {
          findings.push(
            `${path}:${nodeLine(node)} exposes a production console sink`,
          );
        }
      }
    });
    if (counts.setTimeout > 0 || counts.clearTimeout > 0) {
      timerCounts.set(path, counts);
    }
  }

  expect(findings).toEqual([]);
  const expectedTimerCounts = Object.fromEntries(
    [...AUDITED_TIMER_IDENTIFIERS].map(
      ([path, audit]) => [
        path,
        {
          setTimeout: audit.setTimeout,
          clearTimeout: audit.clearTimeout,
        },
      ],
    ),
  );
  expect(Object.fromEntries(timerCounts)).toEqual(
    expectedTimerCounts,
  );
  for (const [path, audit] of AUDITED_TIMER_IDENTIFIERS) {
    expect(
      Number.isSafeInteger(audit.maximumDelayMs) &&
        audit.maximumDelayMs >= 0,
      `${path} must document a finite maximum timer delay`,
    ).toBe(true);
    expect(
      audit.rationale.length > 24,
      `${path} must document why its timer exists`,
    ).toBe(true);
    expect(
      audit.authorityCleanup.length > 24,
      `${path} must document its authority cleanup`,
    ).toBe(true);
  }

  const manifest = JSON.parse(
    await readFile(new URL("neutron.json", FILES_ROOT), "utf8"),
  ) as UnknownRecord;
  const capabilities = requireRecord(manifest.capabilities, "capabilities");
  expect(
    requireRecord(
      capabilities.persistent_browser_storage,
      "persistent_browser_storage",
    ),
  ).toMatchObject({
    api: 1,
    surface: "background",
  });
  expect(
    Object.prototype.hasOwnProperty.call(
      capabilities,
      "dedicated_resident_origin",
    ),
  ).toBe(false);
});

test("persistent Vault recovery remains worker-only and commitment-gated", async () => {
  const [worker, engine] = await Promise.all([
    readFile(
      new URL("src/crypto/worker_runtime.ts", FILES_ROOT),
      "utf8",
    ),
    readFile(
      new URL("src/vault/vault_engine.ts", FILES_ROOT),
      "utf8",
    ),
  ]);
  const cacheUsers: string[] = [];
  for (const path of await sourceFiles("src")) {
    const source = await readFile(new URL(path, FILES_ROOT), "utf8");
    if (source.includes("createBrowserSecretCache")) cacheUsers.push(path);
  }
  expect(cacheUsers).toEqual(["src/crypto/worker_runtime.ts"]);
  expect(worker).toContain("BROWSER_SECRET_CACHE_MAX_TTL_MS");
  expect(worker).toContain("secret: root");
  expect(worker).toContain("root.byteLength !== FILES_VAULT_ROOT_BYTES");
  expect(worker).toContain("this.#clearVaultCacheCandidate()");

  const restore = sourceMethod(
    worker,
    "async #restoreCachedVault(",
    "async #commitVaultCache(",
  );
  expect(restore.indexOf("verifyRootCommitment(")).toBeGreaterThan(-1);
  expect(restore.indexOf("deriveVaultKeys(")).toBeGreaterThan(
    restore.indexOf("verifyRootCommitment("),
  );
  const unlock = sourceMethod(
    engine,
    "async #unlockRecordWithLock(",
    "async #recordFromBootstrap(",
  );
  expect(unlock.indexOf("this.#configureBindings(")).toBeGreaterThan(-1);
  expect(unlock.indexOf('type: "begin_unlock"')).toBeGreaterThan(-1);
  expect(unlock.indexOf('type: "begin_unlock"')).toBeGreaterThan(
    unlock.indexOf("this.#configureBindings("),
  );
  expect(unlock.indexOf("this.#vetkeys.derive(")).toBeGreaterThan(
    unlock.indexOf('type: "begin_unlock"'),
  );
  const configure = sourceMethod(
    engine,
    "async #configureBindings(",
    "async #ensureInitializationBindings(",
  );
  expect(configure.indexOf('type: "load_cached_public_info"'))
    .toBeGreaterThan(-1);
  expect(configure.indexOf("this.#vetkeys.publicKey(")).toBeGreaterThan(
    configure.indexOf('type: "load_cached_public_info"'),
  );
  expect(engine).toContain('type: "commit_vault_cache"');
  expect(engine).toContain("withNativeFilesVaultUnlockLock");
});

test("Vault Candid keeps encrypted envelopes in Blob fields while tool audit remains metadata-only", async () => {
  const [did, abiText] = await Promise.all([
    readFile(new URL("candid/files-v2.did", FILES_ROOT), "utf8"),
    readFile(new URL("candid/files-v2.abi.json", FILES_ROOT), "utf8"),
  ]);
  const definitions = new CandidParser(lexSource(did)).parseTypes();
  const leaves = collectCandidLeaves(definitions);

  expect(leaves.blob.sort()).toEqual([
    "FilesBootstrapOutputV2.body",
    "FilesListOutputV2.body",
    "FilesLookupOutputV2.body",
    "FilesLookupRequestV2.body",
    "FilesMutateRequestV2.body",
    "FilesReadChunkOutputV2.body",
    "FilesVaultWriteRequestV2.body",
    "FilesWriteBlockRequestV2.body",
  ]);
  expect(leaves.text).toEqual([]);
  expect(leaves.vecNat8).toEqual([]);
  expect(did).not.toContain("FilesAbortStageKindV2");
  expect(did).not.toContain("FilesShare");
  expect(did).not.toContain("files_share_");

  const abi = JSON.parse(abiText) as {
    reconciliation: {
      abort_target_fields: string[];
    };
    methods: Array<{
      name: string;
      request_type: string;
      result_type: string;
      input_blob: null | { field: string; max_bytes: number };
      output_blob: null | { field: string; max_bytes: number };
    }>;
  };
  expect(abi.reconciliation.abort_target_fields).toEqual([
    "stage_id",
  ]);
  expect(abi.methods).toHaveLength(11);
  expect(abi.methods.some(({ name }) => name.startsWith("files_share_")))
    .toBe(false);
  for (const method of abi.methods) {
    expect(definitions.has(method.request_type), method.name).toBe(true);
    expect(definitions.has(method.result_type), method.name).toBe(true);
    if (method.input_blob !== null) {
      expect(method.input_blob.field, method.name).toBe("body");
      expect(method.input_blob.max_bytes, method.name).toBeGreaterThan(0);
    }
    if (method.output_blob !== null) {
      expect(method.output_blob.field, method.name).toBe("body");
      expect(method.output_blob.max_bytes, method.name).toBeGreaterThan(0);
    }
  }

  const registrations = captureToolRegistrations();
  expect(registrations.map(({ name }) => name).sort()).toEqual([
    "append",
    "files_ui",
    "files_ui_download",
    "files_ui_transfer",
    "list",
    "mkdir",
    "move",
    "patch",
    "read",
    "readBinary",
    "remove",
    "stat",
    "write",
    "writeBinary",
    "writeMany",
  ]);
  expect(
    registrations.filter(({ attachment }) => attachment).map(({ name }) =>
      name
    ).sort(),
  ).toEqual([
    "files_ui_download",
    "files_ui_transfer",
    "readBinary",
    "writeBinary",
  ]);
  for (const registration of registrations) {
    const annotations = requireRecord(
      registration.options.annotations,
      `${registration.name}.annotations`,
    );
    expect(
      annotations["neutron:audit"],
      `${registration.name} must redact all JSON arguments and results`,
    ).toBe(NEUTRON_TOOL_AUDIT_METADATA_ONLY);
  }
});

test("Workspace and Shared Candid intentionally carry plaintext bodies", async () => {
  const did = await readFile(
    new URL("candid/files-plain-v3.did", FILES_ROOT),
    "utf8",
  );
  const definitions = new CandidParser(lexSource(did)).parseTypes();
  const leaves = collectCandidLeaves(definitions);

  expect(leaves.blob.sort()).toEqual([
    "FilesPlainReadChunkOutputV3.body",
    "FilesPlainRemoveRequestV3.delete_nonce",
    "FilesPlainWriteBlockRequestV3.begin_nonce",
    "FilesPlainWriteBlockRequestV3.body",
    "FilesPlainWriteBlockRequestV3.commit_nonce",
    "FilesPlainWriteBlockRequestV3.delete_nonce",
  ]);
  expect(did).toContain(
    "type FilesPlainSpaceV3 = variant { shared_; workspace }",
  );
  expect(did).toContain(
    "Shared bodies live only in the scoped Certified Assets store.",
  );

  const manifest = JSON.parse(
    await readFile(new URL("neutron.json", FILES_ROOT), "utf8"),
  ) as UnknownRecord;
  const capabilities = requireRecord(manifest.capabilities, "capabilities");
  const preapproved = requireRecord(
    capabilities.preapproved_self_calls,
    "preapproved_self_calls",
  );
  const methods = preapproved.methods;
  expect(Array.isArray(methods)).toBe(true);
  expect(methods).toEqual(expect.arrayContaining([
    "files_plain_list_v3",
    "files_plain_stat_v3",
    "files_plain_read_chunk_v3",
    "files_plain_write_block_v3",
    "files_plain_mkdir_v3",
    "files_plain_move_v3",
    "files_plain_remove_v3",
    "files_plain_abort_v3",
    "files_plain_cleanup_v3",
  ]));
});

test("Vault plaintext sentinels stay out of encrypted envelopes, logs, and serialized errors", async () => {
  const plaintext = new TextEncoder().encode(JSON.stringify({
    name: VAULT_SENTINEL,
    mediaType: `text/${VAULT_SENTINEL}`,
    byteLength: VAULT_SENTINEL.length,
  }));
  const context = vaultContext({
    neutronCanisterPrincipalBytes: Uint8Array.of(1, 2, 3, 4),
    vaultId: fixedBytes(16, 0x21),
    vaultSalt: fixedBytes(32, 0x43),
  });
  const keys = await deriveVaultKeys(fixedBytes(32, 0x65), context);
  const ciphertext = await encryptMetadata(
    keys,
    {
      nodeId: { hi: "1", lo: "2" },
      parentId: { hi: "0", lo: "0" },
      nodeKind: "file",
      metadataRevision: "1",
      declaredNameScalars: VAULT_SENTINEL.length,
      nameTag: fixedBytes(32, 0x87),
    },
    plaintext,
  );
  expect(
    containsBytes(ciphertext, new TextEncoder().encode(VAULT_SENTINEL)),
  ).toBe(false);
  const backendEnvelope = JSON.stringify({
    node_id: { hi: "1", lo: "2" },
    parent_id: { hi: "0", lo: "0" },
    kind: "file",
    structural_revision: "1",
    metadata_revision: "1",
    declared_name_scalars: VAULT_SENTINEL.length,
    encrypted_metadata: Buffer.from(ciphertext).toString("base64"),
  });
  expect(backendEnvelope).not.toContain(VAULT_SENTINEL);
  plaintext.fill(0);

  const list = captureToolRegistrations().find(({ name }) => name === "list");
  if (!list) throw new Error("The Files list tool was not registered");
  let toolError: unknown;
  try {
    await list.invoke(
      { path: `/${VAULT_SENTINEL}/../secret.txt` },
      {
        caller: {
          endpoint: "files-test-endpoint",
          sessionId: "files-test-session",
        },
        reportProgress: () => undefined,
      },
    );
  } catch (error) {
    toolError = error;
  }
  expect(toolError).toBeInstanceOf(Error);
  const serializedToolError = serializeError(toolError);
  expect(serializedToolError).not.toContain(VAULT_SENTINEL);

  const classified = classifyFilesWorkerError(
    new Error(VAULT_SENTINEL),
  );
  expect(JSON.stringify(classified)).not.toContain(VAULT_SENTINEL);
  expect(Object.keys(classified)).toEqual(["code"]);

  const backendPaths = await sourceFiles("backend", [".mo"]);
  let literalTrapCount = 0;
  for (const path of backendPaths) {
    const tokens = lexSource(
      await readFile(new URL(path, FILES_ROOT), "utf8"),
    );
    const debugCalls = memberCalls(tokens, "Debug", "print");
    expect(debugCalls, `${path} must not log backend values`).toHaveLength(0);
    for (const call of memberCalls(tokens, "Runtime", "trap")) {
      literalTrapCount += 1;
      expect(
        call.arguments,
        `${path}:${call.line} Runtime.trap argument count`,
      ).toHaveLength(1);
      expect(
        call.arguments[0]?.kind,
        `${path}:${call.line} Runtime.trap must contain a fixed literal`,
      ).toBe("string");
    }
  }
  expect(literalTrapCount).toBeGreaterThan(20);
});

test("the Files release source inventory binds the privacy gate", async () => {
  const paths = await filesReleaseSourcePaths();
  expect(paths).toContain("test/privacy_release_v2.test.ts");
  expect(paths.filter((path) => path === "test/privacy_release_v2.test.ts"))
    .toHaveLength(1);
  expect(paths).toEqual([...paths].sort());
});

function sourceMethod(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

async function sourceFiles(
  directory: string,
  extensions: readonly string[] = [".ts", ".tsx"],
): Promise<string[]> {
  const root = new URL(directory.endsWith("/") ? directory : `${directory}/`, FILES_ROOT);
  const paths: string[] = [];
  async function visit(url: URL): Promise<void> {
    const entries = await readdir(url, { withFileTypes: true });
    for (const entry of entries) {
      const child = new URL(entry.name, url);
      if (entry.isDirectory()) {
        await visit(new URL(`${entry.name}/`, url));
      } else if (
        entry.isFile() &&
        extensions.includes(extname(entry.name)) &&
        !entry.name.endsWith(".d.ts")
      ) {
        paths.push(
          `${directory}/${relative(
            new URL(root).pathname,
            child.pathname,
          )}`,
        );
      }
    }
  }
  await visit(root);
  return paths.sort();
}

function walkAst(
  value: unknown,
  visitor: (node: UnknownRecord) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkAst(item, visitor);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.type === "string") visitor(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    walkAst(child, visitor);
  }
}

function nodeLine(node: UnknownRecord): number {
  const location = objectField(node, "loc");
  const start = location && objectField(location, "start");
  return start && typeof start.line === "number" ? start.line : 0;
}

function stringField(record: UnknownRecord, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value : "";
}

function objectField(
  record: UnknownRecord,
  field: string,
): UnknownRecord | null {
  const value = record[field];
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function captureToolRegistrations(): CapturedTool[] {
  const registrations: CapturedTool[] = [];
  const exposure: FilesToolExposure = {
    expose(name, options, handler) {
      registrations.push({
        name,
        attachment: false,
        options: options as UnknownRecord,
        invoke: handler as unknown as (...args: unknown[]) => unknown,
      });
    },
    exposeAttachment(name, options, handler) {
      registrations.push({
        name,
        attachment: true,
        options: options as UnknownRecord,
        invoke: handler as unknown as (...args: unknown[]) => unknown,
      });
    },
    async publish() {},
  };
  const inertPort = new Proxy(Object.create(null) as UnknownRecord, {
    get() {
      return async () => {
        throw new Error("The privacy registration fixture cannot call a port");
      };
    },
  }) as unknown as FilesResidentFilePort<unknown>;
  installFilesV2Tools(
    inertPort,
    {
      installationGeneration: () =>
        parseCanonicalNat64("1", "installation generation"),
      lockEpoch: () => parseCanonicalNat64("1", "lock epoch"),
    },
    exposure,
    () => undefined,
  );
  return registrations;
}

function lexSource(source: string): LexToken[] {
  const tokens: LexToken[] = [];
  let index = 0;
  let line = 1;
  while (index < source.length) {
    const character = source[index]!;
    if (character === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "\n") line += 1;
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) throw new Error("Unterminated block comment");
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const tokenLine = line;
      let value = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        const next = source[index]!;
        if (next === "\n") line += 1;
        if (next === "\\") {
          value += next;
          index += 1;
          if (index < source.length) {
            value += source[index]!;
            index += 1;
          }
          continue;
        }
        if (next === quote) {
          index += 1;
          closed = true;
          break;
        }
        value += next;
        index += 1;
      }
      if (!closed) throw new Error(`Unterminated string at line ${tokenLine}`);
      tokens.push({ kind: "string", value, line: tokenLine });
      continue;
    }
    if (/[A-Za-z0-9_]/u.test(character)) {
      const tokenLine = line;
      const start = index;
      index += 1;
      while (
        index < source.length &&
        /[A-Za-z0-9_]/u.test(source[index]!)
      ) {
        index += 1;
      }
      tokens.push({
        kind: "atom",
        value: source.slice(start, index),
        line: tokenLine,
      });
      continue;
    }
    tokens.push({ kind: "symbol", value: character, line });
    index += 1;
  }
  return tokens;
}

class CandidParser {
  #index = 0;

  constructor(private readonly tokens: readonly LexToken[]) {}

  parseTypes(): Map<string, CandidType> {
    const types = new Map<string, CandidType>();
    while (this.#index < this.tokens.length) {
      if (this.#peek("service")) break;
      this.#expect("type");
      const name = this.#takeAtom();
      this.#expect("=");
      const value = this.#parseType();
      this.#expect(";");
      if (types.has(name)) throw new Error(`Duplicate Candid type ${name}`);
      types.set(name, value);
    }
    if (!this.#peek("service")) {
      throw new Error("Candid fixture is missing its service");
    }
    return types;
  }

  #parseType(): CandidType {
    const head = this.#takeAtom();
    if (head === "opt" || head === "vec") {
      return {
        kind: "unary",
        operator: head,
        value: this.#parseType(),
      };
    }
    if (head !== "record" && head !== "variant") {
      return { kind: "atom", name: head };
    }
    this.#expect("{");
    const fields: Array<{
      name: string;
      value: CandidType | null;
    }> = [];
    while (!this.#peek("}")) {
      const name = this.#takeFieldName();
      const value = this.#consume(":") ? this.#parseType() : null;
      if (!this.#consume(";") && !this.#peek("}")) {
        this.#expect(";");
      }
      fields.push({ name, value });
    }
    this.#expect("}");
    return {
      kind: "aggregate",
      aggregate: head,
      fields,
    };
  }

  #takeFieldName(): string {
    const token = this.tokens[this.#index];
    if (!token || (token.kind !== "atom" && token.kind !== "string")) {
      throw new Error(`Expected Candid field at token ${this.#index}`);
    }
    this.#index += 1;
    return token.value;
  }

  #takeAtom(): string {
    const token = this.tokens[this.#index];
    if (!token || token.kind !== "atom") {
      throw new Error(`Expected Candid atom at token ${this.#index}`);
    }
    this.#index += 1;
    return token.value;
  }

  #peek(value: string): boolean {
    return this.tokens[this.#index]?.value === value;
  }

  #consume(value: string): boolean {
    if (!this.#peek(value)) return false;
    this.#index += 1;
    return true;
  }

  #expect(value: string): void {
    const token = this.tokens[this.#index];
    if (token?.value !== value) {
      throw new Error(
        `Expected '${value}' at token ${this.#index}, got '${token?.value}'`,
      );
    }
    this.#index += 1;
  }
}

function collectCandidLeaves(
  definitions: ReadonlyMap<string, CandidType>,
): {
  blob: string[];
  text: string[];
  vecNat8: string[];
} {
  const result = { blob: [] as string[], text: [] as string[], vecNat8: [] as string[] };
  const visit = (value: CandidType, path: string): void => {
    if (value.kind === "atom") {
      if (value.name === "blob") result.blob.push(path);
      if (value.name === "text") result.text.push(path);
      return;
    }
    if (value.kind === "unary") {
      if (
        value.operator === "vec" &&
        value.value.kind === "atom" &&
        value.value.name === "nat8"
      ) {
        result.vecNat8.push(path);
      }
      visit(value.value, path);
      return;
    }
    for (const field of value.fields) {
      if (field.value !== null) {
        visit(field.value, `${path}.${field.name}`);
      }
    }
  };
  for (const [name, value] of definitions) visit(value, name);
  return result;
}

function memberCalls(
  tokens: readonly LexToken[],
  owner: string,
  method: string,
): Array<Readonly<{
  line: number;
  arguments: readonly LexToken[];
}>> {
  const calls: Array<{
    line: number;
    arguments: readonly LexToken[];
  }> = [];
  for (let index = 0; index + 3 < tokens.length; index += 1) {
    if (
      tokens[index]?.value !== owner ||
      tokens[index + 1]?.value !== "." ||
      tokens[index + 2]?.value !== method ||
      tokens[index + 3]?.value !== "("
    ) {
      continue;
    }
    let depth = 1;
    let cursor = index + 4;
    const argumentTokens: LexToken[] = [];
    while (cursor < tokens.length && depth > 0) {
      const token = tokens[cursor]!;
      if (token.value === "(") depth += 1;
      if (token.value === ")") depth -= 1;
      if (depth > 0) argumentTokens.push(token);
      cursor += 1;
    }
    if (depth !== 0) {
      throw new Error(`Unterminated ${owner}.${method} call`);
    }
    calls.push({
      line: tokens[index]!.line,
      arguments: argumentTokens,
    });
    index = cursor - 1;
  }
  return calls;
}

function serializeError(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error);
  const extended = error as Error & {
    code?: unknown;
    nextAction?: unknown;
    details?: unknown;
    cause?: unknown;
  };
  return JSON.stringify({
    name: extended.name,
    message: extended.message,
    stack: extended.stack,
    code: extended.code,
    nextAction: extended.nextAction,
    details: extended.details,
    cause: extended.cause instanceof Error
      ? {
          name: extended.cause.name,
          message: extended.cause.message,
        }
      : extended.cause,
  });
}

function fixedBytes(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function containsBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
): boolean {
  if (needle.byteLength === 0) return true;
  outer:
  for (
    let offset = 0;
    offset + needle.byteLength <= haystack.byteLength;
    offset += 1
  ) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}
