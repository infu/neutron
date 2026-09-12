import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Principal } from "@dfinity/principal";
import { PROTOCOL_CANISTER, PROTOCOL_HOST } from "../src/config.ts";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("neutron.json", root), "utf8"));
const backendConfig = await readFile(new URL("backend/config.mo", root), "utf8");
const principal = Principal.fromText(PROTOCOL_CANISTER);
assert.ok(!principal.isAnonymous() && !["aaaaa-aa", "rrkah-fqaaa-aaaaa-aaaaq-cai"].includes(principal.toText()), "Pin the deployed Feedback protocol before packaging");
assert.equal(PROTOCOL_HOST, "https://icp-api.io");
assert.ok(backendConfig.includes(`"${PROTOCOL_CANISTER}"`), "Backend and frontend protocol targets differ");
assert.equal(manifest.update_source, "sj2r4-haaaa-aaaay-aadgq-cai");
for (const reservation of manifest.capabilities.backend_calls.install_reservations) {
  assert.equal(reservation.kind, "exact");
  assert.equal(reservation.principal, PROTOCOL_CANISTER);
}
console.log(`Feedback release targets protocol ${PROTOCOL_CANISTER}`);
