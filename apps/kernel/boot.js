import icblast, { fileIdentity } from "@infu/icblast";
import { unpack, prepare_files, upload_files } from "./src/tools/install.js";
import fs from "fs/promises";
import { exec as callbackExec } from "child_process";
import { promisify } from "util";

const exec = promisify(callbackExec);

const conf = JSON.parse(await fs.readFile("./neutron.json", "utf8"));

let can_ids = await fs.readFile(".dfx/local/canister_ids.json", "utf8");
let can_ids_json = JSON.parse(can_ids);
let neutron_can_id = can_ids_json.neutron.local;
const identity = fileIdentity(0);
const ic = icblast({
  local: true,
  identity,
  local_host: "http://localhost:8080",
});

console.log("This scripts principal: ", identity.getPrincipal().toText());
let neutron = await ic(neutron_can_id);

await exec(
  `dfx canister call neutron kernel_authorized_add '(principal "${identity
    .getPrincipal()
    .toText()}")'\n`
);
// console.log(
//   `Set your icblast identity as controller\n dfx canister call neutron kernel_authorized_add '(principal
//     "${identity.getPrincipal().toText()}")'\n`
// );

// Delete everything
console.log("Clearing old files...");
await neutron.kernel_static({ clear: { prefix: "" } });
console.log("done");

console.log("Unpacking...");
let unpackaged;
try {
  unpackaged = await unpack(await fs.readFile("./kernel.v1.neutron"));
} catch (e) {
  console.error(e);
  process.exit(1);
}

let files = await prepare_files(unpackaged, "mo/", "");
await upload_files(neutron, files);

// create apps.json
const appconfig = {
  kernel: { link: "/", name: conf.name, icon: "/static/icon.png" },
};

await neutron.kernel_static({
  store: {
    key: "/system/apps.json",
    val: {
      content: new TextEncoder().encode(JSON.stringify(appconfig)),
      content_type: "application/json",
      content_encoding: "plain",
      chunks: 1,
    },
  },
});

await neutron.kernel_static({
  store: {
    key: "/pkg/id.json",
    val: {
      content: new TextEncoder().encode(JSON.stringify({ id: neutron_can_id })),
      content_type: "application/json",
      content_encoding: "plain",
      chunks: 1,
    },
  },
});

// let unpackaged2 = await unpack(
//   await fs.readFile("../hello/neutron_hello.1_0_0.neutron")
// );

// await upload_files(neutron, files2);

// let list = await neutron.kernel_static_query({ list: { prefix: "" } });
// list = list.filter((x) => x[0].indexOf("/dist/mo") !== 0);
// console.log(list);
