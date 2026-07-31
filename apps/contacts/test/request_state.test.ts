import { describe, expect, test } from "bun:test";
import { settleListRequestBusy } from "../src/request_state.ts";

describe("Contacts list request ownership", () => {
  test("the newest background refresh releases a superseded initial load", () => {
    expect(settleListRequestBusy(2, 2, "initial")).toBeNull();
  });

  test("a stale list request cannot release the current list load", () => {
    expect(settleListRequestBusy(1, 2, "list")).toBe("list");
  });

  test("list completion never releases an unrelated operation", () => {
    for (const operation of ["contact", "save", "delete"]) {
      expect(settleListRequestBusy(3, 3, operation)).toBe(operation);
    }
  });
});
