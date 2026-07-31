import {
  callTool,
  isJsonObject,
  listEndpoints,
  openAppTile,
  type JsonValue,
  type MsgBusEndpointId,
  type MsgBusToolCall,
  type OpenAppTileRequest,
  type OpenAppTileResult,
} from "neutron-tools/app";

export const CONTACT_PREFILL_TOOL = "prefill_new_contact";

export type ContactHandoffStatus = "ready" | "busy";

export type ContactHandoffDependencies = {
  openTile: (request: OpenAppTileRequest) => Promise<OpenAppTileResult>;
  endpoints: () => Promise<JsonValue>;
  invoke: (call: MsgBusToolCall, timeout: number) => Promise<JsonValue>;
  wait: (milliseconds: number) => Promise<void>;
};

const ENDPOINT_WAIT_DELAYS_MS = [
  0,
  25,
  50,
  100,
  200,
  400,
  800,
  1_000,
  1_500,
  2_000,
] as const;

const defaultDependencies: ContactHandoffDependencies = {
  openTile: (request) => openAppTile(request),
  endpoints: () => listEndpoints(),
  invoke: (request, timeout) => callTool(request, timeout),
  wait: (milliseconds) =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
};

/**
 * Opens/focuses Contacts from the activated Mail click, waits for that exact
 * tile endpoint, then crosses the one kernel-regulated tool boundary. The
 * tool prepares UI only; Contacts remains the sole owner of the Save action.
 */
export async function openPrefilledContact(
  input: {
    suggestedName: string;
    neutronPrincipal: string;
  },
  dependencies: ContactHandoffDependencies = defaultDependencies,
): Promise<ContactHandoffStatus> {
  const opened = await dependencies.openTile({
    appId: "contacts",
    tileId: "contacts",
    reuseExisting: true,
  });
  const endpoint = `app:contacts:tile:contacts:instance:${opened.instanceId}` as MsgBusEndpointId;
  await waitForEndpoint(endpoint, dependencies);
  const result = await dependencies.invoke(
    {
      target: endpoint,
      name: CONTACT_PREFILL_TOOL,
      arguments: {
        suggestedName: input.suggestedName,
        neutronPrincipal: input.neutronPrincipal,
      },
    },
    60,
  );
  if (
    !isJsonObject(result) ||
    (result.status !== "ready" && result.status !== "busy")
  ) {
    throw new Error("Contacts returned an invalid prefill result");
  }
  return result.status;
}

async function waitForEndpoint(
  endpoint: MsgBusEndpointId,
  dependencies: ContactHandoffDependencies,
): Promise<void> {
  let lastError: unknown;
  for (const delay of ENDPOINT_WAIT_DELAYS_MS) {
    if (delay > 0) await dependencies.wait(delay);
    try {
      if (hasConnectedEndpoint(await dependencies.endpoints(), endpoint)) return;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Contacts did not finish opening${detail}`);
}

function hasConnectedEndpoint(value: JsonValue, target: string): boolean {
  if (!isJsonObject(value) || !Array.isArray(value.endpoints)) return false;
  return value.endpoints.some((candidate) => {
    if (!isJsonObject(candidate)) return false;
    return candidate.endpoint === target && candidate.connected === true;
  });
}
