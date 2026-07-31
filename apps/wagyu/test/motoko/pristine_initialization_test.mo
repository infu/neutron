import Memory "../../backend/memory/wagyu/v3";
import PristineMemory "../../backend/memory/Pristine";

let pristine = Memory.init();
assert (PristineMemory.isPristineForBinding(pristine));

// #uninitialized is not permission to relabel unrelated durable state.
let revised = Memory.init();
revised.state_revision := 1;
assert (not PristineMemory.isPristineForBinding(revised));

let counted = Memory.init();
counted.certified_object_count := 1;
assert (not PristineMemory.isPristineForBinding(counted));
