// All rights reserved. See ../LICENSE.
import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NEUTRON_REPOSITORY_PROTOCOL, repositoryPackagePath, repositoryReleasePath, type RepositoryReleaseRecord } from "neutron-tools/src/repository.ts";
import { REPOSITORY_CHANNELS_PROTOCOL, REPOSITORY_CHANNEL_HEADS_PROTOCOL, repositoryChannelsPath, repositoryChannelHeadsPath, type RepositoryChannelHeads } from "neutron-tools/src/release_channels.ts";
import { packageHeaders, releaseHeaders, sourceHeaders, sha256Hex, PACKAGE_CONTENT_TYPE, SOURCE_CONTENT_TYPE, UPDATE_SOURCE_RECEIPT_PROTOCOL } from "../../update-source/src/model.ts";
import { updateSourceOrigin } from "../../update-source/src/http.ts";
import { TRUSTED_PUBLISHER_CALLER } from "./publication-evidence.ts";
import { promoteTrustedReleases, promotionRequestId, PromotionRejectedError, type PromotionEntry, type PromotionReceipt, type PromotionOptions, type TrustedPromotionTransport } from "./first-party-promote.ts";

const canister = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const caller = Principal.fromText(TRUSTED_PUBLISHER_CALLER);
const origin = updateSourceOrigin({ canisterId: canister });
const text = (value: string) => new TextEncoder().encode(value);
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const sourcePath = (digest: string) => `/repo/v1/sources/${digest}.source.v1.msgpack.gz`;
type Asset = { body: Uint8Array; headers: [string, string][] };
type Candidate = { candidateId: bigint; record: RepositoryReleaseRecord; sourceDigest: string; sourceSize: number; dependencies: PromotionEntry["dependencies"] };

