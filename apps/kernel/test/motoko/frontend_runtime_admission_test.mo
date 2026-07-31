import Admission "../../backend/frontend_runtime/Admission";

assert (Admission.accepts({
    app_instances = 256;
    resident_frames = 32;
}));
assert (Admission.accepts({
    app_instances = 201;
    resident_frames = 0;
}));
assert (not Admission.accepts({
    app_instances = 257;
    resident_frames = 0;
}));
assert (not Admission.accepts({
    app_instances = 33;
    resident_frames = 33;
}));
assert (not Admission.accepts({
    app_instances = 4;
    resident_frames = 5;
}));
assert (not Admission.accepts({
    app_instances = 0;
    resident_frames = 0;
}));
