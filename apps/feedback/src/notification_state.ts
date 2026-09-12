import type { FeedbackSession } from "./types.ts";
export type NotificationDependencies = {
  session(): Promise<FeedbackSession>;
  badge(value: number | null): Promise<unknown>;
  publish(topic: string, revision: number): Promise<unknown>;
  schedule(callback: () => void, milliseconds: number): unknown;
  cancel(handle: unknown): void;
};
/** A refresh failure retains the last known badge. No read marks replies read;
 * acknowledgement belongs only to explicitly displayed discussion messages. */
export function createFeedbackNotifications(dependencies: NotificationDependencies) {
  let latest: FeedbackSession | null = null;
  let revision = 0;
  let observed = 0;
  let stopped = false;
  let timer: unknown;
  let flight: Promise<void> | null = null;
  async function observe(session: FeedbackSession, changed = false): Promise<void> {
    observed += 1;
    const differs = !latest || latest.neutron !== session.neutron || latest.moderator !== session.moderator || latest.unreadReplies !== session.unreadReplies;
    latest = session;
    // These are projections only. Failure to update a tray must never turn a
    // confirmed protocol mutation into an apparent failed send.
    await Promise.allSettled([
      dependencies.badge(session.unreadReplies > 0 ? session.unreadReplies : null),
      ...(differs || changed ? [dependencies.publish("feedback", ++revision)] : []),
    ]);
  }
  function refresh(): Promise<void> {
    if (flight) return flight;
    const started = observed;
    flight = dependencies.session().then(async session => {
      // A response observed from a newer user action takes precedence over a
      // poll which began before that action finished.
      if (!stopped && observed === started) await observe(session, true);
    }).catch(() => undefined).finally(() => { flight = null; });
    return flight;
  }
  function schedule(): void {
    if (stopped) return;
    timer = dependencies.schedule(() => {
      void refresh().finally(schedule);
    }, 30_000);
  }
  return {
    observe,
    refresh,
    async changed(): Promise<void> { await Promise.allSettled([dependencies.publish("feedback", ++revision)]); },
    start(): void { stopped = false; void refresh().finally(schedule); },
    stop(): void { stopped = true; if (timer !== undefined) dependencies.cancel(timer); },
    snapshot: () => latest,
  };
}
