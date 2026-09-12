import { expect, test } from "bun:test";
import { createFeedbackNotifications } from "../src/notification_state.ts";
import type { FeedbackSession } from "../src/types.ts";
const session = (unreadReplies: number, moderator = false): FeedbackSession => ({ neutron: "fixture-neutron", moderator, unreadReplies });
function fixture(read: () => Promise<FeedbackSession>) {
  const badges: (number | null)[] = [];
  const revisions: number[] = [];
  const scheduled: { callback: () => void; delay: number }[] = [];
  const canceled: unknown[] = [];
  const state = createFeedbackNotifications({ session: read, badge: async badge => { badges.push(badge); }, publish: async (topic, revision) => { expect(topic).toBe("feedback"); revisions.push(revision); }, schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, cancel: handle => { canceled.push(handle); } });
  return { state, badges, revisions, scheduled, canceled };
}

test("resident bootstrap and recovery polling populate the tray without acknowledging replies", async () => {
  let reads = 0;
  const fixtureState = fixture(async () => session(++reads));
  fixtureState.state.start();
  await fixtureState.state.refresh();
  await Promise.resolve();
  expect(fixtureState.badges).toEqual([1]);
  expect(fixtureState.scheduled[0]!.delay).toBe(30_000);
  fixtureState.scheduled[0]!.callback();
  await fixtureState.state.refresh();
  expect(fixtureState.badges).toEqual([1, 2]);
  expect(fixtureState.revisions).toEqual([1, 2]);
  fixtureState.state.stop();
  expect(fixtureState.canceled.length).toBe(1);
});

test("offline refresh keeps the prior badge and successful recovery clears it", async () => {
  let offline = true;
  const value = fixture(async () => { if (offline) throw new Error("Offline"); return session(0); });
  await value.state.observe(session(3));
  await value.state.refresh();
  expect(value.badges).toEqual([3]);
  expect(value.state.snapshot()?.unreadReplies).toBe(3);
  offline = false;
  await value.state.refresh();
  expect(value.badges).toEqual([3, null]);
});

test("a stale poll cannot overwrite a newer mark-read observation", async () => {
  let resolve!: (value: FeedbackSession) => void;
  const value = fixture(() => new Promise(done => { resolve = done; }));
  const pending = value.state.refresh();
  await value.state.observe(session(0), true);
  resolve(session(5));
  await pending;
  expect(value.badges).toEqual([null]);
  expect(value.state.snapshot()?.unreadReplies).toBe(0);
});

test("moderator assignment changes and confirmed writes invalidate the views", async () => {
  const value = fixture(async () => session(0));
  await value.state.observe(session(0));
  await value.state.observe(session(0));
  await value.state.observe(session(0, true));
  await value.state.changed();
  expect(value.revisions).toEqual([1, 2, 3]);
});

test("tray projection errors do not erase known session state or reject confirmed work", async () => {
  const state = createFeedbackNotifications({ session: async () => session(2), badge: async () => { throw new Error("Tray gone"); }, publish: async () => { throw new Error("View gone"); }, schedule: () => 1, cancel: () => {} });
  await state.observe(session(2), true);
  await state.changed();
  expect(state.snapshot()?.unreadReplies).toBe(2);
});
