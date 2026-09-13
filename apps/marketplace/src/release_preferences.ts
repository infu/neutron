import type { MsgBusToolContext } from "neutron-tools/app";

export type ReleasePreferences = Readonly<{ betaEnabled: boolean; revision: string }>;

const legacyPreferences: ReleasePreferences = Object.freeze({ betaEnabled: false, revision: "0" });

export function parseReleasePreferences(value: unknown): ReleasePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kernel release preferences are invalid. Refresh before selecting a release.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.betaEnabled !== "boolean" ||
    typeof record.revision !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(record.revision)
  ) {
    throw new Error("Kernel release preferences are invalid. Refresh before selecting a release.");
  }
  return Object.freeze({ betaEnabled: record.betaEnabled, revision: record.revision });
}

/** Read the Neutron authority afresh for each selection or pre-dispatch check. */
export async function readReleasePreferences(
  context: Pick<MsgBusToolContext, "kernel" | "signal">,
): Promise<ReleasePreferences> {
  context.signal?.throwIfAborted();
  const tools: unknown = await context.kernel.listTools("kernel");
  context.signal?.throwIfAborted();
  if (!Array.isArray(tools) || tools.some(tool =>
    !tool || typeof tool !== "object" || Array.isArray(tool) || typeof tool.name !== "string" || !tool.name,
  )) {
    throw new Error("Kernel release preference discovery is invalid. Refresh before selecting a release.");
  }
  // Only a successful discovery response establishes legacy stable-only
  // support. Once advertised, any failed or malformed preference read fails.
  if (!tools.some(tool => tool.name === "updates.preferences")) return legacyPreferences;
  const value = await context.kernel.callTool({ target: "kernel", name: "updates.preferences", arguments: {} }, 0);
  context.signal?.throwIfAborted();
  return parseReleasePreferences(value);
}

export function releasePreferencesEqual(left: ReleasePreferences, right: ReleasePreferences): boolean {
  return left.betaEnabled === right.betaEnabled && left.revision === right.revision;
}

/** Gate new dispatch only; submitted financial requests retain their identities. */
export function assertReleasePreferencesUnchanged(expected: ReleasePreferences, current: ReleasePreferences): void {
  if (!releasePreferencesEqual(expected, current)) {
    throw new Error("Beta updates changed. Refresh the release selection before continuing.");
  }
}

export async function assertReleasePreferences(
  context: Pick<MsgBusToolContext, "kernel" | "signal">,
  expected: ReleasePreferences,
): Promise<void> {
  assertReleasePreferencesUnchanged(expected, await readReleasePreferences(context));
}
