import assert from "node:assert/strict";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { compileFixture, prepareAsh } from "../../scripts/test-ash-runtime.ts";

export type IntegrationCase = { name: string; scope: "fixture" | "protocol" | "http" | "upgrade"; run: () => Promise<void> };
export type Fixture = Awaited<ReturnType<typeof installFixture>>;

export async function session() {
  return (await prepareAsh()).createSession();
}

export async function installFixture(pic: any, name: string, source: string, args: unknown[] = []) {
  const compiled = await compileFixture(name, source);
  const canisterId = await pic.createCanister({ cycles: 100_000_000_000_000n });
  const arg = IDL.encode(compiled.init ? compiled.init({ IDL }) : [], args);
  await pic.installCode({ canisterId, wasm: compiled.wasmPath, arg });
  return { ...compiled, canisterId, actor: pic.createActor(compiled.idlFactory, canisterId) };
}

export function account(owner: Principal) {
  return { owner, subaccount: [] };
}

export function method(fixture: { idlFactory: (input: { IDL: typeof IDL }) => any }, name: string) {
  const service = fixture.idlFactory({ IDL });
  const entry = service._fields.find(([key]: [string, unknown]) => key === name);
  assert.ok(entry, `Method ${name} is present in the compiled Candid`);
  return entry[1];
}

export async function relayCall(relay: Fixture, target: Fixture, name: string, args: unknown[], cycles = 0n) {
  const types = method(target, name);
  const result = await relay.actor.rawCall(target.canisterId, name, IDL.encode(types.argTypes, args), cycles);
  const decoded = IDL.decode(types.retTypes, Uint8Array.from(result));
  return decoded.length === 1 ? decoded[0] : decoded;
}

export async function deferredRelayCall(pic: any, relay: Fixture, target: Fixture, name: string, args: unknown[], cycles = 0n) {
  const types = method(target, name);
  const actor = pic.createDeferredActor(relay.idlFactory, relay.canisterId);
  const receive = await actor.rawCall(target.canisterId, name, IDL.encode(types.argTypes, args), cycles);
  return async () => {
    const bytes = await receive();
    const decoded = IDL.decode(types.retTypes, Uint8Array.from(bytes));
    return decoded.length === 1 ? decoded[0] : decoded;
  };
}

export function ok<T>(result: any): T {
  assert.ok(result && typeof result === "object" && "Ok" in result, `Expected Ok, received ${wire(result)}`);
  return result.Ok;
}

export function wire(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

export async function until(pic: any, condition: () => Promise<boolean>, description: string, rounds = 40) {
  for (let index = 0; index < rounds; index += 1) {
    if (await condition()) return;
    await pic.tick();
  }
  throw new Error(`PocketIC did not reach ${description} after ${rounds} rounds`);
}