function fixture(root: string) {
  const assets = new Map<string, Asset>();
  const channelHeads = new Map<string, RepositoryChannelHeads>();
  const candidates = new Map<string, Candidate>();
  const reads: string[] = [], preparations: string[][] = [];
  const mutations: { requestId: string; entries: PromotionEntry[] }[] = [];
  const receipts = new Map<string, PromotionReceipt>();
  let loseReply = false;
  const proof: [string, string][] = [["ic-certificate", "certificate=:YQ==:, tree=:Yg==:, expr_path=:Yw==:, version=2"], ["ic-certificateexpression", "default_certification(ValidationArgs{})"]];
  const setJson = (pathname: string, value: unknown) => {
    const body = text(JSON.stringify(value));
    assets.set(pathname, { body, headers: [["content-type", "application/json"], ...releaseHeaders(sha256Hex(body))] });
  };
  const syncHeads = (id: string) => setJson(repositoryChannelHeadsPath(id), channelHeads.get(id)!);
  const makeCandidate = (id: string, version: number, candidateId: bigint): Candidate => {
    // Promotion verifies the existing artifact identity; it does not build or inspect a new archive.
    const packageBytes = text(`existing ${id} package ${version}`), sourceBytes = text(`existing ${id} offered source ${version}`);
    const digest = sha256Hex(packageBytes), sourceDigest = sha256Hex(sourceBytes);
    assets.set(repositoryPackagePath(digest), { body: packageBytes, headers: [["content-type", PACKAGE_CONTENT_TYPE], ...packageHeaders(digest)] });
    assets.set(sourcePath(sourceDigest), { body: sourceBytes, headers: [["content-type", SOURCE_CONTENT_TYPE], ...sourceHeaders(sourceDigest)] });
    const candidate: Candidate = {
      candidateId, record: { protocol: NEUTRON_REPOSITORY_PROTOCOL, id, version, sha256: digest, size: packageBytes.length },
      sourceDigest, sourceSize: sourceBytes.length,
      dependencies: id === "wallet" ? [{ appId: "kernel", minVersion: 200n }] : [],
    };
    candidates.set(String(candidateId), candidate);
    return candidate;
  };
  setJson(repositoryChannelsPath(), { protocol: REPOSITORY_CHANNELS_PROTOCOL, source: canister });
  for (const [index, id] of ["kernel", "wallet"].entries()) {
    const stable = makeCandidate(id, 100, BigInt(index + 1));
    const beta = makeCandidate(id, 200, BigInt(index + 11));
    channelHeads.set(id, {
      protocol: REPOSITORY_CHANNEL_HEADS_PROTOCOL, source: canister, id,
      stable: { revision: "3", candidate_id: String(stable.candidateId), release: stable.record },
      beta: { revision: "4", candidate_id: String(beta.candidateId), release: beta.record },
    });
    setJson(repositoryReleasePath(id), stable.record);
    syncHeads(id);
  }
  const selection = (ids: string[]): PromotionEntry[] => ids.map(appId => {
    const heads = channelHeads.get(appId)!, beta = candidates.get(heads.beta.candidate_id!)!;
    return {
      appId, candidateId: beta.candidateId, version: BigInt(beta.record.version), digest: Uint8Array.from(Buffer.from(beta.record.sha256, "hex")),
      sourceDigest: [Uint8Array.from(Buffer.from(beta.sourceDigest, "hex"))], packageSize: BigInt(beta.record.size), sourceSize: [BigInt(beta.sourceSize)],
      dependencies: structuredClone(beta.dependencies), expectedBetaRevision: BigInt(heads.beta.revision),
      expectedStableCandidate: heads.stable.candidate_id === null ? [] : [BigInt(heads.stable.candidate_id)], expectedStableRevision: BigInt(heads.stable.revision),
    };
  });
  const transport: TrustedPromotionTransport = {
    caller,
    async prepare(appIds) { preparations.push([...appIds]); return { entries: selection(appIds) }; },
    async status(requestId) { reads.push(`status:${requestId}`); return receipts.get(requestId) ?? null; },
    async promote(request) {
      mutations.push(structuredClone(request));
      const receipt: PromotionReceipt = { id: BigInt(44 + receipts.size), owner: caller, publisher: caller, operation: "promote", channel: "stable", requestId: request.requestId, entries: structuredClone(request.entries), createdAtNs: 1n };
      receipts.set(request.requestId, receipt);
      for (const entry of request.entries) {
        const heads = channelHeads.get(entry.appId)!, candidate = candidates.get(String(entry.candidateId))!;
        heads.stable = { revision: String(BigInt(heads.stable.revision) + 1n), candidate_id: String(entry.candidateId), release: candidate.record };
        setJson(repositoryReleasePath(entry.appId), candidate.record);
        syncHeads(entry.appId);
      }
      if (loseReply) { loseReply = false; throw new Error("lost promotion reply"); }
      return receipt;
    },
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const pathname = new URL(String(input)).pathname; reads.push(pathname);
    const asset = assets.get(pathname);
    return new Response(asset ? Uint8Array.from(asset.body) : null, { status: asset ? 200 : 404, headers: [...proof, ...(asset?.headers ?? [])] });
  }) as typeof fetch;
  const options: PromotionOptions = { canister, appIds: ["wallet", "kernel"], journal: path.join(root, "promotion.json"), fetch: fetcher };
  const advanceBeta = (ids = ["kernel", "wallet"]) => {
    for (const id of ids) {
      const heads = channelHeads.get(id)!;
      const beta = makeCandidate(id, heads.beta.release!.version + 100, BigInt(heads.beta.candidate_id!) + 100n);
      heads.beta = { revision: String(BigInt(heads.beta.revision) + 1n), candidate_id: String(beta.candidateId), release: beta.record };
      syncHeads(id);
    }
  };
  return { options, assets, reads, preparations, mutations, receipts, transport, selection, advanceBeta, lose: () => { loseReply = true; } };
}
function caseTest(name: string, run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  test(name, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "first-party-promote-"));
    try { await run(fixture(root)); } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
}

