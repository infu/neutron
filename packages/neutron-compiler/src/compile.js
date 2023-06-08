import mo from "motoko";
import { assemble } from "./assemble";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema";

export const compile = ({ mofiles, configs }) => {
  // collect all mo modules
  // let mo_lib = await collect();

  // get all app configs
  // const apps = getState().apps.list;

  // const configs = Object.assign(
  //   {},
  //   ...(await Promise.all(
  //     ["kernel", ...Object.keys(apps)].map((id) =>
  //       fetch(
  //         id === "kernel"
  //           ? "/pkg/neutron.json"
  //           : "/app/" + id + "/pkg/neutron.json"
  //       ).then(async (x) => ({
  //         [id]: await x.json(),
  //       }))
  //     )
  //   ))
  // );

  // Add new config
  // configs[neutronConfig.id] = neutronConfig;

  // Add new files to library
  for (let { path, content } of mofiles) {
    // if path doesn't start with "mo/" then ignore
    //   if (path.indexOf("mo/") !== 0) continue;
    //   let contentText = new TextDecoder().decode(content);
    //   const p = path.replace("mo/", "");
    mo.write(path, content);
  }

  //   console.log(configs);

  // validate configs
  for (let id in configs) {
    let config = configs[id];
    let { errors } = validate_neutron_conf(config);
    if (errors.length > 0)
      throw new Error(JSON.stringify(errors.map((x) => x.stack)));
  }

  // assemble new neutron entrypoint
  let neutron_mo = assemble(configs);
  console.log(neutron_mo);
  mo.write("neutron.mo", neutron_mo);

  // load libraries
  // for (let { path, content } of mo_lib) {
  //   const p = path.replace("/mo/", "");
  //   mo.write(p, content);
  // }

  // compile
  let compiled = mo.wasm("neutron.mo", "ic");
  return compiled;
  // dlFileDebug(compile_details.wasm);
  // console.log("WASM", compile_details);

  // dispatch(
  //   setCompiled({ size: Math.ceil(compile_details.wasm.length / 1024) })
  // );
};
