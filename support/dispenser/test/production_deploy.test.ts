import { describe, expect, test } from "bun:test";
import { parseProductionCanisterIdMapping } from "../production_deploy.ts";

const BACKEND = "2o4cy-waaaa-aaaay-aacqq-cai";
const FRONTEND = "2h7je-aiaaa-aaaay-aacra-cai";

describe("production Dispenser canister mapping", () => {
  test("accepts only the exact current ICP CLI mapping", () => {
    expect(
      parseProductionCanisterIdMapping({
        dispenser: BACKEND,
        frontend: FRONTEND,
      }),
    ).toEqual({
      backend: BACKEND,
      frontend: FRONTEND,
    });
  });

  test("rejects the removed mapping shape and ambiguous IDs", () => {
    for (const value of [
      {
        dispenser: { ic: BACKEND },
        frontend: { ic: FRONTEND },
      },
      {
        dispenser: BACKEND,
        frontend: FRONTEND,
        network: "ic",
      },
      {
        dispenser: BACKEND,
      },
      {
        dispenser: BACKEND,
        frontend: BACKEND,
      },
      {
        dispenser: "aaaaa-aa",
        frontend: FRONTEND,
      },
      {
        dispenser: "2vxsx-fae",
        frontend: FRONTEND,
      },
    ]) {
      expect(() => parseProductionCanisterIdMapping(value)).toThrow();
    }
  });
});
