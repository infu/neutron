// Anonymous mainnet queries only; never send email, join a chat, or post.
import { AnonymousIdentity } from "@dfinity/agent";
import { GroupIndexClient } from "../../src/oc/clients.ts";
import { OcTransport } from "../../src/oc/transport.ts";
import { variantIs, variantPayload, variantTag } from "../../src/oc/view.ts";

const client = new GroupIndexClient(new OcTransport());
const identity = new AnonymousIdentity();
for (const kind of ["communities", "groups"] as const) {
  const response = kind === "communities"
    ? await client.exploreCommunities(identity, null, 0, 5)
    : await client.exploreGroups(identity, null, 0, 5);
  if (!variantIs(response, "Success")) throw new Error(`${kind}: ${variantTag(response)}`);
  const matches = variantPayload(response, "Success").matches;
  if (!Array.isArray(matches)) throw new Error(`${kind}: invalid matches reply`);
  console.log(`${kind}: decoded ${matches.length} public directory entries`);
}