caseTest("review freezes exact beta package and offered-source identities without remote writes", async f => {
  const selected = f.selection(["kernel", "wallet"]);
  const review = await promoteTrustedReleases(f.options, f.transport);
  expect(review.action).toBe("promotion_review");
  if (review.action !== "promotion_review") throw new Error("Expected promotion review.");
  expect(review).toMatchObject({ operation: "promote", channel: "stable", atomic: true, retained_selection: true, reconciled_batch_id: null });
  expect(review.requestId).toBe(promotionRequestId(canister, selected));
  expect(review.packages).toEqual(selected.map(entry => ({
    id: entry.appId, candidate_id: String(entry.candidateId), version: Number(entry.version), sha256: hex(entry.digest), size: Number(entry.packageSize),
    package_path: repositoryPackagePath(hex(entry.digest)), release_path: repositoryReleasePath(entry.appId),
    source: { url: `${origin}${sourcePath(hex(entry.sourceDigest[0]!))}`, path: sourcePath(hex(entry.sourceDigest[0]!)), sha256: hex(entry.sourceDigest[0]!), size: Number(entry.sourceSize[0]!) },
    expected_beta_revision: "4", expected_stable_candidate: String(entry.expectedStableCandidate[0]), expected_stable_revision: "3",
  })));
  const retained = await readFile(f.options.journal, "utf8"), saved = JSON.parse(retained);
  expect(saved).toMatchObject({ operation: "promote", channel: "stable", appIds: ["kernel", "wallet"], requested: false, receipt: null, verified: false });
  expect(saved.entries[1].dependencies).toEqual([{ appId: "kernel", minVersion: "200" }]);
  f.advanceBeta();
  const repeated = await promoteTrustedReleases(f.options, f.transport);
  expect(repeated.packages).toEqual(review.packages); expect(repeated.requestId).toBe(review.requestId);
  expect(await readFile(f.options.journal, "utf8")).toBe(retained);
  expect(f.preparations).toEqual([["kernel", "wallet"]]); expect(f.mutations).toEqual([]);
  expect(f.reads.some(value => value.startsWith("status:"))).toBe(false);
});

caseTest("execute promotes the frozen dependency-complete set once and repeat verifies receipt-v2 unchanged", async f => {
  const selected = f.selection(["kernel", "wallet"]), review = await promoteTrustedReleases(f.options, f.transport);
  const first = await promoteTrustedReleases({ ...f.options, execute: true }, f.transport);
  expect(first.action).toBe("promotion_verified");
  if (first.action !== "promotion_verified") throw new Error("Expected verified promotion.");
  expect(first).toMatchObject({ protocol: UPDATE_SOURCE_RECEIPT_PROTOCOL, operation: "promote", channel: "stable", atomic: true, batch_id: "44", reconciled_batch_id: "44" });
  expect(f.mutations).toEqual([{ requestId: review.requestId, entries: selected }]);
  expect(first.packages.map(entry => entry.status)).toEqual(["promoted", "promoted"]);
  const readCount = f.reads.length;
  const second = await promoteTrustedReleases({ ...f.options, execute: true }, f.transport);
  if (second.action !== "promotion_verified") throw new Error("Expected verified promotion.");
  expect(second.batch_id).toBeNull(); expect(second.reconciled_batch_id).toBe("44"); expect(f.mutations).toHaveLength(1);
  expect(second.packages).toEqual(first.packages.map(entry => ({ ...entry, status: "unchanged" })));
  expect(second.packages.every(entry => entry.source?.status === "unchanged")).toBe(true);
  expect(f.reads.slice(readCount)).toEqual([
    `status:${review.requestId}`,
    ...selected.flatMap(entry => [repositoryChannelHeadsPath(entry.appId), repositoryReleasePath(entry.appId), repositoryPackagePath(hex(entry.digest)), sourcePath(hex(entry.sourceDigest[0]!))]),
  ]);
  expect(JSON.parse(await readFile(f.options.journal, "utf8")).verified).toBe(true);
});

