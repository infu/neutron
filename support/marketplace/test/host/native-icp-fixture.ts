import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { repositoryRoot } from "../../scripts/test-ash-runtime.ts";
import { ledgerIdl } from "./real-ledger.integration.ts";

// DFINITY's native ICP ledger release, distinct from the generic ICRC ledger.
// Official release hashes:
// https://github.com/dfinity/ic/releases/tag/ledger-suite-icp-2025-08-29
// Init interface: rs/ledger_suite/icp/ledger.did at the pinned source commit.
// The upstream ledger inherits Apache-2.0; downloaded Wasm stays in the ignored
// fixture cache and is not bundled with marketplace protocol/app artifacts.
export const NATIVE_ICP_ARTIFACT = {
  release: "ledger-suite-icp-2025-08-29",
  sourceCommit: "69b755062f5ef0a7d6efc9a127172b46121420c8",
  name: "ledger-canister_notify-method.wasm.gz",
  archiveSha256: "51f4be010f23064137defacd627ffbec024c5133210c68ca3b80ab8f257101d6",
  moduleSha256: "fca0a9713133c67edf4ba0375c64afb81561123a4fe2b53b4bac740e7e1048f5",
  candidSha256: "dbbb2c3020186e56bbdd88685dad191af6fe40f89e01ff5c60eb11a972eb86f3",
} as const;
export const ICP_LEDGER = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
export const ICP_FEE = 10_000n;

let pendingArtifact: Promise<Uint8Array> | undefined;
export function nativeIcpWasm(): Promise<Uint8Array> {
  return pendingArtifact ??= (async () => {
    const pin = NATIVE_ICP_ARTIFACT;
    const directory = path.join(repositoryRoot, ".neutron/cache/fixtures", pin.release);
    const filename = path.join(directory, pin.name);
    let bytes: Uint8Array;
    try { bytes = await readFile(filename); }
    catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const response = await fetch(`https://github.com/dfinity/ic/releases/download/${pin.release}/${pin.name}`);
      assert.ok(response.ok, `Required native ICP fixture download failed: HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.archiveSha256, "Official native ICP archive hash");
      await mkdir(directory, { recursive: true });
      await writeFile(filename, bytes);
    }
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.archiveSha256, "Cached native ICP archive hash; never skip or substitute an unverified fixture");
    const wasm = gunzipSync(bytes);
    assert.equal(createHash("sha256").update(wasm).digest("hex"), pin.moduleSha256, "Native ICP uncompressed module hash");
    console.log(`Official native ICP ${pin.release}; archive sha256=${pin.archiveSha256}; module sha256=${createHash("sha256").update(wasm).digest("hex")}`);
    return new Uint8Array(wasm);
  })();
}

// Legacy minting_account and modern icrc1_minting_account must identify the
// same account in this ledger's init payload. No legacy transfer/read method
// is needed for marketplace payment or recovery.
function accountIdentifier(owner: Principal): string {
  const hash = createHash("sha224").update(Buffer.from("\x0aaccount-id"))
    .update(owner.toUint8Array()).update(new Uint8Array(32)).digest();
  let crc = 0xffffffff;
  for (const byte of hash) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([prefix, hash]).toString("hex");
}

function initArguments(minter: Principal): Uint8Array {
  const account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
  const tokens = IDL.Record({ e8s: IDL.Nat64 });
  const archive = IDL.Record({
    trigger_threshold: IDL.Nat64, num_blocks_to_archive: IDL.Nat64,
    node_max_memory_size_bytes: IDL.Opt(IDL.Nat64), max_message_size_bytes: IDL.Opt(IDL.Nat64),
    controller_id: IDL.Principal, more_controller_ids: IDL.Opt(IDL.Vec(IDL.Principal)),
    cycles_for_archive_creation: IDL.Opt(IDL.Nat64), max_transactions_per_response: IDL.Opt(IDL.Nat64),
  });
  const init = IDL.Record({
    minting_account: IDL.Text, icrc1_minting_account: IDL.Opt(account),
    initial_values: IDL.Vec(IDL.Tuple(IDL.Text, tokens)),
    max_message_size_bytes: IDL.Opt(IDL.Nat64),
    transaction_window: IDL.Opt(IDL.Record({ secs: IDL.Nat64, nanos: IDL.Nat32 })),
    archive_options: IDL.Opt(archive), send_whitelist: IDL.Vec(IDL.Principal),
    transfer_fee: IDL.Opt(tokens), token_symbol: IDL.Opt(IDL.Text), token_name: IDL.Opt(IDL.Text),
    feature_flags: IDL.Opt(IDL.Record({ icrc2: IDL.Bool })),
  });
  return IDL.encode([IDL.Variant({ Init: init })], [{ Init: {
    minting_account: accountIdentifier(minter), icrc1_minting_account: [{ owner: minter, subaccount: [] }],
    initial_values: [], max_message_size_bytes: [], transaction_window: [], archive_options: [],
    send_whitelist: [], transfer_fee: [{ e8s: ICP_FEE }], token_symbol: ["ICP"], token_name: ["Internet Computer"],
    feature_flags: [{ icrc2: true }],
  } }]);
}

export async function installNativeIcp(pic: any, minter: Principal) {
  const canisterId = await pic.createCanister({ targetCanisterId: ICP_LEDGER, cycles: 100_000_000_000_000n });
  assert.equal(canisterId.toText(), ICP_LEDGER.toText());
  await pic.installCode({ canisterId, wasm: await nativeIcpWasm(), arg: initArguments(minter) });
  const actor = pic.createActor(ledgerIdl, canisterId);
  assert.equal(await actor.icrc1_decimals(), 8);
  assert.equal(await actor.icrc1_fee(), ICP_FEE);
  return { canisterId, actor, idlFactory: ledgerIdl };
}
