import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Spreadsheet 0.3.4 keeps the exact production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "spreadsheet",
    memoryId: "spreadsheet",
    productionArchive: new URL(
      "../spreadsheet.v0.3.1.neutron",
      import.meta.url,
    ),
    candidateArchive: new URL("../spreadsheet.v0.3.4.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 301,
      bytes: 224_085,
      sha256:
        "82ad9b612305fc1f9a5364f563d53e2aa63706befc2888f67a717940f65221a3",
    },
    candidateVersion: 304,
  });
});
