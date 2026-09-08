/**
 * A bounded concurrency pool.
 *
 * The obvious way to limit fan-out — slice the work into chunks of N and
 * `Promise.all` each chunk — is much slower than it looks: every chunk waits
 * for its slowest member before the next one starts, so one dead canister
 * timing out stalls the other N-1 lanes. With 54 SNSes and two chunked phases
 * that cost the SNS registry about 20 seconds, most of it spent idle.
 *
 * This keeps `limit` tasks in flight at all times: a lane picks up the next
 * task the instant it frees up.
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: width }, lane));
  return results;
}
