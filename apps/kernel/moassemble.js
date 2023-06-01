import fs from "fs/promises";
import { assemble } from "./src/tools/assemble.js";

let conf = JSON.parse(await fs.readFile("neutron.json", "utf8"));

let t = assemble(conf, []);

fs.writeFile("./backend/_neutron.mo", t);
