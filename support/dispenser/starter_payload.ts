import { Actor, type ActorMethod, type HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import {
  buildPackagesInstallAssets,
  createJsonAsset,
  createStaticFileOperation,
  createTextAsset,
  type PreparedPackageFile,
  type StaticFileOperation,
} from "neutron-compiler/src/install.js";
import { fixedBackendCallInstallReservationTargetPrincipals } from "neutron-compiler/src/compile.js";
import {
  buildFreshInstallProvenance,
  sha256Hex,
  type PreparedDeployment,
} from "neutron-provision/src/artifact.js";

const STARTER_WASM_CHUNK_BYTES = 1_500_000;
const STARTER_UPLOAD_CONCURRENCY = 6;
const dynamicAssetPaths = new Set([
  "/system/runtime-config.json",
  "/pkg/id.json",
]);

type RuntimeConfigTemplate = { segments: string[] };

type NeutronFile = {
  content: Uint8Array;
  content_type: string;
  content_encoding: string;
  chunks: bigint;
};

type StarterUploadSpec = {
  deployment_id: string;
  app_ids: string[];
  wasm_chunks: bigint;
  wasm_bytes: bigint;
  wasm_sha256: Uint8Array;
  files: bigint;
  file_chunks: bigint;
  runtime_config_template: RuntimeConfigTemplate;
  backend_call_target_principals: Principal[];
};

export type StarterInfo = {
  revision: bigint;
  deployment_id: string;
  app_ids: string[];
  wasm_bytes: bigint;
  wasm_sha256: Uint8Array;
  files: bigint;
  file_chunks: bigint;
  backend_call_target_principals: Principal[];
};

type MaintenanceActor = {
  begin_starter_upload: ActorMethod<[StarterUploadSpec], bigint>;
  add_starter_wasm_chunk: ActorMethod<
    [bigint, bigint, Uint8Array],
    undefined
  >;
  add_starter_file: ActorMethod<
    [bigint, string, NeutronFile],
    undefined
  >;
  add_starter_file_chunk: ActorMethod<
    [bigint, string, bigint, Uint8Array],
    undefined
  >;
  commit_starter_upload: ActorMethod<[bigint], undefined>;
  starter: ActorMethod<[], [] | [StarterInfo]>;
};

export async function stageStarterPayload({
  agent,
  canisterId,
  deployment,
  appIds,
  runtimeConfigTemplate,
  progress = console.log,
}: {
  agent: HttpAgent;
  canisterId: string;
  deployment: PreparedDeployment;
  appIds: string[];
  runtimeConfigTemplate: RuntimeConfigTemplate;
  progress?: (message: string) => void;
}): Promise<StarterInfo> {
  const actor = Actor.createActor<MaintenanceActor>(maintenanceIdl, {
    agent,
    canisterId: Principal.fromText(canisterId),
  });
  const wasmChunks = chunkBytes(
    deployment.transportWasm,
    STARTER_WASM_CHUNK_BYTES,
  );
  const operations = starterAssetOperations(deployment);
  const fileChunkCount = operations.reduce(
    (count, operation) => count + operation.chunks.length,
    0,
  );
  const expectedSha256 = hexBytes(deployment.transportWasmSha256);
  const backendCallTargetPrincipals =
    fixedBackendCallInstallReservationTargetPrincipals(
      Object.fromEntries(
        deployment.packages.map(({ manifest }) => [manifest.id, manifest]),
      ),
    ).map((principal) => Principal.fromText(principal));
  const spec: StarterUploadSpec = {
    deployment_id: deployment.compiled.deploymentId,
    app_ids: [...appIds],
    wasm_chunks: BigInt(wasmChunks.length),
    wasm_bytes: BigInt(deployment.transportWasm.byteLength),
    wasm_sha256: expectedSha256,
    files: BigInt(operations.length),
    file_chunks: BigInt(fileChunkCount),
    runtime_config_template: runtimeConfigTemplate,
    backend_call_target_principals: backendCallTargetPrincipals,
  };

  progress(
    `Beginning atomic starter upload: ${wasmChunks.length} Wasm chunks, ${operations.length} files`,
  );
  const uploadEpoch = await actor.begin_starter_upload(spec);
  await mapWithConcurrency(
    wasmChunks,
    STARTER_UPLOAD_CONCURRENCY,
    async (content, index) => {
      await actor.add_starter_wasm_chunk(
        uploadEpoch,
        BigInt(index),
        content,
      );
    },
  );
  progress(`Uploaded ${wasmChunks.length} starter Wasm chunks`);
  let uploadedFiles = 0;
  await mapWithConcurrency(
    operations,
    STARTER_UPLOAD_CONCURRENCY,
    async (operation) => {
      await actor.add_starter_file(uploadEpoch, operation.key, {
        ...operation.val,
        chunks: BigInt(operation.val.chunks),
      });
      await Promise.all(
        operation.chunks.map(({ chunk_id, content }) =>
          actor.add_starter_file_chunk(
            uploadEpoch,
            operation.key,
            BigInt(chunk_id),
            content,
          ),
        ),
      );
      uploadedFiles += 1;
      if (uploadedFiles % 50 === 0 || uploadedFiles === operations.length) {
        progress(
          `Uploaded ${uploadedFiles}/${operations.length} starter files`,
        );
      }
    },
  );
  await actor.commit_starter_upload(uploadEpoch);

  const [info] = await actor.starter();
  if (info === undefined) {
    throw new Error("Dispenser did not retain committed starter information");
  }
  assertCommittedStarter(info, spec);
  progress(
    `Committed ${info.app_ids.length - 1} apps in starter deployment ${info.deployment_id}`,
  );
  return info;
}

function assertCommittedStarter(
  info: StarterInfo,
  expected: StarterUploadSpec,
): void {
  if (
    info.revision < 1n ||
    info.deployment_id !== expected.deployment_id ||
    info.wasm_bytes !== expected.wasm_bytes ||
    info.files !== expected.files ||
    info.file_chunks !== expected.file_chunks ||
    info.app_ids.length !== expected.app_ids.length ||
    info.app_ids.some((id, index) => id !== expected.app_ids[index]) ||
    info.backend_call_target_principals.length !==
      expected.backend_call_target_principals.length ||
    info.backend_call_target_principals.some(
      (principal, index) =>
        principal.toText() !==
        expected.backend_call_target_principals[index]?.toText(),
    ) ||
    !sameBytes(info.wasm_sha256, expected.wasm_sha256)
  ) {
    throw new Error("Dispenser starter verification did not match the upload");
  }
}

const maintenanceIdl: Parameters<typeof Actor.createActor>[0] = ({
  IDL: candid,
}) => {
  const file = candid.Record({
    content: candid.Vec(candid.Nat8),
    content_type: candid.Text,
    content_encoding: candid.Text,
    chunks: candid.Nat,
  });
  const runtimeConfigTemplate = candid.Record({
    segments: candid.Vec(candid.Text),
  });
  const starterInfo = candid.Record({
    revision: candid.Nat,
    deployment_id: candid.Text,
    app_ids: candid.Vec(candid.Text),
    wasm_bytes: candid.Nat,
    wasm_sha256: candid.Vec(candid.Nat8),
    files: candid.Nat,
    file_chunks: candid.Nat,
    backend_call_target_principals: candid.Vec(candid.Principal),
  });
  return candid.Service({
    begin_starter_upload: candid.Func(
      [
        candid.Record({
          deployment_id: candid.Text,
          app_ids: candid.Vec(candid.Text),
          wasm_chunks: candid.Nat,
          wasm_bytes: candid.Nat,
          wasm_sha256: candid.Vec(candid.Nat8),
          files: candid.Nat,
          file_chunks: candid.Nat,
          runtime_config_template: runtimeConfigTemplate,
          backend_call_target_principals: candid.Vec(candid.Principal),
        }),
      ],
      [candid.Nat],
      [],
    ),
    add_starter_wasm_chunk: candid.Func(
      [candid.Nat, candid.Nat, candid.Vec(candid.Nat8)],
      [],
      [],
    ),
    add_starter_file: candid.Func([candid.Nat, candid.Text, file], [], []),
    add_starter_file_chunk: candid.Func(
      [candid.Nat, candid.Text, candid.Nat, candid.Vec(candid.Nat8)],
      [],
      [],
    ),
    commit_starter_upload: candid.Func([candid.Nat], [], []),
    starter: candid.Func([], [candid.Opt(starterInfo)], ["query"]),
  });
};

function starterAssetOperations(
  deployment: PreparedDeployment,
): StaticFileOperation[] {
  const operations = new Map<string, StaticFileOperation>();
  for (const file of uniquePreparedFiles(deployment)) {
    const normalizedPath = file.path.startsWith("/")
      ? file.path.slice(1)
      : file.path;
    const contentEncoding = /^mo\/[a-f0-9]{64}\.mo$/u.test(normalizedPath)
      ? "identity"
      : undefined;
    addOperation(
      operations,
      createStaticFileOperation(
        file.path,
        file.content,
        undefined,
        contentEncoding,
      ),
    );
  }
  const packageAssets = buildPackagesInstallAssets({
    existingApps: {},
    packages: deployment.packages,
    candid: deployment.compiled.candid,
  });
  for (const operation of [
    packageAssets.candidAsset,
    packageAssets.appRegistryAsset,
    buildStarterInstallProvenanceAsset(deployment),
    createTextAsset(
      "/pkg/neutron.most",
      deployment.compiled.stable,
      "text/plain",
    ),
  ]) {
    operations.set(operation.key, operation);
  }
  for (const dynamicPath of dynamicAssetPaths) operations.delete(dynamicPath);
  return [...operations.values()].sort(({ key: left }, { key: right }) =>
    left.localeCompare(right),
  );
}

export function buildStarterInstallProvenanceAsset(
  deployment: Pick<PreparedDeployment, "packages" | "packageArtifacts">,
): StaticFileOperation {
  return createJsonAsset(
    "/system/install-provenance.json",
    buildFreshInstallProvenance(deployment),
  );
}

function addOperation(
  operations: Map<string, StaticFileOperation>,
  operation: StaticFileOperation,
): void {
  const existing = operations.get(operation.key);
  if (existing !== undefined && !sameOperation(existing, operation)) {
    throw new Error(`Starter assets disagree on ${operation.key}`);
  }
  operations.set(operation.key, operation);
}

function uniquePreparedFiles(
  deployment: PreparedDeployment,
): PreparedPackageFile[] {
  const files = new Map<string, PreparedPackageFile>();
  for (const preparedPackage of deployment.packages) {
    for (const file of preparedPackage.files) {
      const existing = files.get(file.path);
      if (
        existing !== undefined &&
        !sameBytes(existing.content, file.content)
      ) {
        throw new Error(`Prepared packages disagree on asset ${file.path}`);
      }
      files.set(file.path, file);
    }
  }
  return [...files.values()];
}

function chunkBytes(value: Uint8Array, chunkSize: number): Uint8Array[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error("Starter Wasm chunk size is invalid");
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < value.byteLength; offset += chunkSize) {
    chunks.push(
      value.slice(offset, Math.min(value.byteLength, offset + chunkSize)),
    );
  }
  if (chunks.length === 0) {
    throw new Error("Starter Wasm cannot be empty");
  }
  return chunks;
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  callback: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await callback(values[index]!, index);
      }
    }),
  );
}

function hexBytes(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Starter Wasm SHA-256 is invalid");
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}

function sameOperation(
  left: StaticFileOperation,
  right: StaticFileOperation,
): boolean {
  return (
    left.key === right.key &&
    left.val.content_type === right.val.content_type &&
    left.val.content_encoding === right.val.content_encoding &&
    left.val.chunks === right.val.chunks &&
    sameBytes(left.val.content, right.val.content) &&
    left.chunks.length === right.chunks.length &&
    left.chunks.every(
      (chunk, index) =>
        chunk.chunk_id === right.chunks[index]?.chunk_id &&
        sameBytes(chunk.content, right.chunks[index]!.content),
    )
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}