caseTest("lost promotion response followed by advanced beta reconciles the original receipt without mutation", async f => {
  const review = await promoteTrustedReleases(f.options, f.transport);
  f.lose();
  await expect(promoteTrustedReleases({ ...f.options, execute: true }, f.transport)).rejects.toThrow("lost promotion reply");
  const pending = JSON.parse(await readFile(f.options.journal, "utf8"));
  expect(pending).toMatchObject({ requested: true, receipt: null, verified: false });
  f.advanceBeta();
  const result = await promoteTrustedReleases({ ...f.options, execute: true }, f.transport);
  if (result.action !== "promotion_verified") throw new Error("Expected verified promotion.");
  expect(result).toMatchObject({ requestId: review.requestId, batch_id: null, reconciled_batch_id: "44" });
  expect(result.packages.map(entry => [entry.candidate_id, entry.version, entry.status])).toEqual([["11", 200, "unchanged"], ["12", 200, "unchanged"]]);
  expect(f.mutations).toHaveLength(1); expect(f.preparations).toHaveLength(1);
  expect(JSON.parse(await readFile(f.options.journal, "utf8")).entries).toEqual(pending.entries);
});

caseTest("beta advancement before execute fails and retains the reviewed selection", async f => {
  await promoteTrustedReleases(f.options, f.transport);
  const retained = await readFile(f.options.journal, "utf8");
  f.advanceBeta();
  await expect(promoteTrustedReleases({ ...f.options, execute: true }, f.transport)).rejects.toThrow("Current beta or stable changed");
  expect(await readFile(f.options.journal, "utf8")).toBe(retained);
  expect(f.preparations).toHaveLength(1); expect(f.mutations).toEqual([]);
});

caseTest("wallet alone cannot promote against the incompatible stable Kernel", async f => {
  await expect(promoteTrustedReleases({ ...f.options, appIds: ["wallet"], execute: true }, f.transport)).rejects.toThrow("Stable dependency 'kernel' of 'wallet' requires version 200");
  expect(f.mutations).toEqual([]);
  await expect(readFile(f.options.journal)).rejects.toThrow();
});

caseTest("a status receipt for the same request with different source identity fails without replay", async f => {
  const review = await promoteTrustedReleases(f.options, f.transport);
  f.lose();
  await expect(promoteTrustedReleases({ ...f.options, execute: true }, f.transport)).rejects.toThrow("lost promotion reply");
  const retained = await readFile(f.options.journal, "utf8");
  f.receipts.get(review.requestId)!.entries[0]!.sourceDigest = [new Uint8Array(32).fill(9)];
  await expect(promoteTrustedReleases({ ...f.options, execute: true }, f.transport)).rejects.toThrow("Promotion receipt differs");
  expect(await readFile(f.options.journal, "utf8")).toBe(retained); expect(f.mutations).toHaveLength(1);
});

caseTest("refresh cannot replace a pending promotion, including one whose reply was lost", async f => {
  f.lose();
  await expect(promoteTrustedReleases({ ...f.options, execute: true }, f.transport)).rejects.toThrow("lost promotion reply");
  const retained = await readFile(f.options.journal, "utf8"), readCount = f.reads.length;
  f.advanceBeta();
  await expect(promoteTrustedReleases({ ...f.options, refresh: true }, f.transport)).rejects.toThrow("Reconcile and verify the pending promotion");
  expect(await readFile(f.options.journal, "utf8")).toBe(retained);
  expect(f.reads).toHaveLength(readCount); expect(f.preparations).toHaveLength(1); expect(f.mutations).toHaveLength(1);
});

caseTest("refresh after verification retains the original journal and reviews the next beta selection", async f => {
  const first = await promoteTrustedReleases({ ...f.options, execute: true }, f.transport);
  const retained = await readFile(f.options.journal, "utf8");
  f.advanceBeta();
  const next = await promoteTrustedReleases({ ...f.options, refresh: true, requestId: "next-beta-request" }, f.transport);
  if (next.action !== "promotion_review") throw new Error("Expected promotion review.");
  expect(next.requestId).toBe("next-beta-request");
  expect(next.requestId).not.toBe(first.requestId);
  expect(next.packages.map(entry => [entry.candidate_id, entry.version, entry.expected_stable_candidate, entry.expected_stable_revision])).toEqual([["111", 300, "11", "4"], ["112", 300, "12", "4"]]);
  expect(await readFile(`${f.options.journal}.${first.requestId}.retained.json`, "utf8")).toBe(retained);
  expect(JSON.parse(await readFile(f.options.journal, "utf8"))).toMatchObject({ requested: false, receipt: null, verified: false });
  expect(f.preparations).toHaveLength(2); expect(f.mutations).toHaveLength(1);
  const result = await promoteTrustedReleases({ ...f.options, execute: true }, f.transport);
  expect(result).toMatchObject({ action: "promotion_verified", requestId: next.requestId, batch_id: "45" });
  expect(f.mutations).toHaveLength(2);
});

