import Hello "../backend/main";
import Memory "../backend/memory/hello/v1";

// Fresh installs use the released v1 default and the backend mutates that
// exact managed root.
let memory = Memory.init();
assert (memory.name == "Neutron");
let first = Hello.Init({ stable_memory = { hello = memory } });
assert (first.hello_world("Persisted Alice") == "Neutron");
assert (memory.name == "Persisted Alice");

// The archive transition test proves that 0.2.1 -> 0.2.2 is #keep. Rebuilding
// the app runtime over the retained root must observe the production value;
// init() must not replace it with "Neutron".
let restored = Hello.Init({ stable_memory = { hello = memory } });
assert (restored.hello_world("Persisted Bob") == "Persisted Alice");
assert (memory.name == "Persisted Bob");
