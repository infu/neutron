import Memory "../backend/memory/agent/v1";

// Fresh installs use the released v1 defaults.
let fresh = Memory.init();
assert fresh.installed;

// The archive transition test proves that 0.3.1 -> 0.3.2 is a compiler
// #keep operation. Model that operation with representative non-default data:
// the existing object is reused and init() is not called again.
let installed = Memory.init();
installed.installed := false;
let restored : Memory.Mem = installed;
assert not restored.installed;
restored.installed := true;
assert installed.installed;
