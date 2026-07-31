import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "neutron-compiler/src/compile.ts";
import { assertCompiledSelfCallBindings } from "neutron-compiler/src/candid_signatures.ts";
import { packageMotoko } from "neutron-scripts/src/mopack.ts";
import {
  parsePackageString,
  type PackageMap,
} from "neutron-scripts/src/walk.ts";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";

type BlobContract = {
  field: "body";
  max_bytes: number;
};

type MethodContract = {
  name: string;
  mode: "query" | "update";
  request_type: string;
  response_type: string;
  result_type: string;
  input_blob: BlobContract | null;
  output_blob: BlobContract | null;
};

type AbiContract = {
  logical_api: number;
  limits: Record<string, number>;
  public_usage: {
    word_type: "nat64";
    maximum_word: string;
    current_fields: string[];
    limit_fields: string[];
  };
  reconciliation: {
    private_write_target_order: string;
    private_write_target_minimum_nodes: number;
    private_write_target_maximum_nodes: number;
    committed_nodes_order: string;
    bootstrap_operation_summary_target: string;
    committed_detail_tags: string[];
    committed_detail_payload: string;
    committed_detail_null: string;
    abort_target_fields: string[];
  };
  methods: MethodContract[];
};

const didUrl = new URL("../../candid/files-v2.did", import.meta.url);
const abiUrl = new URL("../../candid/files-v2.abi.json", import.meta.url);
const manifestUrl = new URL("../../neutron.json", import.meta.url);
const surfaceActorUrl = new URL("./main_surface_actor.mo", import.meta.url);
const corePackageUrl = new URL(
  "../../.mops/_github/core%23v2.6.0/src/",
  import.meta.url,
);
const capabilitiesPackageUrl = new URL(
  "../../../../packages/neutron-motoko-capabilities/src/",
  import.meta.url,
);
const sha2PackageUrl = new URL("../../.mops/sha2@0.0.2/src/", import.meta.url);
const basePackageUrl = new URL("../../.mops/base@0.9.2/src/", import.meta.url);
const filesRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = resolve(filesRoot, "../..");
const kernelRoot = join(repositoryRoot, "apps/kernel");

async function fixture(): Promise<{
  did: string;
  compactDid: string;
  abi: AbiContract;
  manifest: Record<string, any>;
}> {
  const [did, abiText, manifestText] = await Promise.all([
    readFile(didUrl, "utf8"),
    readFile(abiUrl, "utf8"),
    readFile(manifestUrl, "utf8"),
  ]);
  return {
    did,
    compactDid: compactCandid(did),
    abi: JSON.parse(abiText) as AbiContract,
    manifest: JSON.parse(manifestText) as Record<string, any>,
  };
}

test("the initial logical Files V2 fixture is valid Candid", async () => {
  const result = spawnSync("didc", ["check", fileURLToPath(didUrl)], {
    encoding: "utf8",
  });
  expect(
    result.status,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  ).toBe(0);
});

