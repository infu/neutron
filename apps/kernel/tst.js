import icblast from "@infu/icblast";
import { unpack, prepare_files, upload_files } from "./src/tools/install.js";
import fs from "fs/promises";

let ic = icblast({});

const neutron = await ic("nzngn-miaaa-aaaag-abrwq-cai");

// console.log("Clearing old files...");
// await neutron.kernel_static({ clear: { prefix: "" } });
// console.log("done");

console.log("Unpacking...");
let unpackaged = await unpack(await fs.readFile("./react.v1.neutron"));

let files = await prepare_files(unpackaged, "mo/", "app/react/");
console.log(files);

function generateRandomUint8Array() {
  // Generate a random length around 300KB
  const randomLength = Math.floor(Math.random() * 20 + 10) * 1024;

  // Create a new Uint8Array of that length
  let array = new Uint8Array(randomLength);

  // Fill the array with random values
  for (let i = 0; i < array.length; i++) {
    array[i] = Math.floor(Math.random() * 256);
  }

  return array;
}

for (let i = 0; i < files.length; i++) {
  files[i].path =
    "app/react/static/js/main.f830f6ac.js.LICENSE.txt" + Math.random();
  files[i].content = generateRandomUint8Array();
}
await upload_files(neutron, files);
