export function assemble(conf) {
  no_inject_config(conf);

  return `
  
// THIS FILE IS AUTOGENERATED
// YOU WILL GET TYPECHECK ERRORS HERE, BUT YOU CAN'T EDIT IT
// INSTEAD EDIT YOUR MODULE or neutron.json
    
    ${Object.keys(conf.modules)
      .map((mod) => import_module(mod, conf.modules[mod]))
      .join("\n")}

shared({caller = _installer}) actor class Class() = this {
    
  let { phash } = Set;
  stable let authorized = Set.fromIter([_installer].vals(), phash);

  public shared({caller}) func authorized_add(id : Principal) : async () {
    assert(Set.has(authorized, phash, caller));
    ignore Set.add(authorized, phash, id);
  };

  public shared({caller}) func authorized_rem(id : Principal) : async () {
    assert(Set.has(authorized, phash, caller));
    ignore Set.remove(authorized, phash, id);
  };

    ${Object.keys(conf.modules)
      .map((mod) => create_module(mod, conf.modules[mod]))
      .join("\n")}
}
    `;
}

function import_module(modname, conf) {
  no_inject(modname);
  no_inject(conf.src);

  return `
import Set "mo:motoko-hash-map/Set";
import ${modname} "./${conf.src.replace(".mo", "")}";
    `;
}

function create_module(modname, conf) {
  no_inject(modname);
  if (modname.length < 3)
    throw new Error("Invalid module name (at least 3 characters: " + modname);
  return `
        ${Object.keys(conf.memory)
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
          .join("\n")}

        ${Object.keys(conf.func)
          .map((name) => create_func(name, conf.func[name], modname))
          .join("\n")}
   
        ${Object.keys(conf.share)
          .map((name) => create_shared_func(name, conf.share[name], modname))
          .join("\n")}

    `;
}

function create_shared_func(name, conf, modname) {
  no_inject(name);

  return `
      private func module_${modname}_${name}(req: ${modname}.Input_${name}) : ${modname}.Output_${name} {
          ${modname}.${name}(${
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
            ? "assert(Set.has(authorized, phash, caller));"
            : ""
        }
        ${modname}.${name}(${
    conf.arg?.length ? conf.arg.map(no_inject).join(",") + "," : ""
  }req)
    };
    `;
}

function no_inject(inp) {
  // check a string for anything other than [a-zA-Z0-9_.]
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
