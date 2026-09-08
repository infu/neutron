/**
 * Local development helper: put a real Taggr canister next to a local Neutron.
 *
 * The Neutron provisioner deploys Neutron nodes only, so this script installs
 * Taggr into the same supervised PocketIC instance through its HTTP gateway. It
 * touches no kernel, compiler, or provisioner source — it reads the
 * provisioner's session journal for the gateway URL and then talks to the
 * replica like any other client.
 *
 *   bun scripts/local_taggr.ts install                 create and install Taggr
 *   bun scripts/local_taggr.ts info                    show the recorded ids
 *   bun scripts/local_taggr.ts fund <principal> [icp]  pay a Taggr ICP invoice
 *   bun scripts/local_taggr.ts call <method> [json]    raw update call
 *
 * Build the wasm first, from a Taggr checkout:
 *   FEATURES=dev bash build.sh bucket && FEATURES=dev bash build.sh taggr
 * then point this script at it with TAGGR_WASM=<path to taggr.wasm.gz>.
 *
 * For a self-contained check that does not need the provisioner at all, use
 * `scripts/verify_contract.ts`, which starts its own replica.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnonymousIdentity, HttpAgent, polling } from "@dfinity/agent";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { IDL } from "@dfinity/candid";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const configPath = path.resolve(
  repoRoot,
  process.env.NDEPLOY_CONFIG ?? "taggr-local.ndeploy.json",
);
const sessionPath = configPath.replace(/\.json$/, ".session.json");
const statePath = path.resolve(repoRoot, "apps/taggr/.local-taggr.json");

const ICP_LEDGER = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
const MANAGEMENT = Principal.fromText("aaaaa-aa");
/** PocketIC mints these out of thin air. */
const CANISTER_CYCLES = 100_000_000_000_000n;

type LocalState = { canisterId: string; identity: unknown };

/* ------------------------------------------------------------------ */

async function gatewayUrl(): Promise<string> {
  const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
    runtime?: { kind?: string; gateway?: { url?: string } };
  };
  const url = session.runtime?.gateway?.url;
  if (session.runtime?.kind !== "pocketic" || !url) {
    throw new Error(
      `${sessionPath} has no PocketIC gateway. Run the provisioner's serve and reinstall first.`,
    );
  }
  return url;
}

const agentFor = async (
  identity: AnonymousIdentity | Ed25519KeyIdentity,
): Promise<HttpAgent> =>
  HttpAgent.create({ host: await gatewayUrl(), identity, shouldFetchRootKey: true });

async function loadState(): Promise<LocalState> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as LocalState;
  } catch {
    throw new Error("No local Taggr recorded yet. Run `install` first.");
  }
}

const settingsType = IDL.Record({
  controllers: IDL.Opt(IDL.Vec(IDL.Principal)),
  compute_allocation: IDL.Opt(IDL.Nat),
  memory_allocation: IDL.Opt(IDL.Nat),
  freezing_threshold: IDL.Opt(IDL.Nat),
  reserved_cycles_limit: IDL.Opt(IDL.Nat),
  log_visibility: IDL.Opt(IDL.Variant({ controllers: IDL.Null, public: IDL.Null })),
  wasm_memory_limit: IDL.Opt(IDL.Nat),
  wasm_memory_threshold: IDL.Opt(IDL.Nat),
});

async function callRaw(
  agent: HttpAgent,
  canisterId: Principal,
  methodName: string,
  arg: Uint8Array,
  effectiveCanisterId?: Principal,
): Promise<Uint8Array> {
  const target = effectiveCanisterId ?? canisterId;
  const { requestId } = await agent.call(canisterId, {
    methodName,
    arg,
    ...(effectiveCanisterId ? { effectiveCanisterId } : {}),
  });
  const { reply } = await polling.pollForResponse(agent, target, requestId);
  return reply;
}

/** Taggr's own wire: raw UTF-8 JSON in, raw UTF-8 JSON out. No Candid. */
const jsonArg = (payload: string): Uint8Array => new TextEncoder().encode(payload);

/**
 * Taggr's ICP invoice subaccount, from `env::invoices::principal_to_subaccount`:
 * one length byte, then the principal, zero-padded to 32 bytes.
 */
function principalToSubaccount(owner: Principal): Uint8Array {
  const bytes = owner.toUint8Array();
  const subaccount = new Uint8Array(32);
  subaccount[0] = bytes.length;
  subaccount.set(bytes, 1);
  return subaccount;
}

/* ------------------------------------------------------------------ */

