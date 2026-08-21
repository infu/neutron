import { querySelf, updateSelf } from "neutron-tools/app";

type Meeting = { id: Uint8Array; title: string; peer: string; initiator: boolean };
type Signal = { sequence: string; signal_id: Uint8Array; kind: string; payload: string };
type SignalPage = { latest_sequence: string; signals: Signal[] };

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const localVideo = byId<HTMLVideoElement>("local");
const remoteVideo = byId<HTMLVideoElement>("remote");
const localEmpty = byId("local-empty");
const remoteEmpty = byId("remote-empty");
const status = byId<HTMLOutputElement>("status");
const connection = byId("connection");
const start = byId<HTMLButtonElement>("start");
const mic = byId<HTMLButtonElement>("mic");
const camera = byId<HTMLButtonElement>("camera");
let meeting: Meeting | null = null;
let stream: MediaStream | null = null;
let pc: RTCPeerConnection | null = null;
let pollTimer: number | undefined;
let afterSequence = "0";
let makingOffer = false;
let ignoreOffer = false;
let pendingCandidates: RTCIceCandidateInit[] = [];
let sendChain: Promise<void> = Promise.resolve();

const random16 = () => crypto.getRandomValues(new Uint8Array(16));

function send(kind: "description" | "candidate" | "end", value: unknown): Promise<void> {
  const task = sendChain.then(async () => {
    if (!meeting) return;
    await updateSelf("rendezvous_signal_send_v1", [{ negotiation_id: meeting.id, signal_id: random16(), kind, payload: JSON.stringify(value) }], 30);
  });
  // A failed signal is reported to its caller, while later signals are still
  // serialized rather than permanently poisoning the queue.
  sendChain = task.catch(() => undefined);
  return task;
}

function configurePeer(): RTCPeerConnection {
  const peer = new RTCPeerConnection();
  peer.ontrack = ({ streams }) => { remoteVideo.srcObject = streams[0] ?? new MediaStream(); remoteVideo.hidden = false; remoteEmpty.hidden = true; };
  peer.onconnectionstatechange = () => {
    connection.textContent = peer.connectionState === "connected" ? "Direct browser connection" : peer.connectionState;
    if (peer.connectionState === "failed") status.value = "The direct connection failed. TURN relay is not configured.";
  };
  peer.onicecandidate = ({ candidate }) => { if (candidate) void send("candidate", candidate.toJSON()).catch(showError); };
  peer.onnegotiationneeded = async () => {
    try { makingOffer = true; await peer.setLocalDescription(); await send("description", peer.localDescription); }
    catch (error) { showError(error); } finally { makingOffer = false; }
  };
  return peer;
}

async function receive(signal: Signal): Promise<void> {
  if (!pc || !meeting) return;
  if (signal.kind === "end") { status.value = "The other person left"; closeDevices(); pc.close(); return; }
  if (signal.kind === "description") {
    const description = JSON.parse(signal.payload) as RTCSessionDescriptionInit;
    const offerCollision = description.type === "offer" && (makingOffer || pc.signalingState !== "stable");
    // The original organizer is deterministic/impolite; the recipient rolls
    // back on glare. This is the WebRTC perfect-negotiation role split.
    ignoreOffer = meeting.initiator && offerCollision;
    if (ignoreOffer) { pendingCandidates = []; return; }
    await pc.setRemoteDescription(description);
    const queued = pendingCandidates;
    pendingCandidates = [];
    for (const candidate of queued) await pc.addIceCandidate(candidate);
    if (description.type === "offer") { await pc.setLocalDescription(); await send("description", pc.localDescription); }
  } else if (signal.kind === "candidate") {
    if (ignoreOffer) return;
    const candidate = JSON.parse(signal.payload) as RTCIceCandidateInit;
    if (!pc.remoteDescription) pendingCandidates.push(candidate);
    else await pc.addIceCandidate(candidate);
  }
}

async function poll(): Promise<void> {
  if (!meeting || !pc) return;
  try {
    const page = await querySelf<SignalPage>("rendezvous_signal_poll_v1", [{ negotiation_id: meeting.id, after_sequence: afterSequence }]);
    for (const signal of page.signals) await receive(signal);
    afterSequence = page.latest_sequence;
  } catch (error) { showError(error); }
  pollTimer = window.setTimeout(() => void poll(), 500);
}

async function startDevices(): Promise<void> {
  try {
    if (!meeting) throw new Error("The confirmed meeting is unavailable");
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    pc = configurePeer();
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    localVideo.srcObject = stream; localVideo.hidden = false; localEmpty.hidden = true;
    mic.disabled = false; camera.disabled = false; start.hidden = true;
    status.value = "Devices ready — connecting to the other person";
    void poll();
  } catch (error) { showError(error); }
}

function closeDevices(): void {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
  pendingCandidates = [];
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null; localVideo.srcObject = null; remoteVideo.srcObject = null;
  localVideo.hidden = true; remoteVideo.hidden = true; localEmpty.hidden = false; remoteEmpty.hidden = false;
  mic.disabled = true; camera.disabled = true;
}

async function leave(): Promise<void> {
  try { await send("end", null); } catch { /* expiry still bounds remote state */ }
  closeDevices(); pc?.close(); pc = null;
  await updateSelf("rendezvous_media_close_v1", [null]).catch(() => undefined);
  status.value = "You left the meeting";
}

function showError(error: unknown): void {
  const value = error instanceof Error ? error.message : String(error);
  status.value = value.includes("NotAllowedError") ? "Browser permission was denied" : value;
}

start.onclick = () => void startDevices();
mic.onclick = () => { const track = stream?.getAudioTracks()[0]; if (!track) return; track.enabled = !track.enabled; mic.textContent = track.enabled ? "Mute" : "Unmute"; };
camera.onclick = () => { const track = stream?.getVideoTracks()[0]; if (!track) return; track.enabled = !track.enabled; camera.textContent = track.enabled ? "Camera off" : "Camera on"; };
byId<HTMLButtonElement>("end").onclick = () => void leave();
addEventListener("pagehide", closeDevices);

void querySelf<Meeting>("rendezvous_media_current_v1", [null]).then((result) => {
  meeting = result; byId("meeting").textContent = meeting.title;
}).catch(showError);
