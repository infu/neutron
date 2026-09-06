import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePackageInstall } from "../../src/install.ts";
import type { PreparedArchive } from "../legacy_kernel_upgrade.pocketic.test.ts";

export const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// Immutable production archives, never rebuilt as predecessor evidence.
const predecessors = {
  kernel336: ["kernel", 336, 2_433_352, "97222bc4c956932ff21b96773cc5a438f92ae5ac7660c0c3f408be7eb25a7eeb"],
  wallet312: ["wallet", 312, 678_721, "6875f1f98ae7309fe84885ed77df9847c1c1ad03f5baa8d6aed4b00fb4f48129"],
  wallet306: ["wallet", 306, 666_413, "bea0d49e351bb8efa04bf03057b4f9175474a54bd198b382add790718b7b8aae"],
  kitchensink311: ["kitchensink", 311, 430_950, "4fb7f6fc74c29b05a95f4ce2f706d2f6cd8db4cd2dd9e840233b65e16acaa921"],
  contacts305: ["contacts", 305, 297_977, "aa5e6ee225b0d2a2057e0a5678797d593745273553dcb9dca38a992f4134e15a"],
  hello201: ["hello", 201, 185_021, "82613cc3882c7404e51e09308e27a4885062f5f622663becf18cca0a046b8c27"],
} as const;

function archivePath(id: string, version: number): string {
  const semver = `${Math.floor(version / 10_000)}.${Math.floor(version / 100) % 100}.${version % 100}`;
  return path.join(repositoryRoot, "apps", id, `${id}.v${semver}.neutron`);
}

export async function predecessor(name: keyof typeof predecessors): Promise<PreparedArchive> {
  const [id, version, size, digest] = predecessors[name];
  const archive = new Uint8Array(await readFile(archivePath(id, version)));
  expect(archive.byteLength, `${name} retained bytes`).toBe(size);
  expect(sha256(archive), `${name} retained digest`).toBe(digest);
  return { archive, prepared: preparePackageInstall(archive, {
    expectedIdentity: { id, version, sha256: digest },
  }) };
}

const minimumVersions = { kernel: 337, wallet: 313, kitchensink: 312, evm_wallet: 100, uniswap: 100 } as const;
export type CandidateId = keyof typeof minimumVersions;

export async function reviewedCandidate(id: CandidateId): Promise<PreparedArchive> {
  const raw = process.env.NEUTRON_EVM_UPGRADE_CANDIDATE_SHA256;
  if (!raw) throw new Error("NEUTRON_EVM_UPGRADE_CANDIDATE_SHA256 must contain the reviewed per-app SHA-256 JSON object");
  const pins = JSON.parse(raw) as Record<string, unknown>;
  if (pins === null || typeof pins !== "object" || Array.isArray(pins)) throw new Error("Candidate digest pins must be an object");
  const digest = pins[id];
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Missing reviewed ${id} SHA-256`);
  const source = JSON.parse(await readFile(path.join(repositoryRoot, "apps", id, "neutron.json"), "utf8"));
  expect(source.id).toBe(id);
  expect(Number.isSafeInteger(source.version)).toBe(true);
  expect(source.version).toBeGreaterThanOrEqual(minimumVersions[id]);
  expect(source.update_source).toBe("233tv-xiaaa-aaaay-aacta-cai");
  // The app's source manifest selects the archive; no stale candidate filename
  // can silently qualify different bytes from the reviewed release.
  const archive = new Uint8Array(await readFile(archivePath(id, source.version)));
  expect(sha256(archive), `${id} reviewed candidate digest`).toBe(digest);
  return { archive, prepared: preparePackageInstall(archive, {
    expectedIdentity: { id, version: source.version, sha256: digest },
  }) };
}