test("backend/main public types are strictly identical to the logical fixture", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "neutron-files-v2-abi-"));
  const emittedDid = join(temporary, "main-surface.did");
  try {
    const compile = spawnSync(
      "moc",
      [
        "--idl",
        "--package",
        "core",
        fileURLToPath(corePackageUrl),
        "--package",
        "neutron-capabilities",
        fileURLToPath(capabilitiesPackageUrl),
        "--package",
        "sha2",
        fileURLToPath(sha2PackageUrl),
        "--package",
        "base",
        fileURLToPath(basePackageUrl),
        "-o",
        emittedDid,
        fileURLToPath(surfaceActorUrl),
      ],
      { encoding: "utf8" },
    );
    expect(
      compile.status,
      [compile.stdout, compile.stderr].filter(Boolean).join("\n"),
    ).toBe(0);

    const comparisons: Array<readonly [string, string]> = [
      [emittedDid, fileURLToPath(didUrl)],
      [fileURLToPath(didUrl), emittedDid],
    ];
    for (const [current, previous] of comparisons) {
      const comparison = spawnSync(
        "didc",
        ["check", "-s", current, previous],
        { encoding: "utf8" },
      );
      expect(
        comparison.status,
        [comparison.stdout, comparison.stderr].filter(Boolean).join("\n"),
      ).toBe(0);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);

test("all eleven logical methods have their frozen mode and record-contained Blob ABI", async () => {
  const { compactDid, abi } = await fixture();
  expect(abi.logical_api).toBe(2);
  expect(abi.methods).toHaveLength(11);
  expect(new Set(abi.methods.map(({ name }) => name)).size).toBe(11);

  const service = compactDid.slice(compactDid.lastIndexOf("service:{"));
  const parsed = new Map<
    string,
    { arguments: string; result: string; mode: "query" | "update" }
  >();
  const methodPattern =
    /(files_[a-z0-9_]+):\(([^)]*)\)->\(([^)]*)\)(query)?;/g;
  for (const match of service.matchAll(methodPattern)) {
    const name = match[1];
    const argumentsText = match[2];
    const resultText = match[3];
    if (
      name === undefined ||
      argumentsText === undefined ||
      resultText === undefined
    ) {
      throw new Error("invalid Files method fixture match");
    }
    parsed.set(name, {
      arguments: argumentsText,
      result: resultText,
      mode: match[4] === "query" ? "query" : "update",
    });
  }
  expect([...parsed.keys()].sort()).toEqual(
    abi.methods.map(({ name }) => name).sort(),
  );

  for (const method of abi.methods) {
    const actual = parsed.get(method.name);
    expect(actual, `${method.name} is absent from the service`).toBeDefined();
    expect(actual?.mode, `${method.name} mode`).toBe(method.mode);
    expect(actual?.arguments, `${method.name} arguments`).toBe(
      method.request_type,
    );
    expect(actual?.result, `${method.name} result`).toBe(method.result_type);

    expect(
      compactDid,
      `${method.name} must use a named request record`,
    ).toContain(`type${method.request_type}=record{`);
    expect(
      compactDid,
      `${method.name} must use a named response record`,
    ).toContain(
      `type${method.response_type}=record{outcome:optvariant{`,
    );

    if (method.output_blob !== null) {
      expect(
        compactDid,
        `${method.name} output must be the direct value/body envelope`,
      ).toContain(
        `type${method.result_type}=record{value:${method.response_type};body:blob;};`,
      );
    } else {
      expect(method.result_type).toBe(method.response_type);
    }
    if (method.input_blob !== null) {
      expect(method.input_blob.field).toBe("body");
      expect(
        compactDid,
        `${method.name} input Blob must be a field of its named request`,
      ).toContain(`type${method.request_type}=record{`);
      expect(requestDeclaration(compactDid, method.request_type)).toContain(
        "body:blob;",
      );
    }
  }
});

