import {
  COMMON_VALUE_FLAGS,
  createCliContext,
  failCli,
  parseArguments,
  printJson,
} from "../src/cli.ts";
import { publisherStatus } from "../src/permissions.ts";

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2), {
    valueFlags: COMMON_VALUE_FLAGS,
  });
  if (parsed.positional.length > 0) throw new Error("Status takes no positional arguments");
  const { canisterId, port } = await createCliContext(parsed, {
    requireIdentity: true,
  });
  printJson({
    canister_id: canisterId,
    action: "status",
    status: await publisherStatus(port),
  });
}

main().catch(failCli);
