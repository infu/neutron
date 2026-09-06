import { expect } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { loadMotoko, disposeMotokoCompiler } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.ts";
import { parsePackageString } from "neutron-scripts/src/walk.ts";
import type { DirectPocketIcClient } from "../legacy_kernel_upgrade.pocketic.test.ts";
import { repositoryRoot } from "./archives.ts";

// Compile only scripted, local test actors. These files never enter a release archive.
export async function compileLocalFixture(sourcePath: string, packageAppRoot = path.join(repositoryRoot, "apps/wallet")): Promise<Uint8Array> {
  const cwd = packageAppRoot;
  const source = await promisify(execFile)("mops", ["sources"], { cwd });
  const packages = Object.fromEntries(Object.entries(parsePackageString(source.stdout.replace(/\n/g, " ").trim())).map(([name, value]) => [name, path.resolve(cwd, value)]));
  const compiler = await loadMotoko();
  try {
    const prepared = await prepareMotokoProgram({ compiler, sourcePath, packages, allowDangerous: true });
    return (await compiler.wasm(prepared.entryPath, "ic")).wasm;
  } finally { await disposeMotokoCompiler(); }
}

export async function installLocalFixture(client: DirectPocketIcClient, instanceId: number, deployer: Principal, wasm: Uint8Array, target: Principal): Promise<void> {
  const create = IDL.Func([IDL.Record({ amount: IDL.Opt(IDL.Nat), settings: IDL.Opt(IDL.Record({ controllers: IDL.Opt(IDL.Vec(IDL.Principal)) })), specified_id: IDL.Opt(IDL.Principal), sender_canister_version: IDL.Opt(IDL.Nat64) })], [IDL.Record({ canister_id: IDL.Principal })], []);
  const install = IDL.Func([IDL.Record({ mode: IDL.Variant({ install: IDL.Null }), canister_id: IDL.Principal, wasm_module: IDL.Vec(IDL.Nat8), arg: IDL.Vec(IDL.Nat8), sender_canister_version: IDL.Opt(IDL.Nat64) })], [], []);
  const management = async (name: string, method: IDL.FuncClass, args: unknown[], target: Principal): Promise<unknown> => {
    const submitted = await client.submitIngressMessage(instanceId, {
      canisterId: Principal.fromText("aaaaa-aa"), sender: deployer, method: name,
      payload: new Uint8Array(IDL.encode(method.argTypes, args)), effectivePrincipal: { CanisterId: Buffer.from(target.toUint8Array()).toString("base64") },
    });
    const bytes = await client.awaitIngressMessage(instanceId, submitted);
    return IDL.decode(method.retTypes, bytes)[0];
  };
  const created = await management("provisional_create_canister_with_cycles", create, [{ amount: [100_000_000_000_000n], settings: [{ controllers: [[deployer]] }], specified_id: [target], sender_canister_version: [] }], target) as { canister_id: Principal };
  expect(created.canister_id.toText()).toBe(target.toText());
  await management("install_code", install, [{ mode: { install: null }, canister_id: target, wasm_module: wasm, arg: new Uint8Array(IDL.encode([], [])), sender_canister_version: [] }], target);
}
