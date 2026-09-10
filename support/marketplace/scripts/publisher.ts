// All rights reserved. See ../LICENSE.
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { inspectPackageFiles, inspectUpdatePackage, PACKAGE_CONTENT_TYPE, SOURCE_CONTENT_TYPE, UPLOAD_CHUNK_BYTES } from "../../update-source/src/model.ts";
import { preparePackageInstall } from "neutron-compiler/src/install.ts";
import { normalizeManifestDependencies } from "neutron-tools/src/schema.ts";
import { blob, Candidate, call, decode, encode, json, natural, principal, relay, result, unwrap, type Target } from "./operator-wire.ts";

const nat = IDL.Nat, text = IDL.Text, nat64 = IDL.Nat64, rec = IDL.Record, opt = IDL.Opt;
const variant = (...keys: string[]) => IDL.Variant(Object.fromEntries(keys.map(key => [key, IDL.Null])));
export const Fee = rec({ feeVersion: nat, processingCycles: nat, storageCycles: nat, totalCycles: nat, processingBytes: nat, newStorageBytes: nat });
export const FeeRequest = rec({ operation: variant("update", "upload", "purchase", "withdraw", "grant"), processingBytes: nat, newStorageBytes: nat });
export const Info = rec({ canister: IDL.Principal, fees: rec({ version: nat }) });
export const Listing = rec({ appId: text, title: text, summary: text, description: text, priceUsdMicros: nat, iconArtifact: opt(nat64), screenshots: IDL.Vec(nat64), expectedRevision: opt(nat64), feeVersion: nat });
export const UploadBegin = rec({ requestId: text, appId: text, digest: blob, size: nat64, mediaType: text, purpose: variant("package", "source", "image"), feeVersion: nat });
export const UploadChunk = rec({ requestId: text, offset: nat64, bytes: blob, feeVersion: nat });
export const UploadFinish = rec({ requestId: text, feeVersion: nat });
export const Submit = rec({ requestId: text, appId: text, version: nat, artifactId: nat64, sourceArtifactId: opt(nat64), dependencies: IDL.Vec(rec({ appId: text, minVersion: nat })), feeVersion: nat });
export const UploadReply = result(rec({ requestId: text, appId: text, digest: blob, size: nat64, uploadedBytes: nat64, state: variant("uploading", "attached", "aborted"), artifactId: opt(nat64) }));
const ListingReply = result(rec({ appId: text, revision: nat64 }));
export const SubmitReply = result(Candidate);
type Quote = { feeVersion: bigint; processingCycles: bigint; storageCycles: bigint; totalCycles: bigint; processingBytes: bigint; newStorageBytes: bigint };
type UploadValue = { requestId: string; appId: string; digest: Uint8Array; size: bigint; uploadedBytes: bigint; state: Record<string, null>; artifactId: [] | [bigint] };
type Outcome<T> = { ok: T } | { err: { code: string; message: string } };
type ListingInput = { appId: string; title: string; summary: string; description: string; priceUsdMicros: bigint; iconArtifact: bigint[]; screenshots: bigint[]; expectedRevision: bigint[] };
type File = { purpose: "package" | "source"; digest: string; bytes: Uint8Array; mediaType: string };
export type Prepared = { appId: string; version: bigint; dependencies: { appId: string; minVersion: bigint }[]; files: File[]; listing?: ListingInput };
export type PublisherOptions = { target: Target; neutron: string; requestId: string; journal: string; execute?: boolean; maxCycles?: bigint };
export type Transport = { query: (target: Target, method: string, args: Uint8Array) => Promise<Uint8Array>; update: (target: Target, neutron: string, method: string, args: Uint8Array, cycles: bigint) => Promise<Uint8Array> };
const transport: Transport = { query: (target, method, args) => call(target, method, args, true), update: relay };
type Step = { key: string; method: string; argsHex: string; cycles: string; feeVersion: string; replyHex?: string; attempts: number; outcome: "prepared" | "unknown" | "complete" | "rejected"; error?: string };
type Journal = { format: "marketplace-publisher-v1"; fingerprint: string; requestId: string; canister: string; neutron: string; appId: string; version: string; files: { purpose: string; digest: string; size: number }[]; steps: Step[]; submittedCandidateId?: string };
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));

