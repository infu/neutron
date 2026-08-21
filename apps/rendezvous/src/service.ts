import { querySelf, setTrayState } from "neutron-tools/app";
type Status = { revision: string; actionable_count: string };
let lastRevision = "";
async function pulse() {
  const status = await querySelf<Status>("rendezvous_status", [null]);
  if (status.revision === lastRevision) return;
  lastRevision = status.revision;
  const count = Number(status.actionable_count);
  await setTrayState({ badge: count > 0 ? Math.min(count, 99) : null });
}
void pulse();
setInterval(() => void pulse().catch(() => {}), 15_000);
