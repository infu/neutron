import { formatCanonicalSeed, parseCanonicalSeed } from "./prng.ts";

export const SHARE_CODE_VERSION = 1 as const;
/**
 * Historical identity labels retained for saved-run and share-code parsing.
 * They do not imply that a corresponding map generator is currently present.
 */
export const LEGACY_GENERATOR_VERSION = "g1" as const;
export const FROZEN_GENERATOR_VERSION_G2 = "g2" as const;
export const FROZEN_GENERATOR_VERSION_G3 = "g3" as const;
export const GENERATOR_VERSION = "g4" as const;
export const SUPPORTED_GENERATOR_VERSIONS = Object.freeze([
  LEGACY_GENERATOR_VERSION,
  FROZEN_GENERATOR_VERSION_G2,
  FROZEN_GENERATOR_VERSION_G3,
  GENERATOR_VERSION,
] as const);
export type GeneratorVersion = (typeof SUPPORTED_GENERATOR_VERSIONS)[number];
export const MIN_DIFFICULTY = 0 as const;
export const MAX_DIFFICULTY = 8 as const;

export type ShareCodeErrorCode =
  | "invalid_format"
  | "invalid_checksum"
  | "unsupported_share_version"
  | "unsupported_generator_version"
  | "unsupported_difficulty";

export class ShareCodeError extends Error {
  readonly code: ShareCodeErrorCode;

  constructor(code: ShareCodeErrorCode, message: string) {
    super(message);
    this.name = "ShareCodeError";
    this.code = code;
  }
}

export interface HullshiftIdentity {
  readonly generatorVersion: GeneratorVersion;
  readonly seed: bigint;
  readonly difficulty: number;
}

export interface ParsedShareCode extends HullshiftIdentity {
  readonly canonicalCode: string;
  readonly checksum: string;
}

const CRC32_TABLE: readonly number[] = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = ((value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1) >>> 0;
  }
  return value >>> 0;
}));

/** IEEE CRC-32. It detects entry errors; it intentionally provides no authenticity. */
export function shareCodeChecksum(payload: string): string {
  let checksum = 0xffff_ffff;
  for (let index = 0; index < payload.length; index += 1) {
    const byte = payload.charCodeAt(index);
    if (byte > 0x7f) {
      throw new RangeError("Share-code checksum payload must be ASCII");
    }
    checksum = (CRC32_TABLE[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8)) >>> 0;
  }
  return ((checksum ^ 0xffff_ffff) >>> 0).toString(16).padStart(8, "0");
}

function assertDifficulty(difficulty: number, generatorVersion: GeneratorVersion): void {
  if (!Number.isInteger(difficulty) || difficulty < MIN_DIFFICULTY || difficulty > MAX_DIFFICULTY) {
    throw new ShareCodeError(
      "unsupported_difficulty",
      `Hullshift ${generatorVersion} supports difficulty ${MIN_DIFFICULTY} through ${MAX_DIFFICULTY}`,
    );
  }
}

function canonicalPayload(
  generatorVersion: GeneratorVersion,
  seed: bigint,
  difficulty: number,
): string {
  assertDifficulty(difficulty, generatorVersion);
  return `HS${SHARE_CODE_VERSION}-${generatorVersion.toUpperCase()}-D${difficulty.toString(36)}-S${formatCanonicalSeed(seed)}`;
}

export function encodeShareCode(identity: HullshiftIdentity): string {
  if (!isGeneratorVersion(identity.generatorVersion)) {
    throw new ShareCodeError(
      "unsupported_generator_version",
      `Unsupported Hullshift generator version: ${String(identity.generatorVersion)}`,
    );
  }
  const payload = canonicalPayload(identity.generatorVersion, identity.seed, identity.difficulty);
  return `${payload}-C${shareCodeChecksum(payload)}`;
}

/**
 * Parse case-insensitively, but never trim or accept separators/whitespace not
 * present in the grammar. The result always carries the one canonical spelling.
 */
export function parseShareCode(input: string): ParsedShareCode {
  if (typeof input !== "string" || input.length > 96 || /\s/.test(input)) {
    throw new ShareCodeError("invalid_format", "Share code has invalid whitespace or length");
  }
  const match = /^HS([0-9]+)-G([A-Z0-9]+)-D([0-9A-Z]+)-S([0-9A-F]{16})-C([0-9A-F]{8})$/i.exec(input);
  if (match === null) {
    throw new ShareCodeError("invalid_format", "Share code does not match the HS1 grammar");
  }

  const shareVersion = Number(match[1]);
  if (!Number.isSafeInteger(shareVersion) || shareVersion !== SHARE_CODE_VERSION) {
    throw new ShareCodeError(
      "unsupported_share_version",
      `Unsupported Hullshift share-code version: ${match[1]}`,
    );
  }

  const generatorVersion = `g${match[2]!.toLowerCase()}`;
  if (!isGeneratorVersion(generatorVersion)) {
    throw new ShareCodeError(
      "unsupported_generator_version",
      `Unsupported Hullshift generator version: ${generatorVersion}`,
    );
  }

  const difficultyText = match[3]!.toLowerCase();
  // parseInt accepts partial strings; the grammar above and round-trip check do not.
  const difficulty = Number.parseInt(difficultyText, 36);
  if (!Number.isSafeInteger(difficulty) || difficulty.toString(36) !== difficultyText) {
    throw new ShareCodeError("invalid_format", "Difficulty is not canonical base36");
  }
  assertDifficulty(difficulty, generatorVersion);

  const seedText = match[4]!.toLowerCase();
  const seed = parseCanonicalSeed(seedText);
  const payload = canonicalPayload(generatorVersion, seed, difficulty);
  const expectedChecksum = shareCodeChecksum(payload);
  if (match[5]!.toLowerCase() !== expectedChecksum) {
    throw new ShareCodeError("invalid_checksum", "Share code checksum does not match");
  }

  return Object.freeze({
    generatorVersion,
    seed,
    difficulty,
    canonicalCode: `${payload}-C${expectedChecksum}`,
    checksum: expectedChecksum,
  });
}

export function isGeneratorVersion(value: unknown): value is GeneratorVersion {
  return value === LEGACY_GENERATOR_VERSION
    || value === FROZEN_GENERATOR_VERSION_G2
    || value === FROZEN_GENERATOR_VERSION_G3
    || value === GENERATOR_VERSION;
}

export function isShareCodeError(error: unknown, code?: ShareCodeErrorCode): error is ShareCodeError {
  return error instanceof ShareCodeError && (code === undefined || error.code === code);
}
