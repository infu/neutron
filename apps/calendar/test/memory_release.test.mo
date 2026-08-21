import Calendar "../backend/main";
import Memory "../backend/memory/calendar/v2";

let memory = Memory.init();
let calendar = Calendar.Init({ stable_memory = { calendar = memory } });
let status = calendar.calendar_status();
assert (status.revision == 0);
assert (status.event_count == 0);
