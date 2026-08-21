import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);

test("Rendezvous 0.3.0 declares composition, paid signaling transport, and bounded media access", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
  expect(validate_neutron_conf(manifest).valid).toBe(true);
  expect(manifest).toMatchObject({
    id: "rendezvous",
    name: "Rendezvous",
    version: 300,
    func: { rendezvous_status: { type: "query", async: false } },
    memory: { rendezvous: { version: 2 } },
  });
  expect(manifest).not.toHaveProperty("update_source");
  expect(manifest).not.toHaveProperty("init_arg");
  expect(manifest.dependencies?.calendar?.functions).toHaveLength(4);
  expect(manifest.dependencies?.calendar?.min_version).toBe(200);
  expect(manifest.dependencies?.contacts).toMatchObject({
    min_version: 301,
    functions: [
      "contacts_neutron_lookup_v2",
      "contacts_neutron_search_v2",
      "contacts_neutron_revision_v2",
    ],
  });
  expect(manifest.capabilities?.public_ingress?.routes?.[0]).toMatchObject({ protocol: "rendezvous_v1", id: "exchange", required_cycles: 250000000 });
  expect(manifest.capabilities?.backend_calls?.max_cycles_per_call).toBe(250000000);
  expect(manifest.capabilities?.public_ingress?.routes?.[1]).toMatchObject({ protocol: "rendezvous_signal_v1", id: "signal", required_cycles: 250000000 });
  expect(manifest.capabilities?.media_sessions).toEqual({
    api: 1,
    entrypoint: "media.html",
    features: ["camera", "microphone"],
    max_duration_seconds: 3600,
  });
});

test("Rendezvous tile has owner actions and uncertainty-safe copy", async () => {
  const frontend = await readFile(new URL("../src/index.tsx", import.meta.url), "utf8");
  for (const method of ["rendezvous_contacts_search_v1", "rendezvous_create_contact_offer", "rendezvous_create_offer", "rendezvous_send_offer", "rendezvous_accept", "rendezvous_decline", "rendezvous_cancel", "rendezvous_retry"]) expect(frontend).toContain(method);
  expect(frontend).toContain("the peer may have committed");
  expect(frontend).toContain("Add a specific time");
  expect(frontend).toContain("Check and add");
  expect(frontend).toContain("Choose exact options");
  expect(frontend).toContain("Your Rendezvous address");
  expect(frontend).toContain("Their Rendezvous address");
  expect(frontend).toContain("Suggest another time");
  expect(frontend).toContain("No longer available");
  expect(frontend).toContain("No available times matched this search");
  expect(frontend).toContain("None of these times is open now");
  expect(frontend).toContain("Available");
  expect(frontend).toContain("They suggested another time");
  expect(frontend).toContain("Needs your response");
  expect(frontend).toContain("Scheduled");
  expect(frontend).toContain("Rendezvous could not complete that action.");
  expect(frontend).toContain("onTileViewRequest");
  expect(frontend).toContain("Calendar range imported");
  expect(frontend).toContain("address checked again before send");
  expect(frontend).toContain("capabilities.media_sessions.open");
  expect(frontend).toContain("Join video meeting");
  expect(frontend).toContain("peer_name");
  expect(frontend).toContain("Unknown Neutron");
  expect(frontend).not.toContain("From another Neutron");
});

test("Rendezvous media entrypoint is self-contained and stops every captured track", async () => {
  const source = await readFile(new URL("../src/media.ts", import.meta.url), "utf8");
  const media = await readFile(new URL("../dist/web/media.html", import.meta.url), "utf8");
  expect(source).toContain("navigator.mediaDevices.getUserMedia({ audio: true, video: true })");
  expect(source).toContain("RTCPeerConnection");
  expect(source).toContain("rendezvous_signal_send_v1");
  expect(source).toContain("rendezvous_signal_poll_v1");
  expect(source).toContain('addEventListener("pagehide", closeDevices)');
  expect(media).toContain("Direct browser connection");
  expect(media).not.toContain("/*__RENDEZVOUS_MEDIA_SCRIPT__*/");
  expect(media).not.toContain("[!/*__RENDEZVOUS_MEDIA_SCRIPT__*/");
  expect(media).not.toMatch(/<(?:script|link|img|video|audio)[^>]+(?:src|href)=["']https?:/i);
});

test("Rendezvous journals retry bytes before dispatching the broker call", async () => {
  const backend = await readFile(new URL("../backend/main.mo", import.meta.url), "utf8");
  const journal = backend.indexOf("outbound_bytes = ?bytes");
  const dispatch = backend.indexOf("await* calls.call", journal);
  expect(journal).toBeGreaterThan(-1);
  expect(dispatch).toBeGreaterThan(journal);
  expect(backend).toContain("commandIdFor(n.id, n.revision, command)");
});

test("Rendezvous bundles the Neutron design system", async () => {
  const css = await readFile(new URL("../dist/web/main.css", import.meta.url), "utf8");
  expect(css).toContain(".nt-app");
  expect(css).toContain("--nt-bg-panel");
});

test("Rendezvous tray is actionable and exposes counts rather than meeting metadata", async () => {
  const tray = await readFile(new URL("../src/tray.tsx", import.meta.url), "utf8");
  expect(tray).toContain("Review requests");
  expect(tray).toContain("openAppTile");
  expect(tray).toContain("dismissTray");
  expect(tray).not.toContain("title");
  expect(tray).not.toContain("candidate_starts_ns");
});
