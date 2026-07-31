import { Actor, type Agent } from "@dfinity/agent";
import { getNeutronCan, getNeutronDynamicCan } from "./reducer/auth.ts";
import { submitRawSelfUpdate as submitRawSelfUpdateTransport } from "./raw_self_update.ts";

/**
 * Keep authenticated actor/agent plumbing separate from self-call policy and
 * framing. Tests replace this network boundary while exercising the private
 * port router, Candid encoder, pre-decode meters, and normalizers.
 */
export async function getSelfCallTarget(): Promise<any> {
  return getNeutronDynamicCan();
}

export async function getSelfCallAgent(): Promise<Agent> {
  const bootstrapActor = await getNeutronCan();
  const agent = Actor.agentOf(bootstrapActor as unknown as Actor);
  if (!agent) throw new Error("Authenticated Neutron agent is unavailable");
  return agent;
}

export async function submitRawSelfUpdate(
  agent: Agent,
  canisterId: string,
  methodName: string,
  arg: Uint8Array,
): Promise<Uint8Array> {
  return submitRawSelfUpdateTransport(
    agent,
    canisterId,
    methodName,
    arg,
  );
}
