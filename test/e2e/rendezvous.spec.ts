import { Actor, HttpAgent, type ActorMethod } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { mkdir, writeFile } from "node:fs/promises";
import {
  expect,
  test,
  type BrowserContext,
  type FrameLocator,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import {
  createKernelActor,
  localIdentityFromSeed,
} from "../../packages/neutron-provision/src/kernel.ts";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import { signInWithLocalInternetIdentity } from "./local-ii.ts";
import { encodeAddress } from "../../apps/rendezvous/src/invite.ts";

const configPath = "rendezvous-local.ndeploy.json";

test("two local Internet Identity users open independent Rendezvous workspaces", async ({ browser }) => {
  const aliceRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const bobRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 1 });
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  let alicePrincipal: string | undefined;
  let bobPrincipal: string | undefined;

  try {
    const alice = await signInAndAuthorize(aliceContext, aliceRuntime);
    alicePrincipal = alice.principal;
    const bob = await signInAndAuthorize(bobContext, bobRuntime);
    bobPrincipal = bob.principal;

    const aliceCalendar = await openApp(alice.page, "calendar");
    const bobCalendar = await openApp(bob.page, "calendar");
    await expect(aliceCalendar.getByRole("region", { name: "Calendar views" })).toBeVisible();
    await expect(bobCalendar.getByRole("region", { name: "Calendar views" })).toBeVisible();
    await assertBasicAccessibility(aliceCalendar);
    await alice.page.getByRole("region", { name: "Calendar" }).getByRole("button", { name: "Close tile" }).click();
    await bob.page.getByRole("region", { name: "Calendar" }).getByRole("button", { name: "Close tile" }).click();
    const aliceRendezvous = await openApp(alice.page, "rendezvous");
    await openApp(bob.page, "rendezvous");
    await assertBasicAccessibility(aliceRendezvous);
    expect(alicePrincipal).not.toBe(bobPrincipal);
    expect(aliceRuntime.canisterId).not.toBe(bobRuntime.canisterId);
  } finally {
    if (alicePrincipal) await revoke(aliceRuntime, alicePrincipal);
    if (bobPrincipal) await revoke(bobRuntime, bobPrincipal);
    await aliceContext.close();
    await bobContext.close();
  }
});

