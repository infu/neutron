import mo from "motoko";
import { assemble } from "./assemble";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema";
import { whitelist } from "neutron-security/whitelist.js";
import { checkForDangerousASTCode } from "neutron-security";

export const compile = ({ mofiles, configs }) => {
  // Add new files to library
  for (let { path, content } of mofiles) {
    mo.write(path, content);
  }

  // validate configs
  for (let id in configs) {
    let config = configs[id];
    let { errors } = validate_neutron_conf(config);
    if (errors.length > 0)
      throw new Error(JSON.stringify(errors.map((x) => x.stack)));
  }

  // check all entrypoints for dangerous code
  let dangers_files = {};
  for (let id in configs) {
    const config = configs[id];

    dangers_files[id] = {};

    const recWalk = (modfn) => {
      if (dangers_files[id][modfn]) return;
      if (whitelist[modfn]) {
        console.log(`${modfn} is whitelisted`);
        return;
      }
      const mofile = mo.read(modfn + ".mo");
      const ast = mo.parseMotoko(mofile);

      let dangers = checkForDangerousASTCode(ast);
      dangers_files[id][modfn] = dangers;

      // get all imports
      let imports = extractImports(ast);
      // for each import, call recWalk
      for (let impfn of imports) {
        recWalk(impfn);
      }
    };

    recWalk(config.entry);
  }

  console.log(dangers_files);

  // assemble new neutron entrypoint
  let neutron_mo = assemble(configs);
  console.log(neutron_mo);
  mo.write("neutron.mo", neutron_mo);

  // compile
  let { wasm, candid } = mo.wasm("neutron.mo", "ic");
  return { wasm, candid, danger: dangers_files };
};

function extractImports(ast) {
  let imports = [];

  function matchTraverseTree(tree) {
    if (tree.name === "ImportE") {
      imports.push(tree.args[0]);
      return;
    }
    if (!Array.isArray(tree.args)) return false;
    for (let node of tree.args) {
      if (typeof node !== "string") {
        if (matchTraverseTree(node)) return true;
      }
    }
    return false;
  }
  matchTraverseTree(ast);

  imports = imports.filter((x) => (x !== "mo:⛔") & (x !== "mo:prim"));

  return imports;
}
