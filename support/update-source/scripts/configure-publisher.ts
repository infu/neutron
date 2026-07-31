import {
  COMMON_VALUE_FLAGS,
  createCliContext,
  failCli,
  parseArguments,
  printJson,
  requireSinglePositional,
} from "../src/cli.ts";
import { configurePublisher } from "../src/permissions.ts";

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2), {
    valueFlags: COMMON_VALUE_FLAGS,
    booleanFlags: ["replace"],
  });
  const publisher = requireSinglePositional(parsed, "publisher principal");
  const { canisterId, port } = await createCliContext(parsed, {
    requireIdentity: true,
  });
  const status = await configurePublisher(port, publisher, {
    replace: parsed.flags.has("replace"),
  });
  printJson({ canister_id: canisterId, action: "configured", status });
}

main().catch(failCli);