async function install(): Promise<void> {
  const wasmPath = process.env.TAGGR_WASM;
  if (!wasmPath) {
    throw new Error(
      "Set TAGGR_WASM to a taggr.wasm.gz built from a Taggr checkout with FEATURES=dev.",
    );
  }
  const wasm = new Uint8Array(await readFile(path.resolve(repoRoot, wasmPath)));
  const identity = Ed25519KeyIdentity.generate();
  const agent = await agentFor(identity);

  // The effective canister id for creation must sit on the target subnet; the
  // Neutron node's own id is a canister the provisioner already placed there.
  const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
    localFleet?: { nodes?: Array<{ canisterId: string }> };
  };
  const anchor = session.localFleet?.nodes?.[0]?.canisterId;
  if (!anchor) throw new Error("The session journal lists no local Neutron node yet.");
  const effective = Principal.fromText(anchor);

  const createdBytes = await callRaw(
    agent,
    MANAGEMENT,
    "provisional_create_canister_with_cycles",
    IDL.encode(
      [
        IDL.Record({
          amount: IDL.Opt(IDL.Nat),
          settings: IDL.Opt(settingsType),
          specified_id: IDL.Opt(IDL.Principal),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [
        {
          amount: [CANISTER_CYCLES],
          settings: [
            {
              controllers: [[identity.getPrincipal()]],
              compute_allocation: [],
              memory_allocation: [],
              freezing_threshold: [],
              reserved_cycles_limit: [],
              log_visibility: [],
              wasm_memory_limit: [],
              wasm_memory_threshold: [],
            },
          ],
          specified_id: [],
          sender_canister_version: [],
        },
      ],
    ),
    effective,
  );
  const { canister_id } = IDL.decode(
    [IDL.Record({ canister_id: IDL.Principal })],
    createdBytes,
  )[0] as unknown as { canister_id: Principal };

  await callRaw(
    agent,
    MANAGEMENT,
    "install_code",
    IDL.encode(
      [
        IDL.Record({
          mode: IDL.Variant({
            install: IDL.Null,
            reinstall: IDL.Null,
            upgrade: IDL.Opt(IDL.Null),
          }),
          canister_id: IDL.Principal,
          wasm_module: IDL.Vec(IDL.Nat8),
          arg: IDL.Vec(IDL.Nat8),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [
        {
          mode: { install: null },
          canister_id,
          wasm_module: wasm,
          arg: new Uint8Array(),
          sender_canister_version: [],
        },
      ],
    ),
    canister_id,
  );

  const state: LocalState = {
    canisterId: canister_id.toText(),
    identity: identity.toJSON(),
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`Taggr installed at ${state.canisterId}`);
  console.log("Set that canister in the Taggr app's Settings, then approve its reservations.");
}

async function info(): Promise<void> {
  const state = await loadState();
  const identity = Ed25519KeyIdentity.fromJSON(JSON.stringify(state.identity));
  console.log(`gateway:    ${await gatewayUrl()}`);
  console.log(`taggr:      ${state.canisterId}`);
  console.log(`controller: ${identity.getPrincipal().toText()}`);
}

async function fund(target: string, whole = "5"): Promise<void> {
  const state = await loadState();
  const owner = Principal.fromText(target);
  const agent = await agentFor(new AnonymousIdentity());
  const account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  // PocketIC's ICP feature mints from the anonymous principal, which is how the
  // Neutron provisioner funds local balances too.
  const replyBytes = await callRaw(
    agent,
    ICP_LEDGER,
    "icrc1_transfer",
    IDL.encode(
      [
        IDL.Record({
          to: account,
          fee: IDL.Opt(IDL.Nat),
          memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
          from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          created_at_time: IDL.Opt(IDL.Nat64),
          amount: IDL.Nat,
        }),
      ],
      [
        {
          to: {
            owner: Principal.fromText(state.canisterId),
            subaccount: [principalToSubaccount(owner)],
          },
          fee: [],
          memo: [],
          from_subaccount: [],
          created_at_time: [],
          amount: BigInt(Math.round(Number(whole) * 1e8)),
        },
      ],
    ),
  );
  const result = IDL.decode(
    [IDL.Variant({ Ok: IDL.Nat, Err: IDL.Unknown })],
    replyBytes,
  )[0] as unknown as { Ok?: bigint; Err?: unknown };
  if (result.Err !== undefined) {
    throw new Error(`ICP transfer failed: ${JSON.stringify(result.Err)}`);
  }
  console.log(`Paid ${whole} ICP into Taggr's invoice account for ${target}.`);
  console.log("The app can now mint credits and register that principal.");
}

async function call(method: string, payload = "null"): Promise<void> {
  const state = await loadState();
  const identity = Ed25519KeyIdentity.fromJSON(JSON.stringify(state.identity));
  const agent = await agentFor(identity);
  const canisterId = Principal.fromText(state.canisterId);
  const reply = await callRaw(agent, canisterId, method, jsonArg(payload));
  console.log(new TextDecoder().decode(reply));
}

/* ------------------------------------------------------------------ */

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "install":
      await install();
      break;
    case "info":
      await info();
      break;
    case "fund":
      if (!rest[0]) throw new Error("Usage: fund <principal> [icp]");
      await fund(rest[0], rest[1]);
      break;
    case "call":
      if (!rest[0]) throw new Error("Usage: call <method> [json]");
      await call(rest[0], rest[1]);
      break;
    default:
      throw new Error("Usage: local_taggr.ts install | info | fund | call");
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
