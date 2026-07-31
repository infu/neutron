import {
  Expiry,
  HttpAgent,
  type HttpAgentRequest,
  type HttpAgentRequestTransformFn,
  type Identity,
} from "@dfinity/agent";
import { fileURLToPath } from "node:url";
import {
  resolveLocalNeutronRuntime,
  type LocalNeutronRuntime,
} from "neutron-provision/src/local_session.ts";

const INGRESS_TTL_MS = 4 * 60_000;
const DEFAULT_LOCAL_CONFIG = fileURLToPath(
  new URL("../../../local.ndeploy.json", import.meta.url),
);

export function fixtureLocalRuntime(): LocalNeutronRuntime {
  return resolveLocalNeutronRuntime({
    configPath: process.env.NEUTRON_NDEPLOY_CONFIG ?? DEFAULT_LOCAL_CONFIG,
  });
}

/** Read the sole provision session's authoritative PocketIC clock. */
export async function fixturePocketIcClockMs(host: string): Promise<number> {
  const target = new URL(host);
  const runtime = fixtureLocalRuntime();
  const gateway = new URL(runtime.gatewayUrl);
  if (gateway.origin !== target.origin) {
    throw new Error("Fixture host must match the provision session gateway");
  }
  const url = new URL(
    `instances/${runtime.instanceId}/read/get_time`,
    runtime.controlUrl,
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(url);
    if (response.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    if (!response.ok) {
      throw new Error(`PocketIC get_time failed: HTTP ${response.status}`);
    }
    const payload = record(await response.json());
    const nanos = payload.nanos_since_epoch;
    const milliseconds = typeof nanos === "string"
      ? Number(BigInt(nanos) / 1_000_000n)
      : Math.floor(Number(nanos) / 1_000_000);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("PocketIC get_time returned an invalid clock");
    }
    return milliseconds;
  }
  throw new Error("PocketIC get_time remained busy");
}

/**
 * Build an agent whose ingress expiry follows the authoritative fixture clock.
 * This remains valid after deterministic tests advance PocketIC by hours.
 */
export async function createFixtureAgent(
  host: string,
  identity?: Identity,
): Promise<HttpAgent> {
  const replicaMs = await fixturePocketIcClockMs(host);
  const anchor = { replicaMs, wallMs: Date.now() };
  const agent = new FixtureClockAgent(
    host,
    () => anchor.replicaMs + (Date.now() - anchor.wallMs),
    identity,
  );
  await agent.fetchRootKey();
  return agent;
}

class FixtureClockAgent extends HttpAgent {
  readonly #clock: () => number;

  constructor(host: string, clock: () => number, identity?: Identity) {
    super({
      host,
      ...(identity ? { identity } : {}),
      shouldFetchRootKey: true,
      shouldSyncTime: false,
      verifyQuerySignatures: false,
    });
    this.#clock = clock;
    const transform: HttpAgentRequestTransformFn = async (request) => {
      replaceIngressExpiry(request, this.getTimeDiffMsecs());
      return request;
    };
    this.addTransform("update", transform);
    this.addTransform("query", transform);
  }

  override getTimeDiffMsecs(): number {
    return this.#clock() - Date.now();
  }

  override hasSyncedTime(): boolean {
    return true;
  }
}

function replaceIngressExpiry(request: HttpAgentRequest, driftMs: number): void {
  const body = request.body;
  if (typeof body === "object" && body !== null && "ingress_expiry" in body) {
    body.ingress_expiry = Expiry.fromDeltaInMilliseconds(INGRESS_TTL_MS, driftMs);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PocketIC response is malformed");
  }
  return value as Record<string, unknown>;
}
