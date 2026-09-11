/** Generic source access V1; ownership and price policy remain at the source. */
export const REPOSITORY_ACCESS_PATH = "/repo/v1/access.json";
export const REPOSITORY_ACCESS_PROTOCOL = "neutron-repo-access-v1";

export type RepositoryAccessDescriptor = Readonly<{
  protocol: typeof REPOSITORY_ACCESS_PROTOCOL;
  fee_version: string;
  cycles: string;
}>;

export type RepositoryAccessRequest = Readonly<{
  request_id: string;
  token: string;
  paths: readonly string[];
  fee_version: bigint;
}>;

export type RepositoryAccessResult =
  | { ok: { request_id: string; paths: string[]; accepted_cycles: bigint } }
  | { err: { code: string; message: string } };

export type RepositoryAccessReply = Readonly<{
  result: RepositoryAccessResult;
  /** None when a native rejected/interrupted call cannot expose its refund. */
  charged_cycles: [] | [bigint];
}>;

export function isRepositoryResourcePath(path: string): boolean {
  return /^\/repo\/v1\/(?:packages\/[0-9a-f]{64}\.neutron|sources\/[0-9a-f]{64}\.source\.v1\.msgpack\.gz)$/u.test(path);
}

export function parseRepositoryAccessDescriptor(value: unknown): RepositoryAccessDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The source access description must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "cycles,fee_version,protocol" ||
    record.protocol !== REPOSITORY_ACCESS_PROTOCOL ||
    typeof record.cycles !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(record.cycles) ||
    typeof record.fee_version !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(record.fee_version)
  ) {
    throw new Error("The source access description is not a supported V1 record.");
  }
  return Object.freeze(record as RepositoryAccessDescriptor);
}
