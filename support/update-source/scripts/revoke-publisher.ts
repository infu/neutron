import {
  COMMON_VALUE_FLAGS,
  createCliContext,
  failCli,
  parseArguments,
  printJson,
  requireSinglePositional,
} from "../src/cli.ts";
import { revokePublisher } from "../src/permissions.ts";

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2), {
    valueFlags: COMMON_VALUE_FLAGS,
  });
  const publisher = requireSinglePositional(parsed, "publisher principal");
  const { canisterId, port } = await createCliContext(parsed, {
    requireIdentity: true,
  });
  const status = await revokePublisher(port, publisher);
  printJson({ canister_id: canisterId, action: "revoked", status });
}

main().catch(failCli);
