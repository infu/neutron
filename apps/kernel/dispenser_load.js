import icblast, { fileIdentity } from "@infu/icblast";
import { unpack, prepare_files, upload_files } from "./src/tools/install.js";
import fs from "fs/promises";
import { promisify } from "util";
import msgpack from "tiny-msgpack";
import plimit from "p-limit";
import { mime } from "./src/tools/mime.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { gunzipSync, gzipSync } from "fflate";
import { exec as callbackExec } from "child_process";
const exec = promisify(callbackExec);

const identity = fileIdentity(0);
let ic = icblast({ identity });

console.log("This scripts principal: ", identity.getPrincipal().toText());

let dispenser = await ic("wbahd-yaaaa-aaaam-abpaq-cai");

// compile
let dfx_dir = (await exec("dfx cache show")).stdout.trim();
let dfx_sources = (await exec("mops sources")).stdout
  .trim()
  .replace(/\n/gs, " ");
await exec(
  `${dfx_dir}/moc --idl ${dfx_sources} -o _neutron_build backend/_neutron.mo`
);

let wasmB = await fs.readFile("./_neutron_build");
const wasm = new Uint8Array(wasmB);

await fs.unlink("./_neutron_build");
await fs.unlink("./_neutron_build.did");

await dispenser.set_wasm(wasm);

await dispenser.clear_files();

console.log("Unpacking...");
let unpackaged;
try {
  unpackaged = await unpack(await fs.readFile("./kernel.v1.neutron"));
} catch (e) {
  console.error(e);
  process.exit(1);
}

let files = await prepare_files(false, unpackaged, "kernel", "mo/", "", "");

const limit = plimit(30); // Max concurrent requests

await Promise.all(
  files.map(async ({ path, content }) =>
    limit(async () => {
      const filebin = content;

      let content_type = mime(path);
      if (!content_type) content_type = "application/octet-stream";
      const content_encoding =
        content_type.indexOf("image/") === -1 ? "gzip" : "plain"; // not sure why plain binary is called 'identity'?
      const processed_file =
        content_encoding === "gzip" ? gzipSync(filebin) : filebin;

      await dispenser.add_file("/" + (path === "index.html" ? "" : path), {
        content: processed_file,
        content_type,
        content_encoding,
      });

      console.log("Uploaded ", path);
    })
  )
).then((x) => x.flat());

const appconfig = {
  kernel: { link: "/", name: "Neutron", icon: "/static/icon.png" },
};

await dispenser.addfile("/system/apps.json", {
  content: new TextEncoder().encode(JSON.stringify(appconfig)),
  content_type: "application/json",
  content_encoding: "plain",
});
