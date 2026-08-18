import Memory "../backend/memory/gemma/v1";

// Fresh installs use the released v1 defaults.
let fresh = Memory.init();
assert fresh.installed;

// The archive transition test proves that 0.2.1 -> 0.2.2 is a compiler
// #keep operation. The same object, including non-default state, must survive.
let installed = Memory.init();
installed.installed := false;
let restored : Memory.Mem = installed;
assert not restored.installed;
restored.installed := true;
assert installed.installed;