test("Calendar and Rendezvous restore together after a workspace reload", async ({ browser }) => {
  test.setTimeout(150_000);
  const runtime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const peerRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 1 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  let principal: string | undefined;
  const title = `Reload-safe block ${Date.now()}`;
  try {
    const session = await signInAndAuthorize(context, runtime);
    principal = session.principal;
    const calendar = await openApp(session.page, "calendar");
    const start = new Date(Date.now() + 3 * 86_400_000); start.setHours(16, 0, 0, 0);
    await addEventAt(calendar, title, start, new Date(start.getTime() + 45 * 60_000));
    const rendezvous = await openApp(session.page, "rendezvous");
    await rendezvous.getByLabel("Their Rendezvous address").fill(encodeAddress({ host: peerRuntime.canisterId }));

    await expect(session.page.locator('[data-app-id="calendar"][data-tile-id="main"]')).toHaveCount(1);
    await expect(session.page.locator('[data-app-id="rendezvous"][data-tile-id="main"]')).toHaveCount(1);
    await session.page.reload({ waitUntil: "domcontentloaded" });
    await expect(session.page.locator('[data-tid="auth-error"]')).toHaveCount(0);

    const restoredCalendar = session.page.frameLocator('[data-app-id="calendar"][data-tile-id="main"]').last();
    const restoredRendezvous = session.page.frameLocator('[data-app-id="rendezvous"][data-tile-id="main"]').last();
    await expect(restoredCalendar.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(restoredRendezvous.getByRole("heading", { name: "Rendezvous", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(restoredCalendar.getByText(title)).toBeVisible({ timeout: 60_000 });
    await expect(restoredRendezvous.getByLabel("Their Rendezvous address")).toHaveValue("");

    // Ordinary application tiles must remain unable to acquire ambient media.
    // A future video feature requires the reviewed, explicit media surface in
    // workplan P5; silently broadening this iframe would be a security defect.
    const mediaPolicy = await restoredCalendar.locator("body").evaluate(() => {
      const policyDocument = document as Document & {
        permissionsPolicy?: { allowsFeature: (feature: string) => boolean };
        featurePolicy?: { allowsFeature: (feature: string) => boolean };
      };
      const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy;
      return {
        camera: policy?.allowsFeature("camera") ?? null,
        microphone: policy?.allowsFeature("microphone") ?? null,
      };
    });
    expect(mediaPolicy).toEqual({ camera: false, microphone: false });
    const calendarFrameAllow =
      (await session.page.locator('[data-app-id="calendar"][data-tile-id="main"]').last().getAttribute("allow")) ?? "";
    expect(calendarFrameAllow).not.toMatch(/camera|microphone/);
    await assertBasicAccessibility(restoredCalendar);
    await assertBasicAccessibility(restoredRendezvous);
  } finally {
    if (principal) await revoke(runtime, principal);
    await context.close();
  }
});

test("Calendar uses a compact agenda and focused block-time editor on mobile", async ({ browser }) => {
  test.setTimeout(120_000);
  const runtime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let principal: string | undefined;
  try {
    const session = await signInAndAuthorize(context, runtime);
    principal = session.principal;
    const calendar = await openApp(session.page, "calendar");
    await expect(calendar.getByRole("button", { name: "Agenda" })).toHaveClass(/fc-button-active/);
    await calendar.getByRole("button", { name: "Block time" }).click();
    await expect(calendar.getByLabel("Title")).toBeFocused();
    await expect(calendar.getByLabel("Title")).toHaveValue("Busy");
    expect(await calendar.locator("body").evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    if (principal) await revoke(runtime, principal);
    await context.close();
  }
});

test("Rendezvous explains an empty availability search and lets the user recover", async ({ browser }) => {
  test.setTimeout(150_000);
  const runtime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const peerRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 1 });
  const context = await browser.newContext();
  let principal: string | undefined;
  try {
    const session = await signInAndAuthorize(context, runtime);
    principal = session.principal;
    const blockedDay = new Date(Date.now() + 86_400_000); blockedDay.setHours(9, 0, 0, 0);
    const blockedEnd = new Date(blockedDay); blockedEnd.setHours(17, 0, 0, 0);
    const calendar = await openApp(session.page, "calendar");
    await addEventAt(calendar, `Unavailable day ${Date.now()}`, blockedDay, blockedEnd);

    const rendezvous = await openApp(session.page, "rendezvous");
    await rendezvous.getByLabel("Their Rendezvous address").fill(encodeAddress({ host: peerRuntime.canisterId }));
    await rendezvous.getByRole("button", { name: "Choose dates" }).click();
    const blockedDate = localInput(blockedDay).slice(0, 10);
    await rendezvous.getByLabel("From").fill(blockedDate);
    await rendezvous.getByLabel("Through").fill(blockedDate);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(blockedDay);
    const dayChecks = rendezvous.locator(".weekday-picker").getByRole("checkbox");
    for (let index = 0; index < await dayChecks.count(); index += 1) await dayChecks.nth(index).uncheck();
    await rendezvous.getByLabel(weekday, { exact: true }).check();
    await rendezvous.getByLabel("Earliest").fill("09:00");
    await rendezvous.getByLabel("Latest").fill("17:00");
    await rendezvous.getByRole("button", { name: "Find available times" }).click();
    await expect(rendezvous.getByRole("heading", { name: "Choose exact options" })).toBeVisible();
    await expect(rendezvous.getByRole("status")).toContainText("No available times matched this search");
    await expect(rendezvous.getByRole("status")).toContainText("Try a wider window, different days, or another time of day.");
    await expect(rendezvous.locator(".suggestions").getByRole("checkbox")).toHaveCount(0);
    await expect(rendezvous.getByRole("button", { name: "Review 0 options" })).toBeDisabled();

    await rendezvous.getByRole("button", { name: "Back" }).click();
    const openDay = new Date(blockedDay.getTime() + 86_400_000);
    const openDate = localInput(openDay).slice(0, 10);
    await rendezvous.getByLabel("From").fill(openDate);
    await rendezvous.getByLabel("Through").fill(openDate);
    const openWeekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(openDay);
    await rendezvous.getByLabel(weekday, { exact: true }).uncheck();
    await rendezvous.getByLabel(openWeekday, { exact: true }).check();
    await rendezvous.getByRole("button", { name: "Find available times" }).click();
    await expect(rendezvous.locator(".suggestions").getByRole("checkbox").first()).toBeVisible({ timeout: 60_000 });
    await expect(rendezvous.getByRole("status")).toHaveCount(0);
  } finally {
    if (principal) await revoke(runtime, principal);
    await context.close();
  }
});

test("a selected Calendar range opens a prefilled Rendezvous proposal", async ({ browser }) => {
  test.setTimeout(120_000);
  const runtime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const peerRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 1 });
  const context = await browser.newContext();
  let principal: string | undefined;
  try {
    const session = await signInAndAuthorize(context, runtime);
    principal = session.principal;
    const calendar = await openApp(session.page, "calendar");
    const start = new Date(Date.now() + 5 * 86_400_000); start.setHours(13, 15, 0, 0);
    const end = new Date(start.getTime() + 45 * 60_000);
    await calendar.getByLabel("Starts", { exact: true }).fill(localInput(start));
    await calendar.getByLabel("Ends", { exact: true }).fill(localInput(end));
    await calendar.getByRole("button", { name: "Find a time with someone" }).click();

    const rendezvous = session.page.frameLocator('[data-app-id="rendezvous"][data-tile-id="main"]').last();
    await expect(rendezvous.getByRole("heading", { name: "Rendezvous", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(rendezvous.getByRole("status").filter({ hasText: "Calendar range imported" })).toBeVisible();
    await expect(rendezvous.getByLabel("Duration in minutes")).toHaveValue("45");
    await rendezvous.getByLabel("Their Rendezvous address").fill(encodeAddress({ host: peerRuntime.canisterId }));
    await rendezvous.getByRole("button", { name: "Choose dates" }).click();
    await expect(rendezvous.getByLabel("From")).toHaveValue(localInput(start).slice(0, 10));
    await expect(rendezvous.getByLabel("Through")).toHaveValue(localInput(end).slice(0, 10));
    await expect(rendezvous.getByLabel("Earliest")).toHaveValue("13:15");
    await expect(rendezvous.getByLabel("Latest")).toHaveValue("14:00");
  } finally {
    if (principal) await revoke(runtime, principal);
    await context.close();
  }
});

test("Calendar loads events when the owner navigates beyond the initial year", async ({ browser }) => {
  test.setTimeout(150_000);
  const runtime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const context = await browser.newContext();
  let principal: string | undefined;
  const title = `Future navigation ${Date.now()}`;
  try {
    const session = await signInAndAuthorize(context, runtime);
    principal = session.principal;
    const calendar = await openApp(session.page, "calendar");
    const start = new Date(Date.now() + 400 * 86_400_000); start.setHours(11, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    await calendar.getByLabel("Title").fill(title);
    await calendar.getByLabel("Starts", { exact: true }).fill(localInput(start));
    await calendar.getByLabel("Ends", { exact: true }).fill(localInput(end));
    await calendar.getByRole("button", { name: "Add to calendar" }).click();
    await calendar.getByRole("button", { name: "Month" }).click();
    for (let index = 0; index < 13; index += 1) await calendar.locator(".fc-next-button").click();
    await expect(calendar.locator(".fc-event-title").filter({ hasText: title })).toBeVisible({ timeout: 60_000 });
  } finally {
    if (principal) await revoke(runtime, principal);
    await context.close();
  }
});

test("a user creates, edits, and removes a recurring calendar series", async ({ browser }) => {
  test.setTimeout(240_000);
  const runtime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const context = await browser.newContext();
  let principal: string | undefined;
  const suffix = String(Date.now());
  const originalTitle = `Weekly block ${suffix}`;
  const updatedTitle = `Weekly focus ${suffix}`;
  try {
    const session = await signInAndAuthorize(context, runtime);
    principal = session.principal;
    const calendar = await openApp(session.page, "calendar");
    const start = new Date(Date.now() + 86_400_000); start.setHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 45 * 60_000);
    await calendar.getByLabel("Title").fill(originalTitle);
    await calendar.getByLabel("Starts", { exact: true }).fill(localInput(start));
    await calendar.getByLabel("Ends", { exact: true }).fill(localInput(end));
    await calendar.getByLabel("Repeat").selectOption("daily");
    await calendar.locator(".recurrence-editor select").nth(1).selectOption("until");
    const excessiveUntil = new Date(start); excessiveUntil.setFullYear(start.getFullYear() + 3);
    await calendar.getByLabel("Repeat through").fill(localInput(excessiveUntil).slice(0, 10));
    await expect(calendar.getByRole("alert").filter({ hasText: "more than 730 occurrences" })).toBeVisible();
    await expect(calendar.getByRole("button", { name: "Add to calendar" })).toBeDisabled();
    await calendar.locator(".recurrence-editor select").nth(1).selectOption("count");
    await calendar.getByLabel("Repeat").selectOption("weekly");
    await calendar.getByLabel("Occurrences").fill("3");
    await calendar.getByRole("button", { name: "Add to calendar" }).click();
    const createError = await calendar.locator("output").filter({ hasNotText: "Loading your calendar" }).textContent({ timeout: 3_000 }).catch(() => null);
    if (createError) throw new Error(`Recurring create failed: ${createError}`);
    await expect(calendar.locator(".upcoming button").filter({ hasText: originalTitle })).toHaveCount(3, { timeout: 60_000 });

    await calendar.locator(".upcoming button").filter({ hasText: originalTitle }).first().click();
    await calendar.getByLabel("Entire series").check();
    await calendar.getByLabel("Title").fill(updatedTitle);
    await calendar.getByRole("button", { name: "Save changes" }).click();
    await expect(calendar.locator(".upcoming button").filter({ hasText: updatedTitle })).toHaveCount(3, { timeout: 60_000 });

    await calendar.locator(".upcoming button").filter({ hasText: updatedTitle }).first().click();
    await calendar.getByRole("button", { name: "Delete event" }).click();
    await calendar.getByRole("button", { name: "Confirm delete event" }).click();
    await expect(calendar.locator(".upcoming button").filter({ hasText: updatedTitle })).toHaveCount(2, { timeout: 60_000 });

    await calendar.locator(".upcoming button").filter({ hasText: updatedTitle }).first().click();
    await calendar.getByLabel("Entire series").check();
    await calendar.getByRole("button", { name: "Delete series" }).click();
    await calendar.getByRole("button", { name: "Confirm delete series" }).click();
    await expect(calendar.getByText(updatedTitle)).toHaveCount(0, { timeout: 60_000 });
  } finally {
    if (principal) await revoke(runtime, principal);
    await context.close();
  }
});

test("an owner drags and resizes an event on the real calendar grid", async ({ browser }) => {
  test.setTimeout(180_000);
  const runtime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const context = await browser.newContext();
  let principal: string | undefined;
  const title = `Pointer persistence ${Date.now()}`;
  try {
    const session = await signInAndAuthorize(context, runtime); principal = session.principal;
    const calendar = await openApp(session.page, "calendar");
    const originalStart = new Date(Date.now() + 86_400_000); originalStart.setHours(18, 0, 0, 0);
    const originalEnd = new Date(originalStart.getTime() + 60 * 60_000);
    await addEventAt(calendar, title, originalStart, originalEnd);
    await calendar.getByRole("button", { name: "Day", exact: true }).click();
    await calendar.locator(".fc-next-button").click();

    const event = calendar.locator(".fc-timegrid-event").filter({ hasText: title });
    await expect(event).toBeVisible({ timeout: 60_000 });
    const nextSlot = calendar.locator('.fc-timegrid-slot[data-time="18:30:00"]').first();
    await dragBetween(session.page, event, nextSlot);
    await expect.poll(async () => {
      await event.click();
      return calendar.getByLabel("Starts", { exact: true }).inputValue();
    }, { timeout: 60_000 }).toBe(localInput(new Date(originalStart.getTime() + 30 * 60_000)));

    await session.page.reload({ waitUntil: "domcontentloaded" });
    const restored = session.page.frameLocator('[data-app-id="calendar"][data-tile-id="main"]').last();
    await expect(restored.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible({ timeout: 60_000 });
    await restored.getByRole("button", { name: "Day", exact: true }).click();
    await restored.locator(".fc-next-button").click();
    const restoredEvent = restored.locator(".fc-timegrid-event").filter({ hasText: title });
    await expect(restoredEvent).toBeVisible({ timeout: 60_000 });
    await restoredEvent.click();
    await restoredEvent.hover();
    const resizer = restoredEvent.locator(".fc-event-resizer-end");
    await expect(resizer).toBeVisible();
    const resizeTarget = restored.locator('.fc-timegrid-slot[data-time="20:00:00"]').first();
    await dragBetween(session.page, resizer, resizeTarget);
    await session.page.waitForTimeout(2_000);
    await session.page.reload({ waitUntil: "domcontentloaded" });
    await expect(restored.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible({ timeout: 60_000 });
    await restored.getByRole("button", { name: "Day", exact: true }).click();
    await restored.locator(".fc-next-button").click();
    await restored.locator(".fc-timegrid-event").filter({ hasText: title }).focus();
    await session.page.keyboard.press("Enter");
    await expect(restored.getByLabel("Ends", { exact: true })).toHaveValue(localInput(new Date(originalEnd.getTime() + 75 * 60_000)));
    await restored.getByRole("button", { name: "Delete series" }).click();
    await restored.getByRole("button", { name: "Confirm delete series" }).click();
    await expect(restored.getByText(title)).toHaveCount(0, { timeout: 60_000 });
  } finally {
    if (principal) await revoke(runtime, principal);
    await context.close();
  }
});

test("a stale native drag rolls back visibly and preserves the newer event", async ({ browser }) => {
  test.setTimeout(180_000);
  const runtime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const context = await browser.newContext();
  let principal: string | undefined;
  const runId = Date.now();
  const originalTitle = `Stale pointer ${runId}`;
  try {
    const current = await signInAndAuthorize(context, runtime); principal = current.principal;
    const currentCalendar = await openApp(current.page, "calendar");
    // Vary the quarter-hour fixture so repeated local runs do not leave stacked
    // events that intercept one another's native pointer hit target.
    const startHour = runId % 5;
    const startMinute = Math.floor(runId / 10) % 3 * 15;
    const start = new Date(runId + 2 * 86_400_000); start.setHours(startHour, startMinute, 0, 0);
    const end = new Date(start.getTime() + 15 * 60_000);
    const committedStart = new Date(start.getTime() + 15 * 60_000);
    const staleAttemptStart = new Date(start.getTime() + 30 * 60_000);
    const slotTime = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:00`;
    await addEventAt(currentCalendar, originalTitle, start, end);
    await currentCalendar.getByRole("button", { name: "Day", exact: true }).click();
    await currentCalendar.locator(".fc-next-button").click();
    await currentCalendar.locator(".fc-next-button").click();

    const stalePage = await context.newPage();
    await stalePage.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
    await expect(stalePage.locator('[data-tid="launcher-open"]')).toBeVisible({ timeout: 60_000 });
    const staleCalendar = await openApp(stalePage, "calendar");
    await staleCalendar.getByRole("button", { name: "Day", exact: true }).click();
    await staleCalendar.locator(".fc-next-button").click();
    await staleCalendar.locator(".fc-next-button").click();
    const staleEvent = staleCalendar.locator(".fc-timegrid-event:not(.fc-event-dragging)").filter({ hasText: originalTitle });
    await expect(staleEvent).toBeVisible({ timeout: 60_000 });
    const beforeTime = await staleEvent.locator(".fc-event-time").innerText();

    // Move the occurrence in the current tab after the stale tab has loaded it.
    // This guarantees the stale tab holds an older occurrence CAS revision; a
    // series-title edit is not sufficient because it need not bump that value.
    const currentEvent = currentCalendar.locator(".fc-timegrid-event:not(.fc-event-dragging)").filter({ hasText: originalTitle });
    const committedTarget = currentCalendar.locator(`.fc-timegrid-slot[data-time="${slotTime(committedStart)}"]`).first();
    await dragBetween(current.page, currentEvent, committedTarget);
    await expect.poll(async () => {
      await currentEvent.focus();
      await current.page.keyboard.press("Enter");
      return currentCalendar.getByLabel("Starts", { exact: true }).inputValue();
    }, { timeout: 60_000 }).toBe(localInput(committedStart));

    const target = staleCalendar.locator(`.fc-timegrid-slot[data-time="${slotTime(staleAttemptStart)}"]`).first();
    await dragBetween(stalePage, staleEvent, target);
    await expect(staleCalendar.locator("output")).toContainText("Could not change event time", { timeout: 60_000 });
    await expect(staleEvent).toBeVisible();
    await expect(staleEvent.locator(".fc-event-time")).toHaveText(beforeTime);
    await expect(staleCalendar.locator(".fc-event-dragging").filter({ hasText: originalTitle })).toHaveCount(0);

    await stalePage.reload({ waitUntil: "domcontentloaded" });
    const refreshed = stalePage.frameLocator('[data-app-id="calendar"][data-tile-id="main"]').last();
    await expect(refreshed.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible({ timeout: 60_000 });
    await refreshed.getByRole("button", { name: "Day", exact: true }).click();
    await refreshed.locator(".fc-next-button").click();
    await refreshed.locator(".fc-next-button").click();
    await refreshed.locator(".fc-timegrid-event").filter({ hasText: originalTitle }).focus();
    await stalePage.keyboard.press("Enter");
    await expect(refreshed.getByLabel("Starts", { exact: true })).toHaveValue(localInput(committedStart));
    await refreshed.getByRole("button", { name: "Delete series" }).click();
    await refreshed.getByRole("button", { name: "Confirm delete series" }).click();
    await expect(refreshed.getByText(originalTitle)).toHaveCount(0, { timeout: 60_000 });
  } finally {
    if (principal) await revoke(runtime, principal);
    await context.close();
  }
});

test("a manually selected exact time is the time the peer receives", async ({ browser }) => {
  test.setTimeout(180_000);
  const runtime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const peerRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 1 });
  const context = await browser.newContext(); const peerContext = await browser.newContext();
  let principal: string | undefined; let peerPrincipal: string | undefined;
  const meeting = `Manually chosen ${Date.now()}`;
  try {
    const session = await signInAndAuthorize(context, runtime);
    principal = session.principal;
    const rendezvous = await openApp(session.page, "rendezvous");
    await expect(rendezvous.getByLabel("Your Rendezvous address")).toHaveValue(/^RVC1-/);
    await rendezvous.getByLabel("Their Rendezvous address").fill(encodeAddress({ host: peerRuntime.canisterId }));
    await rendezvous.getByLabel("Meeting title").fill(meeting);
    await rendezvous.getByRole("button", { name: "Choose dates" }).click();
    await rendezvous.getByRole("button", { name: "Find available times" }).click();
    await expect(rendezvous.getByRole("heading", { name: "Choose exact options" })).toBeVisible({ timeout: 60_000 });
    const exact = new Date(Date.now() + 10 * 86_400_000); exact.setHours(13, 17, 0, 0);
    await rendezvous.getByLabel("Add a specific time").fill(localInput(exact));
    await rendezvous.getByRole("button", { name: "Check and add" }).click();
    await expect(rendezvous.getByText("1 of 16 selected")).toBeVisible({ timeout: 60_000 });
    await expect(rendezvous.locator(".suggestions label").filter({ hasText: exact.getMinutes().toString().padStart(2, "0") })).toHaveCount(1);
    await rendezvous.getByRole("button", { name: "Review 1 option" }).click();
    await expect(rendezvous.locator(".review")).toContainText("1 exact option");
    await rendezvous.getByRole("button", { name: "Send proposal" }).click();

    const peerSession = await signInAndAuthorize(peerContext, peerRuntime); peerPrincipal = peerSession.principal;
    const peerRendezvous = await openApp(peerSession.page, "rendezvous");
    await expect.poll(async () => { await peerRendezvous.getByRole("button", { name: "Refresh" }).click(); return peerRendezvous.getByRole("heading", { name: meeting }).count(); }, { timeout: 60_000 }).toBe(1);
    const received = peerRendezvous.locator("article.negotiation").filter({ hasText: meeting });
    await expect(received.getByRole("radio")).toHaveCount(1);
    const receivedDate = new Date(await received.locator(".received-options label span").innerText());
    expect(receivedDate.getTime()).toBe(exact.getTime());
  } finally {
    if (principal) await revoke(runtime, principal);
    if (peerPrincipal) await revoke(peerRuntime, peerPrincipal);
    await context.close(); await peerContext.close();
  }
});

test("Alice chooses Bob from Contacts and the bound address is revalidated before send", async ({ browser }) => {
  test.setTimeout(180_000);
  const aliceRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const bobRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 1 });
  const aliceContext = await browser.newContext(); const bobContext = await browser.newContext();
  let alicePrincipal: string | undefined; let bobPrincipal: string | undefined;
  const contactName = `Bob Contact ${Date.now()}`; const meeting = `Contact-selected ${Date.now()}`;
  try {
    const alice = await signInAndAuthorize(aliceContext, aliceRuntime); alicePrincipal = alice.principal;
    await upsertNeutronContact(alice.page, contactName, bobRuntime.canisterId);

    const rendezvous = await openApp(alice.page, "rendezvous");
    await rendezvous.getByLabel("Contact name").fill(contactName);
    await rendezvous.getByRole("button", { name: "Search Contacts" }).click();
    const match = rendezvous.locator(".contact-results button").filter({ hasText: contactName });
    await expect(match).toBeVisible({ timeout: 60_000 });
    await expect(match).toContainText(bobRuntime.canisterId);
    await match.click();
    await expect(rendezvous.locator(".selected-contact")).toContainText(contactName);
    await expect(rendezvous.getByText("address checked again before send")).toBeVisible();
    await rendezvous.getByLabel("Meeting title").fill(meeting);
    await composeAndSendProposal(rendezvous);
    await expect(rendezvous.getByRole("heading", { name: meeting })).toBeVisible({ timeout: 60_000 });

    const bob = await signInAndAuthorize(bobContext, bobRuntime); bobPrincipal = bob.principal;
    const bobRendezvous = await openApp(bob.page, "rendezvous");
    await expect.poll(async () => { await bobRendezvous.getByRole("button", { name: "Refresh" }).click(); return bobRendezvous.getByRole("heading", { name: meeting }).count(); }, { timeout: 60_000 }).toBe(1);
  } finally {
    if (alicePrincipal) await revoke(aliceRuntime, alicePrincipal);
    if (bobPrincipal) await revoke(bobRuntime, bobPrincipal);
    await aliceContext.close(); await bobContext.close();
  }
});

test("Bob suggests an alternative and Alice explicitly confirms it", async ({ browser }) => {
  test.setTimeout(180_000);
  const aliceRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const bobRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 1 });
  const aliceContext = await browser.newContext(); const bobContext = await browser.newContext();
  let alicePrincipal: string | undefined; let bobPrincipal: string | undefined;
  const meeting = `Counter flow ${Date.now()}`;
  try {
    const alice = await signInAndAuthorize(aliceContext, aliceRuntime); alicePrincipal = alice.principal;
    const bob = await signInAndAuthorize(bobContext, bobRuntime); bobPrincipal = bob.principal;
    const aliceRendezvous = await openApp(alice.page, "rendezvous");
    await aliceRendezvous.getByLabel("Their Rendezvous address").fill(bobRuntime.canisterId);
    await aliceRendezvous.getByLabel("Meeting title").fill(meeting);
    await composeAndSendProposal(aliceRendezvous);

    const bobRendezvous = await openApp(bob.page, "rendezvous");
    await expect.poll(async () => { await bobRendezvous.getByRole("button", { name: "Refresh" }).click(); return bobRendezvous.getByRole("heading", { name: meeting }).count(); }, { timeout: 60_000 }).toBe(1);
    const bobNegotiation = bobRendezvous.locator("article.negotiation").filter({ hasText: meeting });
    const proposed = new Date(await bobNegotiation.locator(".received-options label span").first().innerText());
    expect(Number.isNaN(proposed.getTime())).toBe(false);
    const alternative = new Date(proposed.getTime() + 60 * 60_000);
    await bobNegotiation.getByRole("button", { name: "Suggest another time" }).click();
    await bobNegotiation.getByLabel("Alternative time").fill(localInput(alternative));
    await bobNegotiation.getByRole("button", { name: "Check and send alternative" }).click();
    await expect(bobNegotiation.getByText("Alternative sent. Waiting for the organizer to choose.")).toBeVisible({ timeout: 60_000 });

    await aliceRendezvous.getByRole("button", { name: "Refresh" }).click();
    const aliceNegotiation = aliceRendezvous.locator("article.negotiation").filter({ hasText: meeting });
    await expect(aliceNegotiation.getByText("They suggested another time", { exact: true })).toBeVisible({ timeout: 60_000 });
    await aliceNegotiation.getByRole("radio").check();
    await aliceNegotiation.getByRole("button", { name: "Accept their alternative" }).click();
    await expect(aliceNegotiation.getByText("Scheduled", { exact: true })).toBeVisible({ timeout: 60_000 });
    await bobRendezvous.getByRole("button", { name: "Refresh" }).click();
    await expect(bobNegotiation.getByText("Scheduled", { exact: true })).toBeVisible({ timeout: 60_000 });
  } finally {
    if (alicePrincipal) await revoke(aliceRuntime, alicePrincipal);
    if (bobPrincipal) await revoke(bobRuntime, bobPrincipal);
    await aliceContext.close(); await bobContext.close();
  }
});

test("Alice and Bob privately negotiate and confirm a meeting", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const aliceRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const bobRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 1 });
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const diagnostic = new SelfCallDiagnostic();
  await diagnostic.install(aliceContext);
  await diagnostic.install(bobContext);
  let alicePrincipal: string | undefined;
  let bobPrincipal: string | undefined;
  const suffix = String(Date.now());
  const privateDay = 60 + Number(BigInt(suffix) % 20n);
  const alicePrivate = `Alice private ${suffix}`;
  const bobPrivate = `Bob private ${suffix}`;
  const meeting = `Rendezvous sync ${suffix}`;

  try {
    const alice = await signInAndAuthorize(aliceContext, aliceRuntime);
    alicePrincipal = alice.principal;
    const bob = await signInAndAuthorize(bobContext, bobRuntime);
    bobPrincipal = bob.principal;

    const aliceCalendar = await openApp(alice.page, "calendar");
    await addPrivateEvent(aliceCalendar, alicePrivate, privateDay);
    const bobCalendar = await openApp(bob.page, "calendar");
    await addPrivateEvent(bobCalendar, bobPrivate, privateDay + 21);
    await expect(aliceCalendar.getByText(bobPrivate)).toHaveCount(0);
    await expect(bobCalendar.getByText(alicePrivate)).toHaveCount(0);
    await closeApp(alice.page, "Calendar");
    await closeApp(bob.page, "Calendar");

    const aliceContact = `Alice · sovereign calendar ${suffix}`;
    await upsertNeutronContact(bob.page, aliceContact, aliceRuntime.canisterId);
    const bobContact = `Bob · sovereign calendar ${suffix}`;
    await upsertNeutronContact(alice.page, bobContact, bobRuntime.canisterId);
    const aliceRendezvous = await openApp(alice.page, "rendezvous");
    await aliceRendezvous.getByLabel("Contact name").fill(bobContact);
    await aliceRendezvous.getByRole("button", { name: "Search Contacts" }).click();
    const bobMatch = aliceRendezvous.locator(".contact-results button").filter({ hasText: bobContact });
    await expect(bobMatch).toContainText(bobRuntime.canisterId, { timeout: 60_000 });
    await bobMatch.click();
    await expect(aliceRendezvous.locator(".selected-contact")).toContainText("address checked again before send");
    await aliceRendezvous.getByLabel("Meeting title").fill(meeting);
    await composeAndSendProposal(aliceRendezvous);
    await expect(aliceRendezvous.getByRole("heading", { name: meeting })).toBeVisible({ timeout: 60_000 });
    const aliceProposed = aliceRendezvous.locator("article.negotiation").filter({ hasText: meeting });
    await aliceProposed.getByText("Technical delivery").click();
    await expect(aliceProposed.getByText("Delivery: delivered")).toBeVisible();
    await submissionScreenshot(alice.page, "01-alice-proposal.jpg");

    const bobRendezvous = await openApp(bob.page, "rendezvous");
    await expect.poll(async () => {
      await bobRendezvous.getByRole("button", { name: "Refresh" }).click();
      return bobRendezvous.getByRole("heading", { name: meeting }).count();
    }, { timeout: 60_000 }).toBe(1);
    const bobNegotiation = bobRendezvous.locator("article.negotiation").filter({ hasText: meeting });
    await expect(bobNegotiation.getByText(`From ${aliceContact}`, { exact: true })).toBeVisible();
    await expect(bobNegotiation.getByText(`Neutron ${aliceRuntime.canisterId}`, { exact: true })).toBeVisible();
    await expect(bobNegotiation.getByText("From another Neutron", { exact: true })).toHaveCount(0);
    const trayButton = bob.page.locator('[data-tid="app-tray-button-rendezvous"]');
    await expect(trayButton).toBeVisible();
    await trayButton.click();
    const tray = bob.page.frameLocator('iframe[data-tid="app-tray-frame"][data-app-id="rendezvous"]');
    await expect(tray.getByRole("button", { name: "Review requests" })).toBeVisible();
    await expect(tray.getByText(/^[1-9][0-9]* need attention/)).toBeVisible();
    await expect(tray.getByText(meeting)).toHaveCount(0);
    await tray.getByRole("button", { name: "Review requests" }).click();
    await expect(bob.page.locator('iframe[data-tid="app-tray-frame"][data-app-id="rendezvous"]')).toHaveCount(0);
    await submissionScreenshot(bob.page, "02-bob-received.jpg");
    await bobNegotiation.getByRole("radio").first().check();
    await bobNegotiation.getByRole("button", { name: "Accept selected time" }).click();
    await expect(bobNegotiation.getByText("Scheduled", { exact: true })).toBeVisible({ timeout: 60_000 });

    await aliceRendezvous.getByRole("button", { name: "Refresh" }).click();
    const aliceNegotiation = aliceRendezvous.locator("article.negotiation").filter({ hasText: meeting });
    await expect(aliceNegotiation.getByText("Scheduled", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(aliceRendezvous.getByText(alicePrivate)).toHaveCount(0);
    await expect(aliceRendezvous.getByText(bobPrivate)).toHaveCount(0);
    await expect(bobRendezvous.getByText(alicePrivate)).toHaveCount(0);
    await expect(bobRendezvous.getByText(bobPrivate)).toHaveCount(0);

    await closeApp(alice.page, "Rendezvous");
    await closeApp(bob.page, "Rendezvous");
    const aliceConfirmed = await openApp(alice.page, "calendar");
    const bobConfirmed = await openApp(bob.page, "calendar");
    await expect(aliceConfirmed.getByText(meeting)).toBeVisible();
    await expect(bobConfirmed.getByText(meeting)).toBeVisible();
    const alicePrivateDate = new Date(Date.now() + privateDay * 86_400_000); alicePrivateDate.setHours(15, 0, 0, 0);
    const bobPrivateDate = new Date(Date.now() + (privateDay + 21) * 86_400_000); bobPrivateDate.setHours(15, 0, 0, 0);
    await showCalendarMonth(aliceConfirmed, alicePrivateDate);
    await expect(aliceConfirmed.locator(".fc-event-title").filter({ hasText: alicePrivate })).toBeVisible();
    await showCalendarMonth(bobConfirmed, bobPrivateDate);
    await expect(bobConfirmed.locator(".fc-event-title").filter({ hasText: bobPrivate })).toBeVisible();
    await aliceConfirmed.getByRole("button", { name: "Today" }).click();
    await aliceConfirmed.getByRole("button", { name: "Week", exact: true }).click();
    await aliceConfirmed.locator(".fc-next-button").click();
    await expect(aliceConfirmed.locator(".fc-event-title").filter({ hasText: meeting })).toBeVisible({ timeout: 60_000 });
    await submissionScreenshot(alice.page, "03-alice-confirmed-calendar.jpg");
    await bobConfirmed.getByRole("button", { name: "Today" }).click();
    await bobConfirmed.getByRole("button", { name: "Week", exact: true }).click();
    await bobConfirmed.locator(".fc-next-button").click();
    await expect(bobConfirmed.locator(".fc-event-title").filter({ hasText: meeting })).toBeVisible({ timeout: 60_000 });
    await submissionScreenshot(bob.page, "04-bob-confirmed-calendar.jpg");
    await aliceConfirmed.locator(".fc-event-title").filter({ hasText: meeting }).click();
    await expect(aliceConfirmed.getByText("Scheduled through Rendezvous")).toBeVisible();
    await expect(aliceConfirmed.getByLabel("Title")).toBeDisabled();
    await expect(aliceConfirmed.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await submissionScreenshot(alice.page, "05-alice-meeting-details.jpg");
    await aliceConfirmed.getByRole("button", { name: "Open meeting in Rendezvous" }).click();
    const reopenedRendezvous = alice.page.frameLocator('[data-app-id="rendezvous"][data-tile-id="main"]').last();
    await expect(reopenedRendezvous.getByRole("status").filter({ hasText: "Meeting opened from Calendar" })).toBeVisible({ timeout: 60_000 });
    await expect(reopenedRendezvous.locator("article.negotiation--focused").filter({ hasText: meeting })).toBeVisible();
    await submissionScreenshot(alice.page, "06-alice-meeting-negotiation.jpg");

    const ordinaryTile = alice.page.locator('iframe[data-app-id="rendezvous"][data-tile-id="main"]').last();
    await expect(ordinaryTile).not.toHaveAttribute("allow", /camera|microphone/);
    await reopenedRendezvous.getByRole("button", { name: "Join video meeting" }).click();
    const consent = alice.page.locator('[data-tid="media-session-consent"]');
    await expect(consent).toBeVisible();
    await expect(consent).toContainText(`Join “${meeting}” with browser-to-browser audio and video`);
    await expect(consent).toContainText("camera + microphone");
    await expect(consent).toContainText("1 hour");
    await consent.locator('[data-tid="media-session-approve"]').click();

    const overlay = alice.page.locator('[data-tid="media-session-overlay"]');
    await expect(overlay).toBeVisible({ timeout: 60_000 });
    const kernelPolicy = await alice.page.evaluate(async () =>
      (await fetch("/", { cache: "no-store" })).headers.get("permissions-policy"),
    );
    expect(kernelPolicy).toBe("camera=*, geolocation=(), microphone=*");
    const mediaElement = overlay.locator('iframe[title="Rendezvous media session"]');
    const mediaSrc = await mediaElement.getAttribute("src");
    expect(mediaSrc).toBeTruthy();
    const mediaUrl = new URL(mediaSrc!);
    await expect(mediaElement).toHaveAttribute("allow", `camera ${mediaUrl.origin}; microphone ${mediaUrl.origin}`);
    await expect(mediaElement).toHaveAttribute("sandbox", /allow-scripts/);
    await expect(mediaElement).toHaveAttribute("sandbox", /allow-same-origin/);
    await expect(mediaElement).toHaveAttribute("credentialless", "true");
    const ordinaryUrl = new URL((await ordinaryTile.getAttribute("src"))!);
    expect(mediaUrl.origin).not.toBe(ordinaryUrl.origin);
    expect(mediaUrl.hostname).toMatch(/^m[0-9a-f]{24}--/);

    const media = alice.page.frameLocator('iframe[title="Rendezvous media session"]');
    await expect(media.getByRole("button", { name: "Start camera & microphone" })).toBeVisible();

    await bobConfirmed.locator(".fc-event-title").filter({ hasText: meeting }).click();
    await expect(bobConfirmed.getByText("Scheduled through Rendezvous")).toBeVisible();
    await bobConfirmed.getByRole("button", { name: "Open meeting in Rendezvous" }).click();
    const bobMeeting = bob.page.frameLocator('[data-app-id="rendezvous"][data-tile-id="main"]').last();
    await expect(bobMeeting.locator("article.negotiation--focused").filter({ hasText: meeting })).toBeVisible({ timeout: 60_000 });
    await bobMeeting.getByRole("button", { name: "Join video meeting" }).click();
    const bobConsent = bob.page.locator('[data-tid="media-session-consent"]');
    await expect(bobConsent).toContainText(`Join “${meeting}” with browser-to-browser audio and video`);
    await bobConsent.locator('[data-tid="media-session-approve"]').click();
    const bobOverlay = bob.page.locator('[data-tid="media-session-overlay"]');
    await expect(bobOverlay).toBeVisible({ timeout: 60_000 });
    const bobMedia = bob.page.frameLocator('iframe[title="Rendezvous media session"]');

    await media.getByRole("button", { name: "Start camera & microphone" }).click();
    await bobMedia.getByRole("button", { name: "Start camera & microphone" }).click();
    await expect(media.getByText("Direct browser connection", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(bobMedia.getByText("Direct browser connection", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(media.locator("#remote")).toBeVisible();
    await expect(bobMedia.locator("#remote")).toBeVisible();

    await overlay.locator('[data-tid="media-session-end"]').click();
    await bobOverlay.locator('[data-tid="media-session-end"]').click();
    await expect(overlay).toHaveCount(0);
    await expect(bobOverlay).toHaveCount(0);
    await expect(alice.page.locator('iframe[title="Rendezvous media session"]')).toHaveCount(0);
    expect(diagnostic.containsAny([alicePrivate, bobPrivate])).toBe(false);
  } finally {
    if (alicePrincipal) await revoke(aliceRuntime, alicePrincipal);
    if (bobPrincipal) await revoke(bobRuntime, bobPrincipal);
    await diagnostic.save(testInfo);
    await aliceContext.close();
    await bobContext.close();
  }
});

test("Bob cannot accept a slot that became busy after the offer arrived", async ({ browser }) => {
  test.setTimeout(180_000);
  const aliceRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const bobRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 1 });
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  let alicePrincipal: string | undefined;
  let bobPrincipal: string | undefined;
  const suffix = String(Date.now());
  const meeting = `Conflict-safe meeting ${suffix}`;
  const bobConflict = `Bob intervening event ${suffix}`;

  try {
    const alice = await signInAndAuthorize(aliceContext, aliceRuntime);
    alicePrincipal = alice.principal;
    const bob = await signInAndAuthorize(bobContext, bobRuntime);
    bobPrincipal = bob.principal;

    const aliceRendezvous = await openApp(alice.page, "rendezvous");
    await aliceRendezvous.getByLabel("Their Rendezvous address").fill(bobRuntime.canisterId);
    await aliceRendezvous.getByLabel("Meeting title").fill(meeting);
    await composeAndSendProposal(aliceRendezvous);
    await expect(aliceRendezvous.getByRole("heading", { name: meeting })).toBeVisible({ timeout: 60_000 });

    const bobRendezvous = await openApp(bob.page, "rendezvous");
    await expect.poll(async () => {
      await bobRendezvous.getByRole("button", { name: "Refresh" }).click();
      return bobRendezvous.getByRole("heading", { name: meeting }).count();
    }, { timeout: 60_000 }).toBe(1);
    const bobNegotiation = bobRendezvous.locator("article.negotiation").filter({ hasText: meeting });
    const choices = bobNegotiation.getByRole("radio");
    const candidateCount = await choices.count();
    const candidates: Date[] = [];
    for (let index = 0; index < candidateCount; index += 1) {
      const candidate = new Date(await choices.nth(index).locator("xpath=../span").innerText());
      expect(Number.isNaN(candidate.getTime())).toBe(false);
      candidates.push(candidate);
    }

    const bobCalendar = await openApp(bob.page, "calendar");
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      await addEventAt(bobCalendar, `${bobConflict} ${index + 1}`, candidate, new Date(candidate.getTime() + 30 * 60_000));
    }
    await choices.first().check();
    await bobNegotiation.getByRole("button", { name: "Accept selected time" }).click();
    await expect(bobRendezvous.getByRole("status")).toContainText("That time is no longer available", { timeout: 60_000 });
    await bobRendezvous.getByRole("button", { name: "Refresh" }).click();
    await expect(bobNegotiation.getByText("No longer available")).toHaveCount(candidateCount, { timeout: 60_000 });
    for (let index = 0; index < candidateCount; index += 1) await expect(bobNegotiation.getByRole("radio").nth(index)).toBeDisabled();
    await expect(bobNegotiation.getByRole("status")).toContainText("None of these times is open now");
    await expect(bobNegotiation.getByRole("button", { name: "Suggest another time" })).toBeVisible();
    await expect(bobNegotiation.getByText("Needs your response", { exact: true })).toBeVisible();
    await expect(bobNegotiation.getByText("Scheduled", { exact: true })).toHaveCount(0);

    await aliceRendezvous.getByRole("button", { name: "Refresh" }).click();
    const aliceNegotiation = aliceRendezvous.locator("article.negotiation").filter({ hasText: meeting });
    await expect(aliceNegotiation.getByText("Waiting for them", { exact: true })).toBeVisible();
    await expect(aliceRendezvous.getByText(bobConflict)).toHaveCount(0);
    await expect(bobCalendar.getByText(meeting)).toHaveCount(0);
  } finally {
    if (alicePrincipal) await revoke(aliceRuntime, alicePrincipal);
    if (bobPrincipal) await revoke(bobRuntime, bobPrincipal);
    await aliceContext.close();
    await bobContext.close();
  }
});

test("a failed peer delivery is saved and Safe retry delivers it exactly once", async ({ browser }) => {
  test.setTimeout(180_000);
  const aliceRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const bobRuntime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 1 });
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  let alicePrincipal: string | undefined;
  let bobPrincipal: string | undefined;
  let bobStopped = false;
  const meeting = `Retry recovery ${Date.now()}`;
  try {
    const alice = await signInAndAuthorize(aliceContext, aliceRuntime);
    alicePrincipal = alice.principal;
    const rendezvous = await openApp(alice.page, "rendezvous");
    await rendezvous.getByLabel("Their Rendezvous address").fill(encodeAddress({ host: bobRuntime.canisterId }));
    await rendezvous.getByLabel("Meeting title").fill(meeting);
    await rendezvous.getByRole("button", { name: "Choose dates" }).click();
    await rendezvous.getByRole("button", { name: "Find available times" }).click();
    await expect(rendezvous.getByRole("heading", { name: "Choose exact options" })).toBeVisible({ timeout: 60_000 });
    const retryTime = new Date(Date.now() + 6 * 86_400_000);
    retryTime.setHours(14, 43, 0, 0);
    await rendezvous.getByLabel("Add a specific time").fill(localInput(retryTime));
    await rendezvous.getByRole("button", { name: "Check and add" }).click();
    await expect(rendezvous.getByText("1 of 16 selected")).toBeVisible();
    await rendezvous.getByRole("button", { name: "Review 1 option" }).click();

    await setCanisterRunning(bobRuntime, false);
    bobStopped = true;
    await rendezvous.getByRole("button", { name: "Send proposal" }).click();
    await expect(rendezvous.getByRole("status")).toContainText("Proposal saved, but delivery did not complete", { timeout: 60_000 });
    const aliceNegotiation = rendezvous.locator(".negotiation").filter({ has: rendezvous.getByRole("heading", { name: meeting }) });
    await aliceNegotiation.getByText("Technical delivery").click();
    await expect(aliceNegotiation.getByText(/Delivery: (idle|retryable|uncertain)/)).toBeVisible();
    await expect(aliceNegotiation.getByRole("button", { name: "Safe retry" })).toBeVisible();

    await setCanisterRunning(bobRuntime, true);
    bobStopped = false;
    await expect.poll(async () => {
      const retry = aliceNegotiation.getByRole("button", { name: "Safe retry" });
      if (await retry.isVisible()) await retry.click();
      return aliceNegotiation.getByText(/Delivery: delivered/).count();
    }, { timeout: 60_000, intervals: [500, 1_000, 2_000, 3_000] }).toBe(1);
    await expect(aliceNegotiation.getByRole("button", { name: "Safe retry" })).toHaveCount(0);

    const bob = await signInAndAuthorize(bobContext, bobRuntime);
    bobPrincipal = bob.principal;
    const bobRendezvous = await openApp(bob.page, "rendezvous");
    await expect.poll(async () => {
      await bobRendezvous.getByRole("button", { name: "Refresh" }).click();
      return bobRendezvous.getByRole("heading", { name: meeting }).count();
    }, { timeout: 60_000 }).toBe(1);
  } finally {
    if (bobStopped) await setCanisterRunning(bobRuntime, true);
    if (alicePrincipal) await revoke(aliceRuntime, alicePrincipal);
    if (bobPrincipal) await revoke(bobRuntime, bobPrincipal);
    await aliceContext.close();
    await bobContext.close();
  }
});

test("diagnose a local-II owner update", async ({ browser }, testInfo) => {
  test.skip(process.env.NEUTRON_E2E_DIAG_UPDATES !== "1", "Set NEUTRON_E2E_DIAG_UPDATES=1 to capture the stalled II update path.");
  test.setTimeout(120_000);
  const runtime = resolveLocalNeutronRuntime({ configPath, nodeIndex: 0 });
  const context = await browser.newContext();
  const diagnostic = new SelfCallDiagnostic();
  let principal: string | undefined;
  await diagnostic.install(context);
  try {
    const alice = await signInAndAuthorize(context, runtime);
    principal = alice.principal;
    diagnostic.record("identity.authorized", { node: runtime.nodeLabel });
    const calendar = await openApp(alice.page, "calendar");
    const start = new Date(Date.now() + 30 * 86_400_000); start.setHours(15, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    await calendar.getByLabel("Title").fill("II update diagnostic");
    await calendar.getByLabel("Starts", { exact: true }).fill(localInput(start));
    await calendar.getByLabel("Ends", { exact: true }).fill(localInput(end));
    diagnostic.record("ui.calendar_create.click", {});
    await calendar.getByRole("button", { name: "Add to calendar" }).click();
    const outcome = await Promise.race([
      calendar.getByText("II update diagnostic").waitFor({ state: "visible", timeout: 45_000 }).then(() => "event-visible"),
      calendar.locator("output").filter({ hasNotText: "Loading your calendar" }).waitFor({ state: "visible", timeout: 45_000 }).then(async () => `app-error: ${await calendar.locator("output").innerText()}`),
      new Promise<string>((resolve) => setTimeout(() => resolve("no-result-after-45s"), 45_000)),
    ]);
    diagnostic.record("ui.calendar_create.outcome", { outcome });
  } finally {
    if (principal) await revoke(runtime, principal);
    await diagnostic.save(testInfo);
    await context.close();
  }
});

type Runtime = ReturnType<typeof resolveLocalNeutronRuntime>;

async function submissionScreenshot(page: Page, name: string): Promise<void> {
  if (process.env.NEUTRON_SUBMISSION_SCREENSHOTS !== "1") return;
  const directory = "submission-assets";
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: `${directory}/${name}`,
    type: "jpeg",
    quality: 70,
    fullPage: false,
  });
}

async function assertBasicAccessibility(frame: FrameLocator): Promise<void> {
  const problems = await frame.locator("body").evaluate((body) => {
    const issues: string[] = [];
    const ids = new Set<string>();
    for (const element of body.querySelectorAll<HTMLElement>("[id]")) {
      if (ids.has(element.id)) issues.push(`duplicate id: ${element.id}`);
      ids.add(element.id);
    }
    const hasLabel = (element: HTMLElement) => {
      const id = element.id;
      return Boolean(element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.closest("label") || (id && body.querySelector(`label[for="${CSS.escape(id)}"]`)));
    };
    for (const element of body.querySelectorAll<HTMLElement>("button, input:not([type=hidden]), select, textarea")) {
      if (element instanceof HTMLButtonElement) {
        if (!(element.textContent?.trim() || element.getAttribute("aria-label") || element.title)) issues.push("unnamed button");
      } else if (!hasLabel(element)) issues.push(`unlabelled ${element.tagName.toLowerCase()}`);
    }
    if (body.querySelectorAll("h1").length !== 1) issues.push("surface must have exactly one h1");
    return issues;
  });
  expect(problems).toEqual([]);
}

async function signInAndAuthorize(context: BrowserContext, runtime: Runtime) {
  await context.credentials.install();
  const page = await context.newPage();
  await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await signInWithLocalInternetIdentity({
    page,
    context,
    loginSelector: '[data-tid="login-button"]',
    localHost: runtime.gatewayUrl,
  });
  const principalNode = page.locator('[data-tid="principal"]');
  await expect(principalNode).toBeVisible();
  const principal = (await principalNode.textContent())?.trim();
  if (!principal) throw new Error(`Internet Identity did not return a principal for ${runtime.nodeLabel}`);
  const actor = await developerActor(runtime);
  await actor.kernel_authorized_recover(Principal.fromText(principal));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
  await expect(page.locator('[data-tid="launcher-open"]')).toBeVisible();
  return { page, principal };
}

async function revoke(runtime: Runtime, principal: string) {
  const actor = await developerActor(runtime);
  await actor.kernel_authorized_rem(Principal.fromText(principal));
}

function developerActor(runtime: Runtime) {
  return createKernelActor({
    canisterId: runtime.canisterId,
    host: runtime.gatewayUrl,
    identity: localIdentityFromSeed(runtime.developerIdentitySeed),
    fetchRootKey: true,
  });
}

async function setCanisterRunning(runtime: Runtime, running: boolean) {
  const target = Principal.fromText(runtime.canisterId);
  const agent = await HttpAgent.create({
    host: runtime.gatewayUrl,
    identity: localIdentityFromSeed(runtime.developerIdentitySeed),
    verifyQuerySignatures: false,
  });
  await agent.fetchRootKey();
  const actor = Actor.createActor<{
    start_canister: ActorMethod<[{ canister_id: Principal }], undefined>;
    stop_canister: ActorMethod<[{ canister_id: Principal }], undefined>;
  }>(() => IDL.Service({
    start_canister: IDL.Func([IDL.Record({ canister_id: IDL.Principal })], [], []),
    stop_canister: IDL.Func([IDL.Record({ canister_id: IDL.Principal })], [], []),
  }), {
    agent,
    canisterId: Principal.managementCanister(),
    effectiveCanisterId: target,
  });
  if (running) await actor.start_canister({ canister_id: target });
  else await actor.stop_canister({ canister_id: target });
}

async function openApp(page: Page, appId: "calendar" | "rendezvous"): Promise<FrameLocator> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
  await page.locator(`[data-tid="launcher-tile-${appId}-main"]`).click();
  const frame = page.frameLocator(`[data-app-id="${appId}"][data-tile-id="main"]`).last();
  await expect(frame.getByRole("heading", { name: appId === "calendar" ? "Calendar" : "Rendezvous", exact: true })).toBeVisible();
  if (appId === "calendar") await expect(frame.getByText("Loading your calendar…")).toHaveCount(0, { timeout: 60_000 });
  if (appId === "rendezvous") await expect(frame.getByText("Loading negotiations…")).toHaveCount(0, { timeout: 60_000 });
  return frame;
}

async function closeApp(page: Page, title: "Calendar" | "Rendezvous" | "Contacts") {
  await page.getByRole("region", { name: title }).getByRole("button", { name: "Close tile" }).click();
  await expect(page.getByRole("region", { name: title })).toHaveCount(0);
}

async function upsertNeutronContact(page: Page, name: string, neutronAddress: string) {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
  await page.locator('[data-tid="launcher-tile-contacts-contacts"]').click();
  const contacts = page.frameLocator('[data-app-id="contacts"][data-tile-id="contacts"]').last();
  await expect(contacts.getByRole("button", { name: "Add contact" })).toBeVisible({ timeout: 60_000 });
  await contacts.getByRole("searchbox", { name: "Search contacts" }).fill("Bob");
  const priorTestContact = contacts.locator(".contact-row").first();
  const hasPriorTestContact = await priorTestContact.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
  if (hasPriorTestContact) {
    await priorTestContact.click();
    await contacts.getByRole("button", { name: "Edit contact" }).click();
  } else {
    await contacts.getByRole("button", { name: "Add contact" }).click();
    await contacts.getByLabel("New destination network").selectOption("neutron");
    await contacts.getByRole("button", { name: "Add destination" }).click();
  }
  await contacts.getByRole("textbox", { name: "Name" }).fill(name);
  await contacts.getByRole("textbox", { name: "Destination 1 Neutron address" }).fill(neutronAddress);
  await contacts.getByRole("button", { name: "Save" }).click();
  await expect(contacts.getByRole("heading", { name })).toBeVisible({ timeout: 60_000 });
  await closeApp(page, "Contacts");
}

async function showCalendarMonth(calendar: FrameLocator, target: Date) {
  await calendar.getByRole("button", { name: "Month", exact: true }).click();
  const today = new Date();
  const monthOffset = (target.getFullYear() - today.getFullYear()) * 12 + target.getMonth() - today.getMonth();
  const direction = monthOffset < 0 ? ".fc-prev-button" : ".fc-next-button";
  for (let month = 0; month < Math.abs(monthOffset); month += 1) {
    await calendar.locator(direction).click();
  }
}

async function dragBetween(page: Page, source: Locator, target: Locator) {
  // Mouse coordinates are viewport-relative. In multi-tab scenarios Chromium
  // must foreground the target page before Playwright measures iframe boxes.
  await page.bringToFront();
  // Resolve and scroll the precise iframe-owned locator first. Measuring before
  // this step leaves stale page coordinates when a compact tile body scrolls.
  await source.hover({ timeout: 10_000 });
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Calendar drag source or target is not rendered");
  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + Math.min(8, sourceBox.height / 2);
  const targetY = targetBox.y + Math.min(5, targetBox.height / 2);
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.move(sourceX + 2, sourceY + 8, { steps: 4 });
  await page.mouse.move(sourceX, targetY, { steps: 24 });
  await page.waitForTimeout(300);
  await page.mouse.up();
}

async function addPrivateEvent(calendar: FrameLocator, title: string, daysAhead: number) {
  await expect(calendar.getByRole("region", { name: "Calendar views" })).toBeVisible({ timeout: 60_000 });
  const start = new Date(Date.now() + daysAhead * 86_400_000); start.setHours(15, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60_000);
  await calendar.getByLabel("Title").fill(title);
  await calendar.getByLabel("Starts", { exact: true }).fill(localInput(start));
  await calendar.getByLabel("Ends", { exact: true }).fill(localInput(end));
  await calendar.getByRole("button", { name: "Add to calendar" }).click();
  await expect(calendar.getByLabel("Title")).toHaveValue("", { timeout: 60_000 });
}

async function addEventAt(calendar: FrameLocator, title: string, start: Date, end: Date) {
  await expect(calendar.getByRole("region", { name: "Calendar views" })).toBeVisible({ timeout: 60_000 });
  await calendar.getByLabel("Title").fill(title);
  await calendar.getByLabel("Starts", { exact: true }).fill(localInput(start));
  await calendar.getByLabel("Ends", { exact: true }).fill(localInput(end));
  await calendar.getByRole("button", { name: "Add to calendar" }).click();
  await expect(calendar.getByLabel("Title")).toHaveValue("", { timeout: 60_000 });
}

async function composeAndSendProposal(rendezvous: FrameLocator) {
  await rendezvous.getByRole("button", { name: "Choose dates" }).click();
  await rendezvous.getByRole("button", { name: "Find available times" }).click();
  await expect(rendezvous.getByRole("heading", { name: "Choose exact options" })).toBeVisible({ timeout: 60_000 });
  const options = rendezvous.locator(".suggestions").getByRole("checkbox");
  await expect(options.first()).toBeVisible();
  const count = Math.min(3, await options.count());
  for (let index = 0; index < count; index += 1) await options.nth(index).check();
  await rendezvous.getByRole("button", { name: new RegExp(`Review ${count} option`) }).click();
  await rendezvous.getByRole("button", { name: "Send proposal" }).click();
}

function localInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

type DiagnosticEntry = { at_ms: number; event: string; data: Record<string, unknown> };

class SelfCallDiagnostic {
  private readonly started = Date.now();
  private readonly entries: DiagnosticEntry[] = [];
  private readonly requests = new WeakMap<object, number>();

  record(event: string, data: Record<string, unknown>) {
    this.entries.push({ at_ms: Date.now() - this.started, event, data });
  }

  containsAny(values: string[]) {
    const serialized = JSON.stringify(this.entries);
    return values.some((value) => serialized.includes(value));
  }

  async install(context: BrowserContext) {
    context.on("page", (page) => this.watchPage(page));
    context.on("request", (request) => {
      if (!isIcApi(request.url())) return;
      this.requests.set(request, Date.now());
      this.record("http.request", { method: request.method(), url: redactUrl(request.url()), resourceType: request.resourceType() });
    });
    context.on("response", (response) => {
      if (!isIcApi(response.url())) return;
      const began = this.requests.get(response.request());
      this.record("http.response", { status: response.status(), url: redactUrl(response.url()), duration_ms: began ? Date.now() - began : null });
    });
    context.on("requestfailed", (request) => {
      if (isIcApi(request.url())) this.record("http.failed", { url: redactUrl(request.url()), error: request.failure()?.errorText ?? "unknown" });
    });
    await context.addInitScript(() => {
      const emit = (channel: string, value: unknown) => {
        if (!value || typeof value !== "object") return;
        const item = value as { type?: unknown; tool?: unknown; method?: unknown; id?: unknown; ok?: unknown; error?: unknown };
        if (item.type !== "neutron:self-call:exec" && item.type !== "neutron:self-call:response") return;
        const shape = (subject: unknown) => {
          if (subject === null) return { kind: "null" };
          if (Array.isArray(subject)) return { kind: "array", length: subject.length };
          if (typeof subject === "object") return { kind: "object", keys: Object.keys(subject).sort().slice(0, 20) };
          return { kind: typeof subject };
        };
        console.info("[neutron-self-call-diag]", JSON.stringify({
          channel,
          type: item.type,
          tool: item.tool,
          method: item.method,
          id: item.id,
          envelope_keys: Object.keys(item).sort(),
          ok_shape: Object.hasOwn(item, "ok") ? shape(item.ok) : undefined,
          error_shape: Object.hasOwn(item, "error") ? shape(item.error) : undefined,
        }));
      };
      window.addEventListener("message", (event) => emit("window.message", event.data));
      const originalWindowPost = window.postMessage.bind(window);
      window.postMessage = ((message: unknown, targetOrigin?: string, transfer?: Transferable[]) => {
        emit("window.postMessage", message);
        return originalWindowPost(message, targetOrigin ?? "/", transfer ?? []);
      }) as typeof window.postMessage;
      const originalPortPost = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function(message: unknown, transfer?: Transferable[]) {
        emit("messagePort.postMessage", message);
        return originalPortPost.call(this, message, transfer ?? []);
      };
    });
  }

  private watchPage(page: Page) {
    page.on("console", (message) => this.record("browser.console", { level: message.type(), text: redactText(message.text()), url: redactUrl(message.location().url) }));
    page.on("pageerror", (error) => this.record("browser.pageerror", { message: redactText(error.message), stack: redactText(error.stack ?? "") }));
    page.on("crash", () => this.record("browser.crash", { url: redactUrl(page.url()) }));
  }

  async save(testInfo: TestInfo) {
    const path = testInfo.outputPath("self-call-diagnostic.json");
    await writeFile(path, JSON.stringify({ generated_at: new Date().toISOString(), entries: this.entries }, null, 2), "utf8");
    await testInfo.attach("self-call-diagnostic", { path, contentType: "application/json" });
  }
}

function isIcApi(url: string) { return /\/api\/v\d+\/canister\//.test(url) || url.endsWith("/api/v2/status"); }
function redactUrl(value: string) { try { const url = new URL(value); return redactText(`${url.origin}${url.pathname}`); } catch { return "invalid-url"; } }
function redactText(value: string) { return value.replace(/\b[a-z0-9]{5}(?:-[a-z0-9]{5}){2,}\b/gi, "[principal]").slice(0, 2_000); }
