import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { appRegistryEntry, preparePackageInstall, type AppRegistryEntry } from "neutron-compiler/src/install.ts";
import { requirePhysicalSelfCallMethod, requirePreapprovedSelfCall } from "../../kernel/src/self_calls.ts";
import { deleteOperationDrafts, saveChildIntent, type Kernel } from "../src/store.ts";

// Exercise the actual store calls and Kernel permission gate. A client mock
// that accepts every updateSelf method cannot detect a missing declaration.
function selfCalls(app: AppRegistryEntry) {
  const dispatched: Array<{ method: string; args: unknown[] }> = [];
  const kernel = {
    async updateSelf(method: string, args: unknown[]) {
      const entry = requirePreapprovedSelfCall(app, method, "update");
      dispatched.push({ method: requirePhysicalSelfCallMethod("marketplace", entry), args });
      return { ok: "saved" };
    },
  } as unknown as Kernel;
  return { kernel, dispatched };
}

const id = "ab".repeat(16);
const parentId = `ethereum:operation:${id}`;
const childId = `ethereum:step:${id}:approval`;
const parent = { kind: "approval_only" };
const child = { state: "confirmed" };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const expected = [{ id: parentId, value: encode(parent) }, { id: childId, value: encode(child) }];

test("released Marketplace124 rejects notification deletion and child journals before dispatch", async () => {
  const archive = new Uint8Array(await readFile(new URL("../marketplace.v0.1.24.neutron", import.meta.url)));
  expect(createHash("sha256").update(archive).digest("hex")).toBe("9db663a9b0b5dbc38d54a08a9eb7d2ae8ea602aa97433aac62afaa11d398c2c0");
  const { kernel, dispatched } = selfCalls(appRegistryEntry(preparePackageInstall(archive).manifest));
  await expect(saveChildIntent(kernel, childId, child, parentId, parent)).rejects.toThrow("Method is not preapproved for this app");
  await expect(deleteOperationDrafts(kernel, id, expected)).rejects.toThrow("Method is not preapproved for this app");
  expect(dispatched).toEqual([]);
});

test("Marketplace store can dispatch notification deletion and child journals through its declared permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../neutron.json", import.meta.url), "utf8"));
  const { kernel, dispatched } = selfCalls(appRegistryEntry(manifest));
  await saveChildIntent(kernel, childId, child, parentId, parent);
  await deleteOperationDrafts(kernel, id, expected);
  expect(dispatched).toEqual([
    { method: "app_marketplace__marketplace_save_draft_child", args: [{ parent: expected[0], draft: expected[1] }] },
    { method: "app_marketplace__marketplace_delete_operation", args: [{ id, expected }] },
  ]);
});