function listingInput(input: unknown, appId: string): ListingInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The listing must be a JSON object.");
  const v = input as Record<string, unknown>;
  const allowed = ["appId", "title", "summary", "description", "priceUsdMicros", "iconArtifact", "screenshots", "expectedRevision"];
  for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new Error(`Unknown listing field: ${key}`);
  if (v.appId !== appId) throw new Error("The listing appId must match the packed app.");
  for (const key of ["title", "summary", "description"]) if (typeof v[key] !== "string") throw new Error(`Listing ${key} must be text.`);
  const number = (value: unknown, label: string) => { if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) throw new Error(`${label} must be a decimal string or safe integer.`); return natural(String(value), label); };
  const price = number(v.priceUsdMicros, "priceUsdMicros");
  if (price !== 0n && (price < 1_000_000n || price > 50_000_000n)) throw new Error("A listing must be free or priced between $1 and $50.");
  for (const key of ["iconArtifact", "expectedRevision"]) if (!(key in v)) throw new Error(`Supply listing ${key} explicitly, using null when absent.`);
  if (!Array.isArray(v.screenshots)) throw new Error("Supply listing screenshots explicitly as an array of artifact IDs.");
  return { appId, title: v.title as string, summary: v.summary as string, description: v.description as string, priceUsdMicros: price, iconArtifact: v.iconArtifact === null ? [] : [number(v.iconArtifact, "iconArtifact")], expectedRevision: v.expectedRevision === null ? [] : [number(v.expectedRevision, "expectedRevision")], screenshots: v.screenshots.map(id => number(id, "screenshot artifact")) };
}

/** Uses the same archive and complete-source verifier as production publication. */
export async function preparePublisher(packageFile: string, listingFile?: string): Promise<Prepared> {
  const [checked] = await inspectPackageFiles([path.resolve(packageFile)]);
  if (!checked) throw new Error("Package inspection returned no package.");
  const manifest = preparePackageInstall(checked.bytes).manifest;
  const dependencies = Object.values(normalizeManifestDependencies(manifest)).map(value => ({ appId: value.app, minVersion: BigInt(value.min_version) })).sort((a, b) => a.appId.localeCompare(b.appId));
  const files: File[] = [{ purpose: "package", digest: checked.record.sha256, bytes: checked.bytes, mediaType: PACKAGE_CONTENT_TYPE }];
  if (checked.hostedSource) files.push({ purpose: "source", digest: checked.hostedSource.sha256, bytes: checked.hostedSource.bytes, mediaType: SOURCE_CONTENT_TYPE });
  return { appId: checked.record.id, version: BigInt(checked.record.version), dependencies, files, ...(listingFile ? { listing: listingInput(JSON.parse(await readFile(listingFile, "utf8")), checked.record.id) } : {}) };
}

async function save(file: string, journal: Journal) {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(json(journal)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); const directory = await open(path.dirname(file), "r"); try { await directory.sync(); } finally { await directory.close(); } }
  finally { await rm(temporary, { force: true }); }
}

