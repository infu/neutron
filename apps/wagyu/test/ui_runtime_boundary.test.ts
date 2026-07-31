import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { shouldUseWagyuPreview } from "../src/app/service_adapter.ts";

test("preview data is explicit and can never replace an embedded runtime", () => {
  expect(shouldUseWagyuPreview({ search: "" }, false)).toBeFalse();
  expect(shouldUseWagyuPreview({ search: "?preview=1" }, false)).toBeTrue();
  expect(shouldUseWagyuPreview({ search: "?preview=1" }, true)).toBeFalse();
});

test("the production adapter installs certified feed, profile, and likes ports", async () => {
  const source = await readFile(
    new URL("../src/app/service_adapter.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain("createCertifiedWagyuPorts");
  expect(source).toContain("loadProfile");
  expect(source).toContain(
    'config.target === "pocketic"\n      ? globalThis.location.origin',
  );
  expect(source).toContain("host: agentHost");
  expect(source).not.toContain("return createPreviewWagyuService();\n  }\n  return createPreviewWagyuService()");
});

test("production verification is isolated in the background-owned bounded Worker", async () => {
  const runtime = await readFile(
    new URL("../src/app/certified_runtime.ts", import.meta.url),
    "utf8",
  );
  const build = await readFile(
    new URL("../build.ts", import.meta.url),
    "utf8",
  );
  const workerBootstrap = await readFile(
    new URL("../src/worker/bootstrap.ts", import.meta.url),
    "utf8",
  );
  expect(runtime).toContain("createWagyuResidentVerificationClient");
  expect(runtime).not.toContain("createWagyuVerificationWorkerClient");
  expect(runtime).toContain("worker.verifyFeed");
  expect(runtime).toContain("worker.verifyProfile");
  expect(runtime).toContain("worker.verifyLikes");
  expect(build).toContain("wagyu-packaged-verification-worker");
  expect(build).toContain('entryPoints: ["./src/worker/entry.ts"]');
  expect(build).not.toContain('"verification-worker":');
  expect(workerBootstrap).toContain("new Blob([sourceBytes]");
  expect(workerBootstrap).toContain("new MessageChannel()");
  expect(workerBootstrap).not.toContain("verification-worker.js");
});

test("ordinary self calls support Candid values and omit absent optionals", async () => {
  const adapter = await readFile(
    new URL("../src/app/service_adapter.ts", import.meta.url),
    "utf8",
  );
  expect(adapter).toContain(
    'const kind = sendKind ?? (noticeTarget ? "reply" : "post")',
  );
  expect(adapter).toContain("send_kind: { [kind]: null }");
  expect(adapter).toContain("noticeTarget === undefined");
  expect(adapter).toContain("{ notice_target: noticeTarget }");
  expect(adapter).toContain(
    "cursor === null ? {} : { before_sequence: cursor }",
  );
  expect(adapter).not.toContain(
    'send_kind: [{ [noticeTarget ? "reply" : "post"]: null }]',
  );
  expect(adapter).not.toContain(
    "notice_target: noticeTarget ? [noticeTarget] : []",
  );
  expect(adapter).not.toContain("before_sequence: cursor ? [cursor] : []");
  expect(adapter).toContain("querySelf(method, args, timeoutSeconds)");
  expect(adapter).toContain("updateSelf(method, args, timeoutSeconds)");
  expect(adapter).not.toContain("neutron-tools/app_attachments");
  expect(adapter).not.toContain("querySelfWithAttachment");
  expect(adapter).not.toContain("updateSelfWithAttachment");
});

test("share and withdrawal retain exact proof-first owner workflows", async () => {
  const adapter = await readFile(
    new URL("../src/app/service_adapter.ts", import.meta.url),
    "utf8",
  );
  const feed = await readFile(
    new URL("../src/app/components/FeedView.tsx", import.meta.url),
    "utf8",
  );
  expect(adapter).toContain("this.#owner.sharePrepare");
  expect(adapter).toContain(
    'preparedActionFromBridge(preparedResult, "share"',
  );
  expect(adapter).toContain(
    'preparedActionFromBridge(preparedResult, "tombstone"',
  );
  expect(adapter).toContain("this.#owner.withdrawalAdvance");
  expect(adapter).toContain("resumeAuthoredPost");
  expect(adapter).toContain('kind: "post"');
  expect(feed).toContain("<span>Delete post</span>");
  expect(feed).toContain("Finish deletion");
  expect(feed).toContain("Finish sending");
});

test("Like success is shown only after a durable finalization result", async () => {
  const app = await readFile(
    new URL("../src/app/App.tsx", import.meta.url),
    "utf8",
  );
  expect(app).toContain("const result = await service.like(item)");
  expect(app).toContain(
    "if (!publishStageIsDurableHandoff(result.stage))",
  );
  expect(app).toContain('setNotice("Liked.")');
});

test("publication stays in context for replies and opens Profile for new posts", async () => {
  const [app, composer] = await Promise.all([
    readFile(
      new URL("../src/app/App.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/components/Composer.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  const handoff = composer.slice(
    composer.indexOf("if (publishStageIsDurableHandoff(next.stage))"),
    composer.indexOf("} catch (reason)", composer.indexOf(
      "if (publishStageIsDurableHandoff(next.stage))",
    )),
  );
  expect(handoff).toContain("onMarkdownChange(\"\")");
  expect(handoff).toContain("onClose()");
  expect(handoff).toContain("onPublished(publishedReplyTarget)");
  expect(composer).not.toContain("Write another");

  const published = app.slice(
    app.indexOf("const handlePublished ="),
    app.indexOf("const selectedUserFeed"),
  );
  expect(published).toContain("if (!publishedReplyTarget)");
  expect(published).toContain('setView("profile")');
  expect(published).toContain("refreshFeed()");
  expect(published).toContain("refreshAuthored()");
});

test("main tile follows resident invalidations and paginates notification summaries", async () => {
  const app = await readFile(
    new URL("../src/app/App.tsx", import.meta.url),
    "utf8",
  );
  const notifications = await readFile(
    new URL(
      "../src/app/components/NotificationsView.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  expect(app).toContain("onAppStateChange");
  expect(app).toContain("Object.values(WAGYU_RESIDENT_TOPICS)");
  expect(app).toContain("appendNotificationPage");
  expect(notifications).toContain("Load older notifications");
});

test("opening notifications marks loaded rows read and reconciles the resident badge without waking outbound work", async () => {
  const app = await readFile(
    new URL("../src/app/App.tsx", import.meta.url),
    "utf8",
  );
  const markRead = app.slice(
    app.indexOf("const unreadNotificationSignature"),
    app.indexOf("\n\n  useEffect(() => {\n    setThreadReplyDraft"),
  );
  expect(markRead).toContain('view !== "notifications"');
  expect(markRead).toContain("service.markNotificationsRead(unread)");
  expect(markRead).toContain("new WagyuResidentClient()).refresh()");
  expect(markRead).toContain("reconcileUnreadNotificationsFromResident");
  expect(markRead).not.toContain("wakeOutboundDelivery");
  expect(markRead).not.toContain(".wake()");
});

test("feed availability failures use bounded delayed recovery", async () => {
  const [app, adapter, retry] = await Promise.all([
    readFile(new URL("../src/app/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/service_adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/feed_retry.ts", import.meta.url), "utf8"),
  ]);
  expect(app).toContain("automaticallyHydratedFeed");
  expect(app).toContain("FeedUnavailableRetryController");
  expect(app).toContain('item.verification !== "unavailable"');
  expect(app).toContain("automaticallyHydratedFeed.current.clear()");
  expect(app).toContain("!automaticallyHydratedFeed.current.has(item.id)");
  expect(retry).toContain("[5_000, 15_000, 30_000]");
  expect(retry).toContain("entry.attemptsStarted += 1");
  expect(retry).toContain("entry.inFlight?.abort");
  const feedDisposition = adapter.slice(
    adapter.indexOf("async function recordCandidateDispositionThroughBridge"),
    adapter.indexOf("async function recordNotificationDispositionThroughBridge"),
  );
  expect(feedDisposition).not.toContain('disposition: "unavailable"');
});

test("share and tombstone publication wait for a current quote", async () => {
  const app = await readFile(
    new URL("../src/app/App.tsx", import.meta.url),
    "utf8",
  );
  expect(app).toContain(".getSendQuote(");
  expect(app).toContain("action.kind");
  expect(app).toContain("disabled={!quote}");
  expect(app).toContain("Share this post?");
  expect(app).toContain("Delete this post?");
});

test("verified replies bind the exact parent and no binary owner flow bypasses the bridge", async () => {
  const adapter = await readFile(
    new URL("../src/app/service_adapter.ts", import.meta.url),
    "utf8",
  );
  const composer = await readFile(
    new URL("../src/app/components/Composer.tsx", import.meta.url),
    "utf8",
  );
  expect(adapter).toContain("exactReplyLocator");
  expect(adapter).toContain("post_id:");
  expect(adapter).toContain("body_hash:");
  expect(adapter).toContain("body_length:");
  expect(adapter).toContain("object_digest:");
  expect(composer).toContain("Replying to");
  expect(composer).not.toContain("Create a certified reply");
  for (const forbidden of [
    '"wagyu_post_publish"',
    '"wagyu_share_publish"',
    '"wagyu_like_publish"',
    '"wagyu_post_delete"',
    '"wagyu_action_finalize"',
    '"wagyu_feed_promote"',
    '"wagyu_feed_reject"',
  ]) {
    expect(adapter).not.toContain(forbidden);
  }
});

test("visible notification evidence is verified before actor profile text is enabled", async () => {
  const adapter = await readFile(
    new URL("../src/app/service_adapter.ts", import.meta.url),
    "utf8",
  );
  const runtime = await readFile(
    new URL("../src/app/certified_runtime.ts", import.meta.url),
    "utf8",
  );
  expect(adapter).toContain("notificationEvidence");
  expect(runtime).toContain("decodeCertifiedLikeReceiptV1");
  expect(runtime).toContain("notificationReplyDecoder");
  expect(runtime).toContain("notificationShareDecoder");
  expect(runtime).toContain("recordNotificationDisposition");
});

test("reply-parent text is retained only after verification and shown in the thread", async () => {
  const [runtime, postCard, feed, thread] = await Promise.all([
    readFile(
      new URL("../src/app/certified_runtime.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/components/PostCard.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/components/FeedView.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/components/ThreadView.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  expect(runtime).toContain(
    'verified.replyTo.state === "verified"',
  );
  expect(runtime).toContain(
    "verified: verified.replyTo.state === \"verified\"",
  );
  expect(postCard).toContain("Reply to <strong>{replyTo.label}</strong>");
  expect(postCard).toContain('className="wg-feed-card__thread-link"');
  expect(postCard).not.toContain("replyTo.excerpt");
  expect(feed).toContain("if (!reference.verified) return null");
  expect(feed).toContain("body: reference.body");
  expect(thread).toContain("{renderPost(ancestor, index > 0)}");
  expect(thread).toContain("{renderPost(item, ancestors.length > 0)}");
  expect(thread).toContain("{renderPost(reply.item, true)}");
});

test("UI sources do not introduce an HTML rendering bypass", async () => {
  const files = [
    "../src/app/components/FeedView.tsx",
    "../src/app/components/NotificationsView.tsx",
    "../src/app/components/ProfileView.tsx",
    "../src/app/components/ThreadView.tsx",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("innerHTML");
  }
});

test("network identity is installer-trusted and missing peer delivery can be approved", async () => {
  const gate = await readFile(
    new URL("../src/app/components/PeerDeliveryGate.tsx", import.meta.url),
    "utf8",
  );
  const adapter = await readFile(
    new URL("../src/app/service_adapter.ts", import.meta.url),
    "utf8",
  );
  expect(gate).toContain("Permission needed");
  expect(gate).toContain("Enable peer delivery");
  expect(gate).toContain("other Neutrons");
  expect(gate).not.toContain("method-scoped call reservation");
  expect(gate).not.toContain("<input");
  expect(adapter).toContain("deriveNetworkId");
  expect(adapter).toContain("listBackendCallReservations");
  expect(adapter).toContain("requestBackendCallReservations");
  expect(adapter).toContain("method: WAGYU_PUBLIC_INGRESS_METHOD");
  expect(adapter).toContain("enablePeerDelivery");
  expect(adapter).toContain("assertInstalledNetwork");
  expect(adapter).toContain("peer delivery access was not saved");
  expect(adapter).not.toContain("buildNetworkConfigureDialogRequest");
  expect(adapter).not.toContain("WAGYU_NETWORK_CONFIGURE_DIALOG_METHOD");
  expect(adapter).not.toContain("configureNetwork");
  expect(adapter).not.toContain("physicalAppMethodName");
  const app = await readFile(
    new URL("../src/app/App.tsx", import.meta.url),
    "utf8",
  );
  expect(app).toContain("!snapshot.status.peerDeliveryEnabled");
  expect(app).toContain("<PeerDeliveryGate");
  expect(app).toContain("const status = await service.enablePeerDelivery()");
  expect(app).toContain("current ? { ...current, status } : current");
  expect(app).toContain("UI cannot create or repair installer-owned configuration");
});
