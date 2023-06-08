import fs from "fs/promises";
import { assemble } from "neutron-compiler/src/assemble.js";
import { exec as callbackExec } from "child_process";
import { promisify } from "util";
const exec = promisify(callbackExec);

let conf = JSON.parse(await fs.readFile("neutron.json", "utf8"));
conf.entry = conf.src.replace(".mo", "");
let t = assemble([conf]);

fs.writeFile("./backend/_neutron.mo", t);

// create DID
let dfx_dir = (await exec("dfx cache show")).stdout.trim();
let dfx_sources = (await exec("mops sources")).stdout.trim().replace("\n", " ");
await exec(
  `${dfx_dir}/moc --idl ${dfx_sources} -o dist/neutron backend/_neutron.mo`
);

await fs.unlink("./dist/neutron");
