export type DeadlineScheduler = (
  callback: () => void,
  delayMilliseconds: number,
) => () => void;

export const scheduleDeadline: DeadlineScheduler = (
  callback,
  delayMilliseconds,
) => {
  const timer = globalThis.setTimeout(callback, delayMilliseconds);
  return () => globalThis.clearTimeout(timer);
};