caseTest("corrupt offered source fails verification and retry never promotes the completed request again", async f => {
  const entry = f.selection(["kernel"])[0]!, pathname = sourcePath(hex(entry.sourceDigest[0]!));
  const asset = f.assets.get(pathname)!, original = asset.body;
  asset.body = text("corrupt");
  await expect(promoteTrustedReleases({ ...f.options, execute: true }, f.transport)).rejects.toThrow("expected");
  expect(JSON.parse(await readFile(f.options.journal, "utf8"))).toMatchObject({ requested: true, receipt: { id: "44" }, verified: false });
  await expect(promoteTrustedReleases({ ...f.options, refresh: true }, f.transport)).rejects.toThrow("Reconcile and verify the pending promotion");
  asset.body = original;
  const result = await promoteTrustedReleases({ ...f.options, execute: true }, f.transport);
  expect(result).toMatchObject({ action: "promotion_verified", batch_id: null, reconciled_batch_id: "44" });
  expect(f.mutations).toHaveLength(1);
});

caseTest("refresh and execute must be separate invocations", async f => {
  await expect(promoteTrustedReleases({ ...f.options, execute: true, refresh: true }, f.transport)).rejects.toThrow("Review --refresh separately");
  expect(f.reads).toEqual([]); expect(f.preparations).toEqual([]); expect(f.mutations).toEqual([]);
});


caseTest("a definitive CAS rejection permits explicit refresh while a lost response remains pending", async f => {
  const initial = await promoteTrustedReleases(f.options, f.transport);
  f.transport.promote = async () => { f.advanceBeta(); throw new PromotionRejectedError("channel_conflict", "The beta advanced after verification."); };
  await expect(promoteTrustedReleases({ ...f.options, execute: true }, f.transport)).rejects.toThrow("channel_conflict");
  const rejected = JSON.parse(await readFile(f.options.journal, "utf8"));
  expect(rejected).toMatchObject({ requested: false, verified: false, receipt: null, rejection: { code: "channel_conflict" } });
  const next = await promoteTrustedReleases({ ...f.options, refresh: true }, f.transport);
  expect(next.action).toBe("promotion_review");
  expect(next.requestId).not.toBe(initial.requestId);
  expect(next.packages.map(entry => entry.version)).toEqual([300, 300]);
  expect(f.mutations).toHaveLength(0);
});

caseTest("a no-op promotion retains and requires its exact protocol receipt", async f => {
  await promoteTrustedReleases({ ...f.options, execute: true }, f.transport);
  const review = await promoteTrustedReleases({ ...f.options, refresh: true }, f.transport);
  let noopCalls = 0;
  f.transport.promote = async request => {
    noopCalls++;
    const receipt: PromotionReceipt = { id: 0n, owner: caller, publisher: caller, operation: "promote", channel: "stable", requestId: request.requestId, entries: structuredClone(request.entries), createdAtNs: 2n };
    f.receipts.set(request.requestId, receipt);
    throw new Error("lost no-op reply");
  };
  await expect(promoteTrustedReleases({ ...f.options, execute: true }, f.transport)).rejects.toThrow("lost no-op reply");
  f.advanceBeta();
  const repeated = await promoteTrustedReleases({ ...f.options, execute: true }, f.transport);
  expect(repeated).toMatchObject({ action: "promotion_verified", batch_id: null, reconciled_batch_id: "0" });
  if (repeated.action !== "promotion_verified") throw new Error("Expected verified promotion.");
  expect(repeated.packages.every(entry => entry.status === "unchanged" && entry.source?.status === "unchanged")).toBe(true);
  expect(noopCalls).toBe(1);
  f.receipts.delete(review.requestId);
  await expect(promoteTrustedReleases({ ...f.options, execute: true }, f.transport)).rejects.toThrow("saved promotion receipt is missing");
  expect(noopCalls).toBe(1);
});
