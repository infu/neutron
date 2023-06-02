import icblast, { fileIdentity } from "@infu/icblast";
import { prepare_files, upload_files } from "./src/tools/install.js";
import fs from "fs/promises";

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

console.log(
  `Set your icblast identity as controller\n dfx canister call neutron authorized_add '(principal
    "${identity.getPrincipal().toText()}")'\n`
);

// Delete everything
await neutron.kernel_static({ clear: { prefix: "" } });

let files = await prepare_files(
  neutron,
  await fs.readFile("./neutron_kernel.1_0_0.neutron"),
  "kernel",
  "mo/",
  "",
  neutron_can_id
);
await upload_files(neutron, files);

let files2 = await prepare_files(
  neutron,
  await fs.readFile("../hello/neutron_hello.1_0_0.neutron"),
  "hello",
  "mo/",
  "hello/",
  neutron_can_id
);
await upload_files(neutron, files2);

// let list = await neutron.kernel_static_query({ list: { prefix: "" } });
// list = list.filter((x) => x[0].indexOf("/dist/mo") !== 0);
// console.log(list);
