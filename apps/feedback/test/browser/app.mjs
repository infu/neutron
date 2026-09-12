/** Local-only UI regression: mocked protocol, blocked external network. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sandboxHtml, sandboxPage } from "./sandbox.mjs";
import { testFeedbackTextLimits } from "./limits.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const output = process.env.FEEDBACK_BROWSER_ARTIFACTS || "/tmp/neutron-feedback-ui/browser";
await mkdir(output, { recursive: true });
await build({
  entryPoints: [join(directory, "fixture.tsx")],
  bundle: true, format: "esm", jsx: "automatic", outfile: join(output, "fixture.js"),
  plugins: [
    { name: "local-only-neutron-transport", setup(builder) {
      builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: join(directory, "transport.ts") }));
    } },
    sassPlugin(),
  ],
});
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/fixture.js" || path === "/fixture.css") {
      res.setHeader("content-type", path.endsWith("css") ? "text/css" : "text/javascript");
      res.end(await readFile(join(output, path.slice(1))));
    } else {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(sandboxHtml(req.url));
    }
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const errors = [], externalRequests = [], checks = [];
let browser, host, page;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable",
    args: ["--no-sandbox"],
  });
  host = await browser.newPage({ viewport: { width: 380, height: 760 } });
  host.setDefaultTimeout(10_000);
  host.on("pageerror", error => errors.push(String(error)));
  await host.route("**/*", route => {
    if (route.request().url().startsWith(url)) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  page = sandboxPage(host, errors);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const openThread = title => page.getByRole("button", { name: new RegExp(title) }).click();
  const fresh = async query => {
    await page.goto(`${url}/${query || ""}`);
    if (!query?.includes("error")) await button("New message").first().waitFor();
    assert.equal(await host.locator("#feedback-app").getAttribute("sandbox"), "allow-scripts allow-same-origin");
  };
  const screenshots = async name => {
    for (const width of [320, 380, 960]) {
      await page.setViewportSize({ width, height: 760 });
      if (name.startsWith("invalid-")) await page.locator(".fb-field-limit-error").scrollIntoViewIfNeeded();
      if (name.startsWith("edited-copy")) await page.getByRole("region", { name: "Edit a copy", exact: true }).scrollIntoViewIfNeeded();
      const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth, containers: [...document.querySelectorAll(".fb-body,.fb-tray-body")].map(element => ({ width: element.clientWidth, scroll: element.scrollWidth })) }));
      assert.ok(bounds.scroll <= width + 1 && bounds.body <= width + 1 && bounds.containers.every(element => element.scroll <= element.width + 1), `${name} must fit a ${width}px tile: ${JSON.stringify(bounds)}`);
      await page.screenshot({ path: join(output, `${name}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 380, height: 760 });
    if (name.startsWith("compose-") || name.endsWith("-discussion")) {
      const body = page.locator(".fb-body");
      const previousTop = await body.evaluate(element => { const previous = element.scrollTop; element.scrollTop = element.scrollHeight; return previous; });
      await page.screenshot({ path: join(output, `${name}-bottom-380.png`), fullPage: true });
      await body.evaluate((element, top) => { element.scrollTop = top; }, previousTop);
    }
    if (name.endsWith("-discussion")) {
      await page.setViewportSize({ width: 1280, height: 760 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.screenshot({ path: join(output, `${name}-1280.png`), fullPage: true });
      await page.setViewportSize({ width: 380, height: 760 });
    }
  };
  const callCount = method => page.evaluate(name => window.__feedbackTest.calls.filter(call => call[0] === name).length, method);
  const lastCall = method => page.evaluate(name => window.__feedbackTest.calls.filter(call => call[0] === name).at(-1), method);

  await fresh();
  await page.getByText("Shared file link will not open", { exact: true }).waitFor();
  assert.equal(await button("Moderator inbox").count(), 0, "ordinary users have no moderator navigation");
  assert.equal(await page.getByText("Wallet balance is not refreshing", { exact: true }).count(), 0, "ordinary inbox excludes another Neutron's messages");
  assert.equal(await callCount("markRead"), 0, "listing does not clear unread replies");
  await screenshots("my-messages");
  await button("New replies").click();
  await page.getByText("The new workspace feels clear", { exact: true }).waitFor({ state: "detached" });
  assert.equal(await page.getByText("Shared file link will not open", { exact: true }).count(), 1);
  assert.equal((await lastCall("list"))[1].unreadOnly, true);
  assert.equal(await callCount("markRead"), 0, "filtering unread replies does not acknowledge them");
  await button("All").click();
  await page.getByText("The new workspace feels clear", { exact: true }).waitFor();
  await button("New message").click();
  await page.getByRole("button", { name: /^Report a problem/ }).waitFor();
  await screenshots("new-message");
  checks.push("My messages and the four-kind chooser render at 320, 380 and 960 pixels, without horizontal overflow.");

  await fresh("?paged");
  await page.getByText("The new workspace feels clear", { exact: true }).waitFor();
  assert.equal(await page.getByText("A simple reading list", { exact: true }).count(), 0);
  await button("Load more messages").click();
  await page.getByText("A simple reading list", { exact: true }).waitFor();
  await page.getByText("Search across my files", { exact: true }).waitFor();
  assert.equal(await page.getByText("Shared file link will not open", { exact: true }).count(), 1);
  assert.equal(await button("Load more messages").count(), 0);
  const listReads = await callCount("list");
  await page.evaluate(() => window.__feedbackTest.refresh());
  await page.waitForFunction(before => window.__feedbackTest.calls.filter(call => call[0] === "list").length >= before + 2, listReads);
  await page.getByText("Search across my files", { exact: true }).waitFor();
  await page.getByRole("combobox").selectOption("app_suggestion");
  await page.getByText("Shared file link will not open", { exact: true }).waitFor({ state: "detached" });
  assert.equal((await lastCall("list"))[1].kind, "app_suggestion");
  checks.push("List pagination appends each message once, preserves loaded pages after refresh, and resets when the message kind changes.");

  const kinds = [
    ["Report a problem", "Send ticket", "issue"],
    ["Share feedback", "Send feedback", "feedback"],
    ["Suggest an app", "Suggest app", "app_suggestion"],
    ["Suggest a feature", "Suggest feature", "feature_suggestion"],
  ];
  for (const [choice, submit, kind] of kinds) {
    await fresh();
    await button("New message").click();
    await page.getByRole("button", { name: new RegExp(`^${choice}`) }).click();
    await page.getByLabel("Title", { exact: true }).fill(`Test ${kind}`);
    await page.getByRole("textbox", { name: /^Message/ }).fill("This would help me use Neutron.\nA second paragraph with a shared image link: https://example.invalid/image.png");
    await button(submit).waitFor();
    assert.equal(await page.locator('input[type="file"]').count(), 0);
    await page.getByText(/Shared file links are public/).waitFor();
    await screenshots(`compose-${kind}`);
    await button(submit).click();
    await page.getByRole("heading", { name: `Test ${kind}`, exact: true }).waitFor();
    const create = await lastCall("create");
    assert.equal(create[1].kind, kind, `${choice} submits the exact kind`);
    assert.ok(create[1].requestId, "every write includes a stable request ID");
  }
  checks.push("Each submission kind has its own explanation and action label, submits the correct kind, and explains Shared links without an upload field.");

  await fresh();
  await openThread("Shared file link will not open");
  await page.getByRole("heading", { name: "Shared file link will not open", exact: true }).waitFor();
  await page.getByText("Thanks for reporting this. Please check that the image is in Shared, then copy its public link again.", { exact: true }).waitFor();
  await page.waitForFunction(() => window.__feedbackTest.calls.some(call => call[0] === "markRead"));
  assert.deepEqual((await lastCall("markRead")).slice(1), ["1", "12"], "only the displayed message is acknowledged");
  assert.equal(await callCount("reply"), 0);
  await screenshots("issue-discussion");
  const copy = page.getByRole("button", { name: /Copy link/ });
  if (await copy.count()) {
    await copy.first().click();
    assert.deepEqual(await page.evaluate(() => window.__feedbackTest.copies), ["https://example.invalid/shared/image.png"]);
  }
  checks.push("Opening a discussion shows its messages and acknowledges only the displayed response; shared links use the Neutron clipboard when exposed.");

  await page.getByRole("textbox", { name: /^Your reply/ }).fill("The new link works. Thank you!");
  await page.evaluate(() => { window.__feedbackTest.failNextReply = true; });
  await button("Send reply").click();
  await page.getByText("Your original reply is saved. Send again to confirm it without adding a duplicate.", { exact: true }).waitFor();
  await page.getByText("Reply confirmation was lost. Your draft is saved; try again.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: /^Your reply/ }).inputValue(), "The new link works. Thank you!");
  assert.equal(await page.getByRole("textbox", { name: /^Your reply/ }).isEditable(), false, "without a pending API, an uncertain reply remains protected for exact replay");
  await button("Back").click();
  await openThread("Shared file link will not open");
  await page.getByRole("heading", { name: "Shared file link will not open", exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: /^Your reply/ }).inputValue(), "The new link works. Thank you!", "returning to the thread restores its uncertain reply draft");
  await button("Send reply").click();
  await page.waitForFunction(() => window.__feedbackTest.calls.filter(call => call[0] === "reply").length === 2);
  await page.getByText("The new link works. Thank you!", { exact: true }).waitFor();
  const replyCalls = await page.evaluate(() => window.__feedbackTest.calls.filter(call => call[0] === "reply"));
  assert.equal(replyCalls[0][1].requestId, replyCalls[1][1].requestId, "lost reply confirmation retries the same operation");
  assert.equal(await page.evaluate(() => window.__feedbackTest.messages["1"].filter(message => message.body === "The new link works. Thank you!").length), 1);
  checks.push("A lost reply confirmation retains the draft and retries the original request, producing one message.");

  await fresh();
  await button("New message").click();
  await page.getByRole("button", { name: /^Report a problem/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("My ticket survived a lost confirmation");
  await page.getByRole("textbox", { name: /^Message/ }).fill("I can retry this safely. <img src=x onerror=alert(1)>");
  await page.evaluate(() => { window.__feedbackTest.failNextCreate = true; });
  await button("Send ticket").click();
  await page.getByText("Message confirmation was lost. Your draft is saved; try again.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), "My ticket survived a lost confirmation");
  assert.equal(await page.getByRole("textbox", { name: /^Message/ }).inputValue(), "I can retry this safely. <img src=x onerror=alert(1)>");
  assert.equal(await page.getByLabel("Title", { exact: true }).isEditable(), false);
  await screenshots("compose-error");
  await button("Back").click();
  await button("New message").click();
  assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), "My ticket survived a lost confirmation", "returning to compose restores the uncertain submission");
  await button("Send ticket").click();
  await page.getByRole("heading", { name: "My ticket survived a lost confirmation", exact: true }).waitFor();
  const createCalls = await page.evaluate(() => window.__feedbackTest.calls.filter(call => call[0] === "create"));
  assert.equal(createCalls.length, 2);
  assert.equal(createCalls[0][1].requestId, createCalls[1][1].requestId);
  assert.equal(await page.evaluate(() => window.__feedbackTest.created.size), 1);
  await page.getByText("I can retry this safely. <img src=x onerror=alert(1)>", { exact: true }).waitFor();
  assert.equal(await page.locator("img").count(), 0, "discussion content is rendered as text");
  checks.push("A lost create confirmation preserves all fields and the request ID; retry creates one ticket and supplied markup remains plain text.");

  await fresh("?saved-sends");
  const savedSends = page.getByRole("region", { name: "Saved sends", exact: true });
  const savedCreate = savedSends.locator(".fb-saved-send").filter({ hasText: "My saved report about Files" });
  const savedReply = savedSends.locator(".fb-saved-send").filter({ has: page.getByText("Your reply", { exact: true }) });
  await savedCreate.waitFor();
  await savedReply.waitFor();
  await savedCreate.locator("summary").click();
  await savedReply.locator("summary").click();
  await savedSends.getByText("A report saved before the app closed.\nThe original message should only be sent once.", { exact: true }).waitFor();
  await savedSends.getByText("This reply was saved before the app closed.", { exact: true }).waitFor();
  await screenshots("saved-sends");
  await page.evaluate(() => { window.__feedbackTest.failNextResume = true; });
  await savedCreate.getByRole("button", { name: "Confirm send", exact: true }).click();
  await savedSends.getByText("Saved send confirmation is temporarily unavailable. Try again.", { exact: true }).waitFor();
  const pendingReads = await callCount("pending");
  await page.evaluate(() => window.__feedbackTest.refresh());
  await page.waitForFunction(before => window.__feedbackTest.calls.filter(call => call[0] === "pending").length > before, pendingReads);
  await savedSends.getByText("Saved send confirmation is temporarily unavailable. Try again.", { exact: true }).waitFor();
  await savedCreate.getByRole("button", { name: "Confirm send", exact: true }).click();
  await page.getByRole("heading", { name: "My saved report about Files", exact: true }).waitFor();
  assert.deepEqual((await lastCall("resume")).slice(1), ["saved-create-001"]);
  assert.deepEqual((await lastCall("create"))[1], { requestId: "saved-create-001", title: "My saved report about Files", kind: "issue", body: "A report saved before the app closed.\nThe original message should only be sent once.", appId: "files" });
  assert.equal(await savedCreate.count(), 0);
  await savedReply.getByRole("button", { name: "Confirm send", exact: true }).click();
  await page.getByRole("heading", { name: "Shared file link will not open", exact: true }).waitFor();
  await savedSends.waitFor({ state: "detached" });
  assert.deepEqual((await lastCall("resume")).slice(1), ["saved-reply-001"]);
  assert.deepEqual((await lastCall("reply"))[1], { requestId: "saved-reply-001", threadId: "1", body: "This reply was saved before the app closed." });
  assert.equal(await page.evaluate(() => window.__feedbackTest.created.size), 1);
  assert.equal(await page.evaluate(() => window.__feedbackTest.messages["1"].filter(message => message.body === "This reply was saved before the app closed.").length), 1);
  checks.push("Saved create and reply requests appear at startup with their original text; Confirm send replays exact IDs and payloads, opens the original discussion, and removes confirmed entries without duplicates.");

  await fresh("?saved-sends&moderator");
  const savedSupport = page.getByRole("region", { name: "Saved sends", exact: true }).locator(".fb-saved-send").filter({ hasText: "Your support reply" });
  await savedSupport.getByRole("button", { name: "Confirm send", exact: true }).click();
  await page.getByRole("heading", { name: "Wallet balance is not refreshing", exact: true }).waitFor();
  assert.deepEqual((await lastCall("resume")).slice(1), ["saved-support-001"]);
  assert.deepEqual((await lastCall("moderationReply"))[1], { requestId: "saved-support-001", threadId: "5", body: "A support response saved before the app closed." });
  assert.equal(await callCount("reply"), 0);

  await fresh("?pending-filtered");
  await button("More saved sends").waitFor();
  assert.equal(await page.getByText("Your support reply", { exact: true }).count(), 0, "a former moderator's retained request is hidden");
  await button("More saved sends").click();
  await page.getByRole("region", { name: "Saved sends", exact: true }).getByText("My saved report about Files", { exact: true }).waitFor();
  assert.equal((await lastCall("pending"))[1], "visible", "an empty visible first page retains access to the next cursor");
  checks.push("Saved support replies use the moderator API; a filtered first page retains its cursor so ordinary saved sends on page two remain reachable.");

  await fresh("?pending-api");
  await button("New message").click();
  await page.getByRole("button", { name: /^Report a problem/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("A report with a rejected first send");
  await page.getByRole("textbox", { name: /^Message/ }).fill("Original text that the server rejected.");
  await page.evaluate(() => { window.__feedbackTest.rejectNextCreate = true; });
  await button("Send ticket").click();
  await page.getByText("The message was not accepted. Please revise it.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Title", { exact: true }).isEditable(), true);
  assert.equal(await page.getByRole("textbox", { name: /^Message/ }).isEditable(), true);
  assert.equal(await button("Change").isEnabled(), true);
  assert.equal(await page.evaluate(() => window.__feedbackTest.pendingRequests.size), 0);
  assert.equal(await page.getByRole("region", { name: "Saved sends", exact: true }).count(), 0);
  const rejectedCreateId = (await lastCall("create"))[1].requestId;
  await page.getByLabel("Title", { exact: true }).fill("A corrected report");
  await page.getByRole("textbox", { name: /^Message/ }).fill("Corrected text after the confirmed rejection.");
  await button("Send ticket").click();
  await page.getByRole("heading", { name: "A corrected report", exact: true }).waitFor();
  assert.notEqual((await lastCall("create"))[1].requestId, rejectedCreateId);

  await page.getByRole("textbox", { name: /^Your reply/ }).fill("A reply that the server rejected.");
  await page.evaluate(() => { window.__feedbackTest.rejectNextReply = true; });
  await button("Send reply").click();
  await page.getByText("The reply was not accepted. Please revise it.", { exact: true }).waitFor();
  await page.waitForFunction(() => window.__feedbackTest.calls.some(call => call[0] === "reply") && !document.querySelector("#feedback-reply").disabled);
  assert.equal(await page.getByRole("textbox", { name: /^Your reply/ }).isEditable(), true);
  assert.equal(await page.evaluate(() => window.__feedbackTest.pendingRequests.size), 0);
  const rejectedReplyId = (await lastCall("reply"))[1].requestId;
  await page.getByRole("textbox", { name: /^Your reply/ }).fill("A corrected reply.");
  await button("Send reply").click();
  await page.getByText("A corrected reply.", { exact: true }).waitFor();
  assert.notEqual((await lastCall("reply"))[1].requestId, rejectedReplyId);
  checks.push("An authoritative rejection removes the pending request and unlocks create and reply fields; an edited retry gets a new request ID.");

  await fresh("?pending-api");
  await button("New message").click();
  await page.getByRole("button", { name: /^Report a problem/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("Keep this exact uncertain report");
  await page.getByRole("textbox", { name: /^Message/ }).fill("The original report body must remain unchanged.");
  await page.evaluate(() => { window.__feedbackTest.failNextCreate = true; });
  await button("Send ticket").click();
  await page.getByText("Message confirmation was lost. Your draft is saved; try again.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Title", { exact: true }).isEditable(), false);
  assert.equal(await page.getByRole("textbox", { name: /^Message/ }).isEditable(), false);
  assert.equal(await button("Change").isDisabled(), true);
  const unknownCreate = (await lastCall("create"))[1];
  assert.deepEqual(await page.evaluate(() => [...window.__feedbackTest.pendingRequests.values()]), [{ ...unknownCreate, method: "create" }]);
  await page.getByRole("region", { name: "Saved sends", exact: true }).getByRole("button", { name: "Confirm send", exact: true }).click();
  await page.getByRole("heading", { name: "Keep this exact uncertain report", exact: true }).waitFor();
  assert.equal((await lastCall("resume"))[1], unknownCreate.requestId);
  assert.deepEqual((await lastCall("create"))[1], unknownCreate);
  await page.getByRole("region", { name: "Saved sends", exact: true }).waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__feedbackTest.created.size), 1);
  await page.getByRole("textbox", { name: /^Your reply/ }).fill("Keep this exact uncertain reply.");
  await page.evaluate(() => { window.__feedbackTest.failNextReply = true; });
  await button("Send reply").click();
  await page.getByRole("region", { name: "Saved sends", exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: /^Your reply/ }).isEditable(), false);
  const unknownReply = (await lastCall("reply"))[1];
  await page.getByRole("region", { name: "Saved sends", exact: true }).getByRole("button", { name: "Confirm send", exact: true }).click();
  await page.getByRole("region", { name: "Saved sends", exact: true }).waitFor({ state: "detached" });
  assert.deepEqual((await lastCall("reply"))[1], unknownReply);
  assert.equal(await page.getByRole("textbox", { name: /^Your reply/ }).inputValue(), "");
  assert.equal(await page.getByRole("textbox", { name: /^Your reply/ }).isEditable(), true);
  checks.push("Unknown create and reply outcomes preserve and lock the exact original input; saved-send replay confirms that operation once and clears the locked draft.");

  await fresh("?mark-read-race");
  await openThread("Shared file link will not open");
  await page.waitForFunction(() => typeof window.__feedbackTest.rejectHeldMarkRead === "function");
  await page.evaluate(() => window.__feedbackTest.refresh());
  await page.waitForFunction(() => window.__feedbackTest.calls.filter(call => call[0] === "get").length >= 2);
  assert.equal(await callCount("markRead"), 1);
  await page.evaluate(() => window.__feedbackTest.rejectHeldMarkRead());
  await page.evaluate(() => window.__feedbackTest.refresh());
  await page.waitForFunction(() => window.__feedbackTest.calls.filter(call => call[0] === "markRead").length === 2);
  assert.deepEqual(await page.evaluate(() => window.__feedbackTest.calls.filter(call => call[0] === "markRead")), [["markRead", "1", "12"], ["markRead", "1", "12"]]);
  assert.equal(await page.evaluate(() => window.__feedbackTest.threads.find(thread => thread.id === "1").unreadReplies), 0);
  checks.push("A failed markRead request is retried after an intervening refresh replaces its effect; acknowledgement is not permanently suppressed.");

  await fresh("?conversation-pages");
  await openThread("Shared file link will not open");
  await button("Load more replies").waitFor();
  await page.waitForFunction(() => window.__feedbackTest.calls.some(call => call[0] === "markRead"));
  assert.deepEqual((await lastCall("markRead")).slice(1), ["1", "12"]);
  assert.equal(await page.evaluate(() => window.__feedbackTest.threads.find(thread => thread.id === "1").unreadReplies), 1, "a reply on the next page remains unread");
  await button("Load more replies").click();
  await page.getByText("We found the issue with this file. Please try the link once more.", { exact: true }).waitFor();
  await page.waitForFunction(() => window.__feedbackTest.calls.some(call => call[0] === "markRead" && call[2] === "14"));
  await page.evaluate(() => {
    const state = window.__feedbackTest;
    state.messages["1"].push({ id: "15", threadId: "1", author: "233tv-xiaaa-aaaay-aacta-cai", role: "moderator", body: "A new support reply arrived while you were reading.", createdAt: "2026-09-12T12:00:00.000Z" });
    Object.assign(state.threads.find(thread => thread.id === "1"), { lastMessageId: "15", messageCount: 5, unreadReplies: 1 });
    state.refresh();
  });
  await page.getByText("A new support reply arrived while you were reading.", { exact: true }).waitFor();
  await page.getByText("We found the issue with this file. Please try the link once more.", { exact: true }).waitFor();
  await page.waitForFunction(() => window.__feedbackTest.calls.some(call => call[0] === "markRead" && call[2] === "15"));
  checks.push("Discussion pagination leaves unseen pages unread, preserves loaded replies after refresh, and shows a new arrival before acknowledging it.");

  await fresh("?moderator");
  await button("Moderator inbox").click();
  await page.getByText("Wallet balance is not refreshing", { exact: true }).waitFor();
  await screenshots("moderator-inbox");
  await button("Needs reply").click();
  await page.getByText("A calmer notification sound", { exact: true }).waitFor({ state: "detached" });
  assert.equal((await lastCall("moderationList"))[1].needsReply, true);
  assert.equal(await page.getByText("Wallet balance is not refreshing", { exact: true }).count(), 1);
  await openThread("Wallet balance is not refreshing");
  await page.getByRole("heading", { name: "Wallet balance is not refreshing", exact: true }).waitFor();
  await button("Reply as support").waitFor();
  await screenshots("moderator-discussion");
  await page.getByRole("textbox", { name: /^Reply as support/ }).fill("Open IC Wallet and refresh once. Let us know what you see.");
  await button("Reply as support").click();
  await page.getByText("Open IC Wallet and refresh once. Let us know what you see.", { exact: true }).waitFor();
  assert.equal(await callCount("moderationReply"), 1);
  assert.equal(await callCount("reply"), 0, "support replies use the explicit moderator API");
  assert.equal(await callCount("markRead"), 0, "viewing another owner's discussion does not clear their replies");
  assert.equal(await button("Mark resolved").count(), 0, "moderators can reply without controlling a user's resolution state");
  await page.evaluate(() => { window.__feedbackTest.moderator = false; window.__feedbackTest.refresh(); });
  await button("Moderator inbox").waitFor({ state: "detached" });
  await page.getByText("Wallet balance is not refreshing", { exact: true }).waitFor({ state: "detached" });
  assert.equal(await button("Reply as support").count(), 0, "revocation removes the reply form and cached discussion");
  checks.push("Moderator inbox and replies use moderator methods; role revocation clears the private discussion and support controls.");

  await fresh("?empty");
  await page.getByText(/Your conversation starts here/).waitFor();
  await screenshots("empty-inbox");
  await fresh("?error");
  await page.getByText("Feedback is temporarily unavailable. Try again.", { exact: true }).waitFor();
  await screenshots("connection-error");
  await page.getByRole("button", { name: /^(Try again|Retry|Refresh)$/ }).first().click();
  await page.getByText("Shared file link will not open", { exact: true }).waitFor();
  checks.push("Empty and failure states are readable at all three widths, and retry restores the inbox.");

  await fresh();
  await page.evaluate(() => window.__feedbackTest.requestView("thread/1"));
  await page.getByRole("heading", { name: "Shared file link will not open", exact: true }).waitFor();
  checks.push("A tray-style tile view request opens its exact discussion.");

  await fresh("?tray");
  await page.getByText("Shared file link will not open", { exact: true }).waitFor();
  assert.equal(await callCount("markRead"), 0, "viewing the tray preserves unread replies");
  assert.equal((await lastCall("list"))[1].unreadOnly, true);
  await screenshots("tray-replies");
  await page.evaluate(() => { window.__feedbackTest.failNextList = true; window.__feedbackTest.refresh(); });
  await page.getByText("Showing your last update", { exact: true }).waitFor();
  assert.equal(await page.getByText("Shared file link will not open", { exact: true }).count(), 1);
  await screenshots("tray-refresh-error");
  await openThread("Shared file link will not open");
  await page.waitForFunction(() => window.__feedbackTest.dismissed === 1);
  assert.deepEqual(await page.evaluate(() => window.__feedbackTest.opened), [{ appId: "feedback", tileId: "main", reuseExisting: true, view: "thread/1" }]);
  await fresh("?tray&empty");
  await page.getByText("You’re all caught up", { exact: true }).waitFor();
  await screenshots("tray-empty");
  await button("New message").click();
  await page.waitForFunction(() => window.__feedbackTest.dismissed === 1);
  assert.equal(await page.evaluate(() => window.__feedbackTest.opened[0].view), "new");
  await fresh();
  await page.evaluate(() => window.__feedbackTest.requestView("new"));
  await page.getByRole("heading", { name: "What’s on your mind?", exact: true }).waitFor();
  checks.push("The tray preserves unread replies and the last snapshot on failure, opens the exact discussion, and its New message action opens the chooser.");

  await testFeedbackTextLimits({ page, fresh, button, openThread, screenshots, callCount, lastCall, checks });

  assert.deepEqual(externalRequests, [], "the fixture must not contact any external service");
  assert.deepEqual(errors, [], "no uncaught errors or sandbox-blocked form submissions");
  await writeFile(join(output, "report.json"), JSON.stringify({ checks, errors, externalRequests }, null, 2));
  await Promise.all(["failure.json", "failure.png"].map(file => rm(join(output, file), { force: true })));
  console.log(`Feedback browser: ${checks.length} checks passed; screenshots and report in ${output}`);
} catch (error) {
  await host?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  const state = await page?.evaluate(() => ({ calls: window.__feedbackTest?.calls, text: document.body.innerText })).catch(() => null);
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), errors, externalRequests, state }, null, 2));
  console.error(`Failure details: ${join(output, "failure.json")}`);
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
