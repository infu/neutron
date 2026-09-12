import { assertBoundedJson } from "neutron-tools/protocol";
import type { FeedbackPage } from "./types.ts";

function fits(value: unknown): boolean {
  try {
    // Tiles receive JSON inside a JSON string; Agent tools receive the object.
    // Test both exact wrappers because escaping can make the tile reply larger.
    assertBoundedJson({ resultJson: JSON.stringify(value) }, "Feedback view result");
    assertBoundedJson({ version: 1, contentTrust: "user_authored", result: value }, "Feedback Agent result");
    return true;
  } catch { return false; }
}

/** A page may contain fewer than the requested rows to fit the existing tool
 * transport. Text stays whole and the next cursor is the last returned row,
 * so every remaining row remains reachable through ordinary pagination. */
export function fitFeedbackPage<T, R>(page: FeedbackPage<T>, cursor: (item: T) => string, view: (page: FeedbackPage<T>) => R): R {
  const candidate = (count: number) => view({ items: page.items.slice(0, count), nextCursor: count < page.items.length ? cursor(page.items[count - 1]!) : page.nextCursor });
  const full = candidate(page.items.length);
  if (fits(full)) return full;
  if (page.items.length === 0 || !fits(candidate(1))) throw new Error("This saved message is larger than the app connection can display. Its complete text is still preserved.");
  let accepted = 1;
  let high = page.items.length - 1;
  while (accepted < high) {
    const middle = Math.ceil((accepted + high) / 2);
    if (fits(candidate(middle))) accepted = middle;
    else high = middle - 1;
  }
  return candidate(accepted);
}
