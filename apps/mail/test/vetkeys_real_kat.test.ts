import { test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAIL_REAL_VETKEYS_KAT_FILE,
  assertPinnedVetKeysInstallation,
  parseRealVetKeysKat,
  verifyRealVetKeysKat,
} from "../scripts/vetkeys_kat.ts";

const mailRoot = resolve(import.meta.dir, "..");
const vectorPath = resolve(mailRoot, MAIL_REAL_VETKEYS_KAT_FILE);

test("real local current+previous vetKeys responses remain compatible with the pinned browser package", async () => {
  await assertPinnedVetKeysInstallation(mailRoot);
  let text: string;
  try {
    text = await readFile(vectorPath, "utf8");
  } catch (error) {
    throw new Error(
      "Missing the captured real vetKeys KAT. On a disposable local Neutron, " +
        "use a format-3 PocketIC config whose developer identity matches the " +
        "frozen KAT profile, prepare Mail through the installed UI, then run " +
        "`npm --workspace neutron-mail run vetkeys:kat:capture -- " +
        "[--config <CONFIG.ndeploy.json>] --slot-uid <uid>`.",
      { cause: error },
    );
  }
  const vector = parseRealVetKeysKat(text);
  verifyRealVetKeysKat(vector);
});