async function lock(file: string): Promise<() => Promise<void>> {
  const name = `${file}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const handle = await open(name, "wx", 0o600); await handle.writeFile(String(process.pid)); await handle.close(); return () => rm(name, { force: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await readFile(name, "utf8"));
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error(`Publisher journal lock is unreadable: ${name}`);
      try { process.kill(owner, 0); throw new Error("This publication journal is already being used by another process."); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
      await rm(name);
    }
  }
  throw new Error("Could not acquire the publication journal.");
}

export async function publish(prepared: Prepared, options: PublisherOptions, io: Transport = transport) {
  const target = { ...options.target, canister: principal(options.target.canister) }, neutron = principal(options.neutron);
  if (!options.requestId.trim()) throw new Error("Provide a stable publication request ID; reuse it after interruption.");
  if (prepared.files[0]?.purpose !== "package" || prepared.files.some(file => digest(file.bytes) !== file.digest)) throw new Error("Prepared archive bytes changed after inspection.");
  const metadata = inspectUpdatePackage(`${prepared.appId}.neutron`, prepared.files[0].bytes);
  const source = prepared.files.find(file => file.purpose === "source");
  if (metadata.record.id !== prepared.appId || BigInt(metadata.record.version) !== prepared.version || metadata.record.sha256 !== prepared.files[0].digest) throw new Error("Prepared identity differs from the packed app.");
  if (prepared.files.length !== (metadata.hostedSource ? 2 : 1) || (metadata.hostedSource?.sha256 ?? null) !== (source?.digest ?? null) || (metadata.hostedSource && metadata.hostedSource.size !== source?.bytes.length)) throw new Error("The exact declared offered source must remain part of this publication.");
  const actualDependencies = Object.values(normalizeManifestDependencies(preparePackageInstall(prepared.files[0].bytes).manifest)).map(value => ({ appId: value.app, minVersion: BigInt(value.min_version) })).sort((a, b) => a.appId.localeCompare(b.appId));
  if (json(actualDependencies) !== json(prepared.dependencies)) throw new Error("Publication dependencies differ from the packed manifest.");
  const file = path.resolve(options.journal);
  await mkdir(path.dirname(file), { recursive: true });
  const release = await lock(file);
  try {
    const files = prepared.files.map(f => ({ purpose: f.purpose, digest: f.digest, size: f.bytes.length }));
    const fingerprint = digest(json({ canister: target.canister, neutron, network: target.network, requestId: options.requestId, appId: prepared.appId, version: prepared.version, dependencies: prepared.dependencies, listing: prepared.listing ?? null, files }));
    let journal: Journal;
    try { journal = JSON.parse(await readFile(file, "utf8")); if (journal.format !== "marketplace-publisher-v1" || journal.fingerprint !== fingerprint) throw new Error("This journal belongs to different package bytes, listing, target, or request ID. Resume using the original inputs."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; journal = { format: "marketplace-publisher-v1", fingerprint, requestId: options.requestId, canister: target.canister, neutron, appId: prepared.appId, version: String(prepared.version), files, steps: [] }; await save(file, journal); }
    const info = decode<{ canister: Principal; fees: { version: bigint } }>(Info, await io.query(target, "marketplace_info", new Uint8Array(IDL.encode([], []))));
    if (info.canister.toText() !== target.canister || info.fees.version <= 0n) throw new Error("Marketplace information does not match the selected source or a valid fee schedule.");
    const feeVersion = info.fees.version;
    let estimatedCycles = 0n, attemptedCycles = 0n;
    const review: { key: string; method: string; argumentBytes: number; argumentSha256: string; cycles: string; resumed: boolean }[] = [];

    async function step<T>(key: string, method: string, inputType: IDL.Type, input: object, output: IDL.Type, newStorage = 0n): Promise<T | undefined> {
      let saved = journal.steps.find(item => item.key === key);
      if (saved?.replyHex && saved.outcome === "complete") return unwrap(decode<Outcome<T>>(output, bytes(saved.replyHex)));
      let args: Uint8Array, cycles: bigint;
      if (saved) {
        if (saved.method !== method) throw new Error("Saved publication step does not match the current workflow.");
        // A lost update reply must retain exactly the originally dispatched bytes,
        // even if the current fee schedule has changed in the meantime.
        args = bytes(saved.argsHex); cycles = natural(saved.cycles, "saved cycles");
      } else {
        args = encode(inputType, { ...input, feeVersion });
        const request = { operation: { [method === "upload_begin" ? "upload" : "update"]: null }, processingBytes: BigInt(args.length), newStorageBytes: newStorage };
        const quote = decode<Quote>(Fee, await io.query(target, "fee_quote", encode(FeeRequest, request)));
        if (quote.feeVersion !== feeVersion || quote.processingBytes !== request.processingBytes || quote.newStorageBytes !== newStorage || quote.totalCycles <= 0n || quote.totalCycles !== quote.processingCycles + quote.storageCycles) throw new Error("Cycle quote changed or does not match the exact request. Review again before publishing.");
        cycles = quote.totalCycles;
      }
      estimatedCycles += cycles;
      review.push({ key, method, argumentBytes: args.length, argumentSha256: digest(args), cycles: String(cycles), resumed: Boolean(saved) });
      if (!options.execute) return undefined;
      if (options.maxCycles !== undefined && attemptedCycles + cycles > options.maxCycles) throw new Error("The reviewed maximum cycle budget is insufficient for the next update. Completed steps are retained in the journal.");
      if (!saved) { saved = { key, method, argsHex: hex(args), cycles: String(cycles), feeVersion: String(feeVersion), attempts: 0, outcome: "prepared" }; journal.steps.push(saved); }
      saved.attempts++; saved.outcome = "unknown"; delete saved.error;
      await save(file, journal);
      attemptedCycles += cycles;
      let response: Uint8Array;
      try { response = await io.update(target, neutron, method, args, cycles); }
      catch (error) { saved.error = error instanceof Error ? error.message : String(error); await save(file, journal); throw new Error(`${method} reply unavailable. Resume with the same journal and request ID; no new upload or candidate identity is needed. ${saved.error}`); }
      // Save response bytes before interpreting them or advancing to another step.
      saved.replyHex = hex(response); await save(file, journal);
      const decoded = decode<Outcome<T>>(output, response);
      if ("err" in decoded) { saved.outcome = "rejected"; saved.error = `${decoded.err.code}: ${decoded.err.message}`; await save(file, journal); throw new Error(saved.error); }
      saved.outcome = "complete"; await save(file, journal);
      return decoded.ok;
    }
    if (prepared.listing) await step("listing", "listing_save", Listing, prepared.listing, ListingReply);
    const artifacts = new Map<string, bigint>();
    for (const part of prepared.files) {
      const requestId = `${options.requestId}:${part.purpose}`;
      const check = (status: UploadValue | undefined, minimum: number) => {
        if (status && (status.requestId !== requestId || status.appId !== prepared.appId || hex(status.digest) !== part.digest || status.size !== BigInt(part.bytes.length) || status.uploadedBytes < BigInt(minimum) || status.uploadedBytes > status.size || "aborted" in status.state)) throw new Error("Upload response does not match the exact file, request ID, or confirmed byte range.");
      };
      const begun = await step<UploadValue>(`${part.purpose}:begin`, "upload_begin", UploadBegin, { requestId, appId: prepared.appId, digest: bytes(part.digest), size: BigInt(part.bytes.length), mediaType: part.mediaType, purpose: { [part.purpose]: null } }, UploadReply, BigInt(part.bytes.length));
      check(begun, 0);
      for (let offset = 0; offset < part.bytes.length; offset += UPLOAD_CHUNK_BYTES) {
        const chunk = part.bytes.slice(offset, offset + UPLOAD_CHUNK_BYTES);
        check(await step<UploadValue>(`${part.purpose}:chunk:${offset}`, "upload_chunk", UploadChunk, { requestId, offset: BigInt(offset), bytes: chunk }, UploadReply), offset + chunk.length);
      }
      const completed = await step<UploadValue>(`${part.purpose}:finish`, "upload_finish", UploadFinish, { requestId }, UploadReply);
      check(completed, part.bytes.length);
      if (completed && (!("attached" in completed.state) || completed.artifactId.length !== 1)) throw new Error("The completed upload did not return an attached artifact.");
      artifacts.set(part.purpose, completed?.artifactId[0] ?? 0n);
    }
    const candidate = await step<{ id: bigint; appId: string; version: bigint; artifactId: bigint; sourceArtifactId: bigint[]; digest: Uint8Array; sourceDigest: Uint8Array[]; dependencies: { appId: string; minVersion: bigint }[] }>("candidate", "candidate_submit", Submit, { requestId: `${options.requestId}:candidate`, appId: prepared.appId, version: prepared.version, artifactId: artifacts.get("package")!, sourceArtifactId: artifacts.has("source") ? [artifacts.get("source")!] : [], dependencies: prepared.dependencies }, SubmitReply);
    if (candidate) {
      if (candidate.appId !== prepared.appId || candidate.version !== prepared.version || hex(candidate.digest) !== prepared.files[0]!.digest || candidate.artifactId !== artifacts.get("package") || json(candidate.dependencies) !== json(prepared.dependencies) || json(candidate.sourceArtifactId) !== json(artifacts.has("source") ? [artifacts.get("source")!] : []) || (candidate.sourceDigest[0] ? hex(candidate.sourceDigest[0]) : null) !== (prepared.files.find(f => f.purpose === "source")?.digest ?? null)) throw new Error("Submitted candidate evidence does not match the inspected package and offered source.");
      journal.submittedCandidateId = String(candidate.id); await save(file, journal);
    }
    return { action: options.execute ? "candidate_submitted_for_audit" : "publication_review", canister: target.canister, neutron, requestId: options.requestId, appId: prepared.appId, version: String(prepared.version), journal: file, files, dependencies: prepared.dependencies, steps: review, estimatedRemainingCycles: String(estimatedCycles), attemptedCycles: String(attemptedCycles), candidateId: journal.submittedCandidateId ?? null, note: "Storage includes one year. Retransmissions can pay processing again; unused attached cycles are refunded. Audit approval is separate from submission." };
  } finally { await release(); }
}

const HELP = `Marketplace publisher (review by default; --execute sends updates)

bun scripts/publisher.ts --package FILE.neutron --journal FILE.json --request ID --neutron ID --canister ID --identity NAME --network ic [--listing FILE.json] [--max-cycles NAT] [--execute]

The declared offered-source sidecar must accompany the package. Listing JSON
contains appId, title, summary, description, priceUsdMicros, iconArtifact,
screenshots, expectedRevision; use null for absent icon/revision. Omit --listing
to keep an existing listing. Every update attaches its quoted cycles through
the installed, authorized Neutron marketplace app. Resume with the same inputs,
request ID, and journal after interruption. No auditor approval is implied.
`;
export async function main(argv: string[]) {
  const parsed = parseArgs({ args: argv, options: Object.fromEntries([... ["package", "journal", "request", "neutron", "canister", "identity", "network", "listing", "root-key", "max-cycles"].map(key => [key, { type: "string" as const }]), ["execute", { type: "boolean" }], ["help", { type: "boolean" }]]) });
  const values = parsed.values as Record<string, string | boolean | undefined>;
  if (values.help) { process.stdout.write(HELP); return; }
  const get = (key: string) => { const value = values[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required.\n${HELP}`); return value; };
  const optional = (key: string) => typeof values[key] === "string" ? values[key] as string : undefined;
  const prepared = await preparePublisher(get("package"), optional("listing"));
  process.stdout.write(json(await publish(prepared, { target: { canister: get("canister"), identity: get("identity"), network: get("network"), rootKeyFile: optional("root-key") }, neutron: get("neutron"), requestId: get("request"), journal: get("journal"), execute: values.execute === true, ...(optional("max-cycles") ? { maxCycles: natural(get("max-cycles"), "max-cycles") } : {}) })));
}
if (import.meta.main) main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
