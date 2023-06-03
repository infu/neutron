export function configPermissions(config) {
  let p = [];
  if (config.id === "kernel") p.push({ level: 4, text: "Replace the kernel" });

  const app_memory = config.memory
    ? Object.keys(config.memory).map((x) => "memory_" + x)
    : [];

  if (config.func)
    for (let func in config.func) {
      let f = config.func[func];

      // Check arguments
      if (f.arg)
        for (let arg of f.arg) {
          if (arg.indexOf("this.") === 0) {
            p.push({ level: 2, text: `Actor method '${arg}'` });
          } else if (arg.indexOf("memory_") === 0) {
            if (app_memory.indexOf(arg) === -1) {
              if (arg === "memory_kernel") {
                p.push({ level: 4, text: "Read/Write kernel memory" });
              }
              p.push({
                level: 3,
                text: "Read/Write memory " + arg + " of another application",
              });
            }
          } else if (arg.indexOf("module_") === 0) {
            p.push({ level: 1, text: `Shared module function '${arg}'` });
          } else {
            p.push({ level: 4, text: `Unindentified resource '${arg}'` });
          }
        }
      // Check user allow
      if (f.allow === "any") {
        p.push({ level: 1, text: `Expose function '${func}' to everyone` });
      }
    }

  if (config.memory)
    for (let mem in config.memory) {
      if (mem === "kernel") p.push({ level: 4, text: `Replace kernel memory` });
    }

  return p;
}
