export function assemble(confs) {
  no_inject_config(confs);

  return `
  
// THIS FILE IS AUTOGENERATED
// YOU WILL GET TYPECHECK ERRORS HERE. DON'T EDIT IT
// INSTEAD EDIT YOUR MODULE OR neutron.json
    
  
    ${Object.keys(confs)
      .map((id) => import_module(confs[id]))
      .join("\n")}

shared({caller = _installer}) actor class Class() = this {
 
    ${Object.keys(confs)
      .map((id) => create_module(confs[id]))
      .join("\n")}
      
    kernel.kernel_authorized_add(memory_kernel, _installer);
}
    `;
}

function import_module(conf) {
  const modname = conf.id;
  no_inject(modname);
  no_inject(conf.src);

  return `

import ${modname} "${conf.entry}";
    `;
}

function create_module(conf) {
  const modname = conf.id;
  no_inject(modname);
  if (modname.length < 3)
    throw new Error("Invalid module name (at least 3 characters: " + modname);

  return `
        ${
          conf.memory
            ? Object.keys(conf.memory)
                .map((memid) => {
                  no_inject(memid);
                  const ver = no_inject(conf.memory[memid].version);
                  return `
    type Memory_${memid}_store = {
        #v${ver} : ${modname}.Memory_${memid};
    };

    stable let memory_store_${memid}:Memory_${memid}_store = #v${ver}(${modname}.memory_${memid}());

    let #v${ver}(memory_${memid}) = memory_store_${memid};
        `;
                })
                .join("\n")
            : ""
        }

        ${
          conf.func
            ? Object.keys(conf.func)
                .map((name) => create_func(name, conf.func[name], modname))
                .join("\n")
            : ""
        }
   
        ${
          conf.share
            ? Object.keys(conf.share)
                .map((name) =>
                  create_shared_func(name, conf.share[name], modname)
                )
                .join("\n")
            : ""
        }

    `;
}

function create_shared_func(name, conf, modname) {
  no_inject(name);

  return `
      private func module_${modname}_${name}(req: ${modname}.Input_${name}) : ${
    conf?.async ? "async " : ""
  } ${modname}.Output_${name} {
        ${conf?.async ? "await " : ""} ${modname}.${name}(${
    conf.arg?.length ? conf.arg.map(no_inject).join(",") + "," : ""
  }req)
      };
      `;
}

function create_func(name, conf, modname) {
  no_inject(name);

  return `
    public ${
      conf.type
    }({ caller }) func ${name}(req: ${modname}.Input_${name}) : async ${modname}.Output_${name} {
        ${
          conf.allow !== "any"
            ? "assert(module_kernel_is_authorized(caller));"
            : ""
        }
        ${conf?.async ? "await " : ""} ${modname}.${name}(${
    conf.arg?.length ? conf.arg.map(no_inject).join(",") + "," : ""
  }req)
    };
    `;
}

function no_inject(inp) {
  // check a string for anything other than [a-zA-Z0-9_.]
  if (typeof inp === "boolean") return inp;
  if (typeof inp === "number") return inp;
  if (typeof inp !== "string" || /[^a-zA-Z0-9_.]/.test(inp)) {
    throw new Error("Invalid neutron.json value: " + inp);
  }

  return inp;
}

function no_inject_config(config) {
  if (typeof config === "object" && config !== null) {
    if (Array.isArray(config)) {
      for (let i = 0; i < config.length; i++) {
        no_inject_config(config[i]);
      }
    } else {
      for (let key in config) {
        no_inject(key);
        no_inject_config(config[key]);
      }
    }
  } else {
    no_inject(config);
  }
}