test("the compiler-emitted combined actor maps all logical methods to deterministic physical labels", async () => {
  const { did, abi } = await fixture();
  const temporary = await mkdtemp(
    join(tmpdir(), "neutron-files-v2-combined-abi-"),
  );
  try {
    const compiled = await compileCombinedActor(temporary);
    const v2Methods = new Set(abi.methods.map(({ name }) => name));
    const bindings = assertCompiledSelfCallBindings(
      compiled.candid,
      compiled.capabilityPlans,
    ).filter(
      ({ appId, logicalMethod }) =>
        appId === "files" && v2Methods.has(logicalMethod),
    );
    expect(bindings).toHaveLength(11);
    expect(bindings).toEqual(
      abi.methods
        .map((method) => ({
          appId: "files",
          logicalMethod: method.name,
          physicalMethod: physicalAppMethodName("files", method.name),
          mode: method.mode,
        }))
        .sort(
          (left, right) =>
            left.logicalMethod < right.logicalMethod
              ? -1
              : left.logicalMethod > right.logicalMethod
                ? 1
                : 0,
        ),
    );

    const emittedFilesDid = remapCompiledFilesService(
      compiled.candid,
      abi.methods,
    );
    const emittedPath = join(temporary, "compiled-files.did");
    const logicalPath = join(temporary, "logical-files.did");
    await writeFile(emittedPath, emittedFilesDid, "utf8");
    await writeFile(logicalPath, compilerParserCandid(did), "utf8");
    for (const [current, previous] of [
      [emittedPath, logicalPath],
      [logicalPath, emittedPath],
    ] as const) {
      const comparison = spawnSync(
        "didc",
        ["check", "-s", current, previous],
        { encoding: "utf8" },
      );
      expect(
        comparison.status,
        [comparison.stdout, comparison.stderr].filter(Boolean).join("\n"),
      ).toBe(0);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 120_000);

test("the ABI Blob caps remain app-enforced while the manifest uses API-1", async () => {
  const { abi, manifest } = await fixture();
  expect(abi.limits).toEqual({
    normalized_request_bytes: 65_536,
    normalized_response_bytes: 65_536,
    raw_candid_metadata_bytes: 131_072,
    decoder_allocation_bytes: 524_288,
    type_entries: 256,
    recursive_depth: 32,
    decoded_elements: 4_096,
    committed_nodes_per_receipt: 64,
    operation_write_target_nodes: 64,
    endpoint_in_flight_blob_bytes: 33_554_432,
    global_in_flight_blob_bytes: 67_108_864,
  });

  const preapproval = manifest.capabilities.preapproved_self_calls;
  expect(preapproval.api).toBe(1);
  expect(new Set(preapproval.methods).size).toBe(preapproval.methods.length);
  for (const { name } of abi.methods) {
    expect(preapproval.methods).toContain(name);
  }

  for (const method of abi.methods) {
    expect(manifest.func[method.name]).toEqual({
      type: method.mode,
      async: false,
    });
  }
});

test("binary payloads are ordinary fields of the named records", async () => {
  const { compactDid, abi } = await fixture();
  expect(compactDid.match(/body:blob;/g)).toHaveLength(8);
  for (const method of abi.methods) {
    if (method.input_blob !== null) {
      expect(requestDeclaration(compactDid, method.request_type)).toContain(
        "body:blob;",
      );
    }
    if (method.output_blob !== null) {
      expect(
        compactDid,
        `${method.name} output must retain its named value/body record`,
      ).toContain(
        `type${method.result_type}=record{value:${method.response_type};body:blob;};`,
      );
    }
  }

  for (const optionalBoundary of [
    "reason:optFilesRejectionReasonV2",
    "kind:optFilesNodeKindV2",
    "crypto_profile:optFilesContentCryptoProfileV2",
    "kind:optFilesOperationKindV2",
    "vault:optFilesVaultStateV2",
    "locator:optFilesLookupLocatorV2",
    "target:optFilesOperationTargetV2",
    "state:optFilesOperationStateV2",
    "detail:optFilesCommittedDetailV2",
    "cleanup_state:optFilesCleanupStateV2",
    "operation:optFilesVaultWriteOperationV2",
    "action:optFilesMutationActionV2",
    "frame_kind:optvariant{first;continuation;}",
  ]) {
    expect(
      compactDid,
      `${optionalBoundary} must remain an opt-variant boundary`,
    ).toContain(optionalBoundary);
  }
});

test("empty requests and read-chunk rejection codes retain their baseline shape", async () => {
  const { compactDid } = await fixture();
  expect(compactDid).toContain(
    "typeFilesBootstrapRequestV2=record{};",
  );
  expect(compactDid).toContain("typeFilesCleanupRequestV2=record{};");
  for (const reason of [
    "not_found",
    "not_file",
    "stale_revision",
    "stale_content",
    "invalid_index",
    "corrupt_state",
    "incompatible",
  ]) {
    expect(compactDid).toContain(`${reason};`);
  }
});

test("private operation status carries only private-write progress", async () => {
  const { compactDid } = await fixture();
  expect(compactDid).toContain(
    "stage_id:optnat64;accepted_frames_bitmap:nat16;frame_block_mapping:vecFilesFrameBlockMappingV2;",
  );
  expect(compactDid).not.toContain("accepted_blocks_bitmap:");
  expect(compactDid).not.toContain("block_hashes:");
  expect(compactDid).toContain(
    "typeFilesCommittedNodeV2=record{node_id:Id128V2;content_id:optId128V2;structural_revision:nat64;metadata_revision:nat64;};",
  );
  expect(
    compactDid.match(/committed_nodes:vecFilesCommittedNodeV2;/g),
  ).toHaveLength(1);
  expect(compactDid).not.toContain("committed_node_id:");
  expect(compactDid).not.toContain("committed_content_id:");
  expect(compactDid).not.toContain("committed_structural_revision:");
});

test("operation reconciliation binds ordered batches and exact committed receipts", async () => {
  const { compactDid, abi } = await fixture();
  expect(abi.reconciliation).toEqual({
    private_write_target_order: "canonical_ascending_node_id_hi_lo",
    private_write_target_minimum_nodes: 1,
    private_write_target_maximum_nodes: 64,
    committed_nodes_order: "canonical_ascending_node_id_hi_lo",
    bootstrap_operation_summary_target:
      "required_optional_exact_authority",
    committed_detail_tags: [
      "vault",
      "private_write",
      "mutation",
      "remove",
      "abort",
    ],
    committed_detail_payload: "exact_update_success_record",
    committed_detail_null: "incompatible",
    abort_target_fields: [
      "stage_id",
    ],
  });
  expect(compactDid).toContain(
    "typeFilesOperationWriteTargetNodeV2=record{node_id:Id128V2;content_id:optId128V2;};",
  );
  expect(compactDid).toContain(
    "private_write:record{nodes:vecFilesOperationWriteTargetNodeV2;};",
  );
  expect(compactDid).toContain(
    "typeFilesOperationSummaryV2=record{request_id:Id128V2;kind:optFilesOperationKindV2;stage_id:optnat64;expires_at_ns:optnat64;target:optFilesOperationTargetV2;};",
  );
  expect(compactDid).toContain(
    "abort:record{stage_id:nat64;};",
  );
  expect(compactDid).toContain(
    "typeFilesCommittedDetailV2=variant{vault:FilesVaultWriteOkV2;private_write:FilesWriteBlockOkV2;mutation:FilesMutateOkV2;remove:FilesRemoveOkV2;abort:FilesAbortOkV2;};",
  );
  expect(compactDid).toContain(
    "committed:record{detail:optFilesCommittedDetailV2;};",
  );
  for (const [response, success] of [
    ["FilesVaultWriteResponseV2", "FilesVaultWriteOkV2"],
    ["FilesWriteBlockResponseV2", "FilesWriteBlockOkV2"],
    ["FilesMutateResponseV2", "FilesMutateOkV2"],
    ["FilesRemoveResponseV2", "FilesRemoveOkV2"],
    ["FilesAbortResponseV2", "FilesAbortOkV2"],
  ]) {
    expect(compactDid).toContain(
      `type${response}=record{outcome:optvariant{ok:${success};rejected:FilesRejectionV2;};};`,
    );
  }
});

test("retired encrypted-share methods and wire types are absent", async () => {
  const { compactDid, abi } = await fixture();
  for (const retired of [
    "files_share_list_v2",
    "files_share_block_v2",
    "files_share_unshare_v2",
    "FilesPublicationTargetV2",
    "FilesSharePresentationV2",
    "FilesShareStateV2",
    "FilesShareListCursorV2",
    "FilesShareListItemV2",
    "FilesShareListRequestV2",
    "FilesShareListResponseV2",
    "FilesShareBlockOkV2",
    "FilesShareBlockRequestV2",
    "FilesShareBlockResponseV2",
    "FilesShareUnshareOkV2",
    "FilesShareUnshareRequestV2",
    "FilesShareUnshareResponseV2",
    "FilesAbortStageKindV2",
  ]) {
    expect(compactDid).not.toContain(retired);
    expect(abi.methods.some(({ name }) => name === retired)).toBeFalse();
  }
  for (const retiredTag of [
    "share_in_progress;",
    "public_share;",
    "public_share:",
    "unshare;",
    "unshare:",
  ]) {
    expect(compactDid).not.toContain(retiredTag);
  }
});

test("bootstrap freezes the complete JSON-safe Certified Assets usage mirror", async () => {
  const { compactDid, abi } = await fixture();
  expect(abi.public_usage).toEqual({
    word_type: "nat64",
    maximum_word: "18446744073709551615",
    current_fields: [
      "live_entries",
      "occupied_entry_slots",
      "committed_body_bytes",
      "reserved_committed_body_bytes",
      "allocated_body_bytes",
      "charged_metadata_bytes",
      "accepted_staged_bytes",
      "reserved_staged_bytes",
      "detached_charged_bytes",
      "active_stages",
      "reserved_entry_slots",
      "receipt_lanes",
      "general_receipt_lanes",
      "reserved_general_receipt_lanes",
      "reserved_revocation_lanes",
      "filled_revocation_lanes",
      "receipt_nonce_indexes",
      "receipt_expiry_indexes",
      "cleanup_jobs",
    ],
    limit_fields: [
      "entries",
      "committed_bytes",
      "object_bytes",
      "staged_bytes",
      "pending_stages",
      "batch_operations",
      "batch_bytes",
      "general_receipts",
      "revocation_lanes",
    ],
  });
  expect(compactDid).toContain(
    "typeFilesPublicUsageV2=record{current:FilesPublicUsageCountersV2;manifest_limits:FilesPublicUsageLimitsV2;effective_limits:FilesPublicUsageLimitsV2;};",
  );
  expect(compactDid).toContain(
    "quota:FilesQuotaSnapshotV2;public_usage:FilesPublicUsageV2;cleanup:FilesCleanupSummaryV2;",
  );
  for (const field of [
    ...abi.public_usage.current_fields,
    ...abi.public_usage.limit_fields,
  ]) {
    expect(compactDid).toContain(`${field}:nat64;`);
  }
});

function compactCandid(source: string): string {
  return source
    .replace(/\/\/[^\n\r]*/g, "")
    .replace(/\s+/g, "");
}

function requestDeclaration(compactDid: string, typeName: string): string {
  const marker = `type${typeName}=record{`;
  const start = compactDid.indexOf(marker);
  if (start < 0) throw new Error(`missing Candid request type ${typeName}`);
  const end = compactDid.indexOf("};", start);
  if (end < 0) throw new Error(`unterminated Candid request type ${typeName}`);
  return compactDid.slice(start, end + 2);
}

function compilerParserCandid(did: string): string {
  const marker = "service : {";
  const start = did.lastIndexOf(marker);
  const end = did.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("logical Files fixture has no terminal service");
  }
  const methods = did.slice(start + marker.length, end);
  return `${did.slice(0, start)}
type FilesLogicalServiceV2 = service {${methods}};
service : () -> FilesLogicalServiceV2;
`;
}

async function compileCombinedActor(temporary: string) {
  const packaged = await Promise.all([
    packageSourceMotoko(kernelRoot, join(temporary, "kernel")),
    packageSourceMotoko(filesRoot, join(temporary, "files")),
  ]);
  const modules = new Map<string, string>();
  const configs: Record<string, PackagedNeutronManifest> = {};

  for (const sourcePackage of packaged) {
    configs[sourcePackage.manifest.id] = sourcePackage.manifest;
    for (const module of sourcePackage.modules) {
      const previous = modules.get(module.path);
      if (previous !== undefined && previous !== module.content) {
        throw new Error(`Conflicting packaged Motoko module ${module.path}`);
      }
      modules.set(module.path, module.content);
    }
  }

  return compile({
    configs,
    mofiles: [...modules]
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(([path, content]) => ({ path, content })),
  });
}

async function packageSourceMotoko(
  sourceRoot: string,
  temporaryRoot: string,
): Promise<{
  manifest: PackagedNeutronManifest;
  modules: Array<{ path: string; content: string }>;
}> {
  await mkdir(temporaryRoot, { recursive: true });
  await Promise.all([
    cp(join(sourceRoot, "backend"), join(temporaryRoot, "backend"), {
      recursive: true,
    }),
    cp(
      join(sourceRoot, "neutron.json"),
      join(temporaryRoot, "neutron.json"),
    ),
  ]);
  await packageMotoko({
    cwd: temporaryRoot,
    packages: resolveMopsPackages(sourceRoot),
  });

  const distRoot = join(temporaryRoot, "dist");
  const manifest = JSON.parse(
    await readFile(join(distRoot, "neutron.json"), "utf8"),
  ) as PackagedNeutronManifest;
  const moduleNames = (await readdir(join(distRoot, "mo")))
    .filter((name) => name.endsWith(".mo"))
    .sort();
  return {
    manifest,
    modules: await Promise.all(
      moduleNames.map(async (name) => ({
        path: name,
        content: await readFile(join(distRoot, "mo", name), "utf8"),
      })),
    ),
  };
}

function resolveMopsPackages(sourceRoot: string): PackageMap {
  const result = spawnSync("mops", ["sources"], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      ["mops sources failed", result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return Object.fromEntries(
    Object.entries(
      parsePackageString(result.stdout.replace(/\n/g, " ").trim()),
    ).map(([name, directory]) => [
      name,
      resolve(sourceRoot, directory),
    ]),
  );
}

function remapCompiledFilesService(
  candid: string,
  methods: MethodContract[],
): string {
  const actor = /service\s*:\s*\(\s*\)\s*->\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/u
    .exec(candid)?.[1];
  if (!actor) {
    throw new Error("compiler-emitted Candid has no actor-class service");
  }
  const declaration = new RegExp(
    `type\\s+${actor}\\s*=\\s*service\\s*\\{`,
    "u",
  ).exec(candid);
  if (declaration?.index === undefined) {
    throw new Error(`compiler-emitted Candid has no ${actor} service type`);
  }
  const open = candid.indexOf("{", declaration.index);
  const close = matchingBrace(candid, open);
  const serviceBody = candid.slice(open + 1, close);
  const expected = new Map(
    methods.map((method) => [
      physicalAppMethodName("files", method.name),
      method.name,
    ]),
  );
  const selected = new Map<string, string>();

  for (const statement of splitServiceStatements(serviceBody)) {
    const colon = statement.indexOf(":");
    if (colon < 0) continue;
    const physical = statement.slice(0, colon).trim();
    const logical = expected.get(physical);
    if (!logical) continue;
    const leading = statement.slice(0, statement.search(/\S/u));
    selected.set(
      logical,
      `${leading}${logical}${statement.slice(colon)}`,
    );
  }

  const missing = methods
    .map(({ name }) => name)
    .filter((name) => !selected.has(name));
  if (missing.length > 0) {
    throw new Error(
      `compiler-emitted Candid is missing Files methods: ${missing.join(", ")}`,
    );
  }
  const extractedBody = methods
    .map(({ name }) => selected.get(name)!)
    .join("\n");
  return `${candid.slice(0, open + 1)}\n${extractedBody}\n${candid.slice(close)}`;
}

function matchingBrace(source: string, open: number): number {
  if (open < 0 || source[open] !== "{") {
    throw new Error("service type has no opening brace");
  }
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("service type has no closing brace");
}

function splitServiceStatements(serviceBody: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < serviceBody.length; index += 1) {
    const character = serviceBody[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (
      character === ";" &&
      braces === 0 &&
      parentheses === 0 &&
      brackets === 0
    ) {
      statements.push(serviceBody.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (serviceBody.slice(start).trim() !== "") {
    throw new Error("compiler-emitted service has an unterminated method");
  }
  return statements;
}
