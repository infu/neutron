import Spreadsheet "../backend/main";
import Memory "../backend/memory/spreadsheet/v1";

// Fresh installs use the released v1 default.
let fresh = Memory.init();
assert fresh.installed;

// Spreadsheet 0.3.1 already runs v1. The archive transition test proves the
// license-only 0.3.2 release is #keep, so init() cannot replace retained data.
fresh.installed := false;
let restored : Memory.Mem = fresh;
let _backend = Spreadsheet.Init({
    stable_memory = { spreadsheet = restored };
});
assert not restored.installed;
restored.installed := true;
assert fresh.installed;
