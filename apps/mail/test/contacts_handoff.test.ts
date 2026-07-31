import { describe, expect, test } from "bun:test";
import {
  CONTACT_PREFILL_TOOL,
  openPrefilledContact,
} from "../src/contacts_handoff.ts";
import type {
  JsonValue,
  MsgBusToolCall,
  OpenAppTileRequest,
} from "neutron-tools/app";

const PRINCIPAL = "ecbfe-lt777-77774-aaabq-cai";

describe("Mail to Contacts handoff", () => {
  test("opens one exact tile, waits for it, then makes one permissioned tool call", async () => {
    const opens: OpenAppTileRequest[] = [];
    const calls: MsgBusToolCall[] = [];
    let endpointReads = 0;
    const status = await openPrefilledContact(
      {
        suggestedName: "Unverified Mallory",
        neutronPrincipal: PRINCIPAL,
      },
      {
        async openTile(request) {
          opens.push(request);
          return { instanceId: "contact-one", workspace: 1, opened: true };
        },
        async endpoints() {
          endpointReads += 1;
          return {
            endpoints:
              endpointReads === 1
                ? []
                : [
                    {
                      endpoint:
                        "app:contacts:tile:contacts:instance:contact-one",
                      connected: true,
                    },
                  ],
          };
        },
        async invoke(call) {
          calls.push(call);
          return { status: "ready" };
        },
        async wait() {},
      },
    );

    expect(status).toBe("ready");
    expect(opens).toEqual([
      { appId: "contacts", tileId: "contacts", reuseExisting: true },
    ]);
    expect(calls).toEqual([
      {
        target: "app:contacts:tile:contacts:instance:contact-one",
        name: CONTACT_PREFILL_TOOL,
        arguments: {
          suggestedName: "Unverified Mallory",
          neutronPrincipal: PRINCIPAL,
        },
      },
    ]);
  });

  test("fails closed if Contacts never exposes the exact opened endpoint", async () => {
    expect(
      openPrefilledContact(
        { suggestedName: PRINCIPAL, neutronPrincipal: PRINCIPAL },
        {
          async openTile() {
            return { instanceId: "missing", workspace: 1, opened: false };
          },
          async endpoints(): Promise<JsonValue> {
            return { endpoints: [] };
          },
          async invoke() {
            throw new Error("must not call an unbound endpoint");
          },
          async wait() {},
        },
      ),
    ).rejects.toThrow("Contacts did not finish opening");
  });
});
