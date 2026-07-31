import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const contracts = readFileSync(
  new URL("../src/resident/contracts.ts", import.meta.url),
  "utf8",
);
const orchestrator = readFileSync(
  new URL("../src/resident/orchestrator.ts", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL("../src/service.ts", import.meta.url),
  "utf8",
);
const backendMain = readFileSync(
  new URL("../backend/main.mo", import.meta.url),
  "utf8",
);
const tray = readFileSync(
  new URL("../src/tray/app.tsx", import.meta.url),
  "utf8",
);

describe("Wagyu resident authority boundary", () => {
  test("uses only declared local self calls for background orchestration", () => {
    expect(contracts).toContain('querySelf("wagyu_status"');
    expect(contracts).toContain('"wagyu_notifications_mark_read"');
    expect(contracts).toContain('"wagyu_relationships"');
    expect(contracts).toContain('"wagyu_auto_renew_self_v1"');
    expect(contracts).toContain('"wagyu_outbox_page"');
    expect(contracts).toContain('"wagyu_outbox_drain"');
    expect(contracts).toContain('"wagyu_outbox_retry"');
    expect(contracts).toContain(
      "before === null ? {} : { before_sequence: before }",
    );
    expect(contracts).toContain(
      "expected === null ? {} : { expected_revision: expected }",
    );
    expect(contracts).not.toContain("limit: String(limit)");
    expect(`${contracts}\n${orchestrator}\n${service}`).not.toMatch(
      /\bfetch\s*\(|HttpAgent|app_wagyu__wagyu_v1_update/u,
    );
    expect(service).toContain('caller?.appId !== "wagyu"');
    expect(service).toContain('caller.role !== "tile"');
    expect(service).toContain('caller.role !== "tray"');
  });

  test("normal resident drains cannot select owner-only retries", () => {
    expect(backendMain).toMatch(
      /wagyu_outbox_drain[\s\S]{0,240}drainOutbox\(request\.limit, #automatic, backendCalls\)/u,
    );
    expect(backendMain).toMatch(
      /func retryOutbox[\s\S]{0,4000}beginDispatch\(localId, #owner, now\)/u,
    );
    expect(backendMain).toMatch(
      /finishDispatch\(\{[\s\S]{0,320}jitter = OutboxService\.retryJitter\([\s\S]{0,180}starts\[index\]\.attempt_no/u,
    );
  });

  test("revalidates stale Follow work before automatic and owner dispatch", () => {
    const retryStart = backendMain.indexOf("func retryOutbox");
    const retryEnd = backendMain.indexOf(
      "func dispatchOutboxBatch",
      retryStart,
    );
    const retry = backendMain.slice(retryStart, retryEnd);
    const authorization = retry.indexOf("followDispatchAuthorized(");
    const resume = retry.indexOf("service.resumeItem(");
    const begin = retry.indexOf("service.beginDispatch(");

    expect(retryStart).toBeGreaterThan(-1);
    expect(retryEnd).toBeGreaterThan(retryStart);
    expect(authorization).toBeGreaterThan(-1);
    expect(authorization).toBeLessThan(resume);
    expect(authorization).toBeLessThan(begin);
    expect(retry).toContain("service.supersede(localId, now)");
    expect(retry).toContain("#owner");
    expect(backendMain).toMatch(
      /result\.certainty\s*==\s*#may_have_dispatched/u,
    );
    expect(backendMain).toMatch(
      /following\.pending_outbox_local_id\s*==\s*null/u,
    );
  });

  test("derives early renewal only after a first durable local feed promotion", () => {
    const promotion = backendMain.indexOf("func promoteFeedCandidate");
    const firstVerification = backendMain.indexOf(
      "candidate.verification != #verified",
      promotion,
    );
    const durableSuccess = backendMain.indexOf(
      "#promoted(_)",
      firstVerification,
    );
    const localAccounting = backendMain.indexOf(
      ".recordLocallyVerifiedDelivery(",
      firstVerification,
    );
    const ingressFence = backendMain.indexOf(
      "func canCommitIngressFollowing",
    );
    const ingressAccountingFence = backendMain.indexOf(
      "next.locally_verified_delivery_count ==",
      ingressFence,
    );

    expect(promotion).toBeGreaterThan(-1);
    expect(firstVerification).toBeGreaterThan(promotion);
    expect(durableSuccess).toBeGreaterThan(firstVerification);
    expect(localAccounting).toBeGreaterThan(durableSuccess);
    expect(
      backendMain.match(/\.recordLocallyVerifiedDelivery\(/gu),
    ).toHaveLength(1);
    expect(ingressAccountingFence).toBeGreaterThan(ingressFence);
  });

  test("bounds diagnostic outbound summaries and fails pending status open", () => {
    expect(backendMain).toContain(
      "let OUTBOUND_SUMMARY_SCAN_LIMIT : Nat = 512",
    );
    expect(backendMain).toMatch(
      /outbound_work_pending =[\s\S]{0,240}outbox\.saturated[\s\S]{0,160}fanout\.saturated/u,
    );
    expect(backendMain).toMatch(
      /func outboxWorkSummary[\s\S]{0,900}inspected >= OUTBOUND_SUMMARY_SCAN_LIMIT/u,
    );
    expect(backendMain).toMatch(
      /func fanoutWorkSummary[\s\S]{0,700}inspected >= OUTBOUND_SUMMARY_SCAN_LIMIT/u,
    );
    expect(backendMain).not.toContain("func countQueuedOutbox");
    expect(backendMain).not.toContain("func countErrorOutbox");
    expect(backendMain).not.toContain("func hasPendingFanoutWork");
  });

  test("keeps follower and fanout admission off full-map scans", () => {
    expect(backendMain).not.toContain("func eligibleFollowerCount");
    expect(backendMain).not.toContain("func activeFollowerCapacityCount");
    expect(backendMain).not.toContain("func isCapacityActiveFollower");
    expect(backendMain).toMatch(
      /func prepareFanoutJob[\s\S]{0,520}let eligible = mem\.active_follower_count/u,
    );
    expect(backendMain).toMatch(
      /func storeFanoutJob[\s\S]{0,1100}FanoutPlanner\.terminalWithoutTargets\([\s\S]{0,320}reAgeDetachedTerminalRetention\(/u,
    );
  });

  test("page lifecycle cannot reuse a closed verification Worker", () => {
    expect(service).toMatch(
      /pagehide[\s\S]{0,420}residentVerificationEpoch \+= 1;[\s\S]{0,180}residentVerificationClient = null;[\s\S]{0,120}residentVerificationPromise = null;/u,
    );
    expect(service).toContain("epoch !== residentVerificationEpoch");
    expect(service).toContain(
      "Wagyu resident verification context changed",
    );
  });

  test("reserves Kernel control admission only for exact verification cancellation", () => {
    expect(service).toMatch(
      /WAGYU_RESIDENT_VERIFICATION_TOOLS\.cancel,[\s\S]{0,500}"neutron:control": "cancel"/u,
    );
    expect(service).not.toMatch(
      /WAGYU_RESIDENT_TOOLS\.setAutoDrain,[\s\S]{0,500}"neutron:control"/u,
    );
  });

  test("keeps peer networking out of the transient tray", () => {
    expect(tray).toContain("new WagyuResidentClient()");
    expect(tray).not.toMatch(/\bfetch\s*\(|HttpAgent|querySelf|updateSelf/u);
    expect(tray).toContain('event.key !== "Escape"');
    expect(tray).toContain("dismissTray()");
    expect(tray).toContain("START_RETRY_DELAYS");
    expect(tray).toContain("BigInt(next.residentRevision)");
    expect(tray).toContain("snapshot?.notificationItems");
    expect(tray).not.toContain("CountCard");
    expect(tray).not.toContain("Outbox");
    expect(tray).not.toContain("Drain now");
    expect(tray).toContain('data-tid="wagyu-tray"');
    expect(tray).toContain('role="alert"');
    expect(tray).toContain('aria-label="Loading notifications"');
    expect(tray).toContain('className="wagyu-tray__spinner"');
    expect(tray).not.toContain("<strong>Loading notifications</strong>");
  });

  test("resident permits only trusted certified gateways while the tray denies networking", () => {
    const residentDocument = readFileSync(
      new URL("../public/service.html", import.meta.url),
      "utf8",
    );
    const trayDocument = readFileSync(
      new URL("../public/tray.html", import.meta.url),
      "utf8",
    );

    expect(residentDocument).toContain(
      "connect-src 'self' https://*.icp0.io http://localhost:* http://*.localhost:*;",
    );
    expect(residentDocument).toContain("worker-src 'self';");
    expect(residentDocument).not.toContain("worker-src 'self' blob:");
    expect(residentDocument).not.toMatch(
      /connect-src[^;]*(?:\s\*|https:\s|http:\/\/(?!localhost:\*|\*\.localhost:\*))/u,
    );
    expect(residentDocument).toContain("default-src 'none'");

    expect(trayDocument).toContain("connect-src 'none'");
    expect(trayDocument).toContain("default-src 'none'");
  });
});
