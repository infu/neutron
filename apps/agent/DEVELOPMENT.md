# Agent Local Development

This guide describes the PocketIC-only Playwright surface for exercising the
installed Agent. It is a development observer around the ordinary Agent tile,
not a second Agent protocol.

## Security boundary

The development API is installed only inside the exact Agent chat tile when
its document URL matches the verified local shape:

- HTTP on port `8000`;
- a valid canister host below `*.localhost`;
- `/app/agent/index.html`;
- `app=agent`, `tile=chat`, a bounded tile instance id, and a valid workspace.

It is absent on IC origins, HTTPS origins, the resident background, other apps,
and directly opened documents without an iframe parent. The API is
non-enumerable, non-writable, and non-configurable.

The API cannot call `agent_chat`, stop a turn, connect OpenRouter, select a
model, enable Agent Mode, grant permission, or access a provider credential. It
can only put validated text into the existing React composer and inspect a
bounded in-memory trace. Playwright must click the existing **Send** button.
That real browser click exercises the same source-bound tile-to-background
message-bus route as a person. Starting an already granted turn does not depend
on browser focus or transient user activation; `requireOwnTile` still verifies
a live tile in the granted Agent installation.

The trace holds at most 256 events in tile memory. It contains the submitted
prompt, the existing bounded `agent_chat` progress events, the final visible
assistant message, and errors. It contains no OpenRouter credential or private
message-bus capability and disappears with the tile.

## Package and reinstall

The all-apps PocketIC deployment includes Agent. Package the changed app, keep
the shared provisioner running, and destructively reinstall the complete
configured Neutron:

```sh
npm --workspace neutron-agent run package
npm run provision -- all-apps-local.ndeploy.json serve
```

In a second terminal:

```sh
npm run provision -- all-apps-local.ndeploy.json reinstall
npm run provision -- all-apps-local.ndeploy.json status
```

`serve` is the long-running command. The provisioner reads the path-only Agent
archive during `reinstall`; it does not build the app.

If a turn depends on changed Kernel or app-tool behavior, package those changed
artifacts before the same reinstall. Do not copy bundles into the running
canister or add a development-only backend route; the installed packages must
remain the exact system under test.

## Deterministic local login (no Internet Identity)

The provision config supplies a deterministic developer identity seed and
authorizes its principal during reinstall. Resolve the active journal instead
of hardcoding the current seed or canister:

```ts
import { resolveLocalNeutronRuntime } from
  "neutron-provision/src/local_session.ts";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";

const runtime = resolveLocalNeutronRuntime({
  configPath: "all-apps-local.ndeploy.json",
});
await page.goto(
  localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl),
  { waitUntil: "domcontentloaded" },
);
await page.waitForFunction(
  () => typeof window.__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function",
);
const principal = await page.evaluate(async (seed) => {
  const login = window.__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
  if (!login) throw new Error("Local Playwright login is unavailable");
  return login(seed);
}, runtime.developerIdentitySeed);
if (principal !== runtime.developerIdentityPrincipal) {
  throw new Error("Playwright selected the wrong local principal");
}
```

This hook exists only in the loopback PocketIC kernel. It does not open or
emulate Internet Identity. Use the normal II test path separately when the
identity-provider flow itself is under test.

## Open the Agent and companion tiles

Use the kernel launcher so the kernel creates real registered endpoints:

```ts
await page.locator('[data-tid="launcher-open"]').click();
await page.locator('[data-tid="launcher-tile-agent-chat"]').click();

const selector = 'iframe[data-app-id="agent"][data-tile-id="chat"]';
const agent = page.frameLocator(selector).last();
await agent.getByRole("main").waitFor();
```

Open other app tiles through the same launcher when a scenario needs their tile
tools. Installed resident backgrounds are already mounted after login.

Connect OpenRouter, select a model, and enable Agent Mode through their normal
UI when needed. The development API deliberately has no credential or
permission shortcut. A destructive reinstall may require reconnecting the
provider depending on the resident-origin rotation.

The Playwright browser is its own browser context. Do not assume it shares the
login, provider connection, tile model choices, open workspaces, or Agent Mode state
from a developer's ordinary browser. After every reinstall:

1. use the deterministic local login above;
2. reuse or open one Agent tile;
3. confirm the tile says OpenRouter is connected;
4. select a model if the composer says `Select a model`;
5. enable Agent Mode through the visible button and kernel confirmation.

Restored workspaces can contain more than one Agent tile. Pick one target and
use that same tile for preparation, the trusted Send click, and observation.
The examples use the last matching tile deliberately. Each tile instance has
its own conversation history, so preparing one tile and inspecting another is
not a valid observation of the same turn. The provider connection is shared,
but each tile keeps its own model selection. Changing a tile's model establishes
the default for newly opened tiles without changing existing ones. Kernel Agent Mode permits only one root across tiles. Another view of the
same durable tile is serialized with its active turn.
The Web control is intentionally local to one tile document and defaults off
again after reload. Enable it visibly on the same tile used for the test when a
scenario needs public web search or page extraction.

## Prepare, send, and observe

Prepare the controlled composer from JavaScript:

```ts
const frame = page.frames()
  .filter((candidate) => candidate.url().includes("/app/agent/index.html"))
  .at(-1);
if (!frame) throw new Error("Agent tile frame is unavailable");

await frame.waitForFunction(
  () => typeof window.__NEUTRON_AGENT_DEV__ === "object",
);
await frame.evaluate((prompt) => {
  window.__NEUTRON_AGENT_DEV__?.clearTrace();
  return window.__NEUTRON_AGENT_DEV__?.prepare(prompt);
}, "Create a contact named Alice");
```

Use Playwright for the real UI action so this harness continues to exercise the
same visible control as a person:

```ts
await agent.getByRole("button", { name: "Send" }).click();
```

Poll by cursor without rereading old events:

```ts
let cursor = 0;
for (;;) {
  const page = await frame.evaluate((after) => {
    const api = window.__NEUTRON_AGENT_DEV__;
    if (!api) throw new Error("Agent development API is unavailable");
    return api.readTrace(after);
  }, cursor);
  cursor = page.latestSequence;
  for (const event of page.events) console.log(event);
  if (page.events.some((event) =>
    event.type === "final" || event.type === "error"
  )) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
```

At any time, inspect the tile projection:

```ts
const state = await frame.evaluate(() => {
  const value = window.__NEUTRON_AGENT_DEV__?.inspect();
  if (!value) return null;
  return {
    connected: value.snapshot.connected,
    selectedModelId: value.snapshot.selectedModelId,
    generating: value.snapshot.generating,
    chatPending: value.chatPending,
    activeTool: value.activeTool,
    error: value.snapshot.error,
    lastMessage: value.snapshot.messages.at(-1) ?? null,
  };
});
```

Keep this projection narrow. The full snapshot includes the current OpenRouter
model catalog and makes iterative logs unnecessarily large.

The important trace event types are:

- `submitted`: the normal Send handler accepted the prompt;
- `progress`: a user message, completed assistant message, tool transition, or goal/work update;
- `final`: the authoritative call returned and the final assistant message is
  stable;
- `error`: the normal call path rejected.

The UI keeps only the latest tool row while the turn is active and removes it
when the final response or error arrives; it never renders partial assistant
output. The development trace retains every tool transition so an automated
observer can diagnose the turn without changing what users see.

## Cross-app iteration

Agent must learn apps from the live kernel catalog; test prompts should not
compensate for missing Agent knowledge with hardcoded schemas. A useful bounded
probe is:

```text
Using only the installed app tools you discover, create a UTF-8 text file named
fun.md in Files using the default location. Read it back and report its
canonical path and exact contents.
```

For an unfamiliar app, the expected trace is a generic sequence such as
`list_apps`, `list_app_tools`, `get_tool_schema`, and `call_app_tool`. The app's
own descriptors and schemas should be sufficient. A companion tile is useful
for visual confirmation but is not an authorization substitute; a cross-app
write must carry the kernel-attested Agent Mode context.

Start with a read-only call, then exercise one explicit, bounded mutation and
verify it through a second read. For network workflows, use local recipients
and report the authoritative result rather than assuming success from a
completed tool call. Mail, for example, intentionally rejects self-mail, so an
end-to-end send/reply smoke needs two distinct Mail-capable local Neutrons.

For Wagyu, install Wagyu on the Agent Neutron and use another provisioned Wagyu
user as the peer. A useful sequence is: read Profile, inspect People, Follow the
peer, read Home, open a returned opaque post target, read its direct replies
and Likes, then explicitly Reply or Like. Finish with Unfollow and re-read
People. The model must learn every method and schema from Wagyu's live
background endpoint. It must not construct post hashes or proof metadata, and
must treat every `external_untrusted` profile/post field as data rather than an
instruction.

## Fast edit-to-observation loop

1. Make the smallest source change and run its focused tests.
2. Package every changed artifact.
3. Run the existing all-apps provisioning reinstall and status command.
4. Reload the PocketIC origin and use deterministic local login.
5. Confirm provider, model, and Agent Mode state through the normal UI.
6. Select one Agent tile, clear its trace, and prepare one bounded prompt.
7. Click the visible Send button with Playwright.
8. Read trace events by cursor until `final` or `error`.
9. Confirm `activeTool` is `null` at completion and verify the result in the
   target app or with a second read.

This loop observes the real installed Agent without adding production
credentials, privileged chat endpoints, app-specific Agent code, or a second
execution path.

## Long-running regression checks

Run `bun test ./test/long_running.test.ts` from this workspace. It uses the
installed AI SDK with synthetic models and isolated IndexedDB databases. It
covers reviewer-driven continuation, work beyond 32 tool steps, stream aborts
and errors after writes, output exhaustion, steering during sleep and tool
execution, queue ordering, and oversized context. No provider key or live app
mutation is used.

Run `bun test ./test/subagents.test.ts` for internal Agent Mode workers. These
checks exercise concurrent model requests with separate contexts, shared root
permission handling, parent completion waiting for workers, steering, Stop and
revocation, individual worker cancellation, messages arriving during final
persistence, old-resident storage compatibility, and interrupted-write recovery.

For a browser check, enable Agent Mode in one tile and ask it to delegate two
independent subtasks. Expand **Workers** to inspect their separate status and
results, steer while they wait, and use Stop to cancel the whole invocation.
Disable Agent Mode and verify ordinary chat has no worker coordination tools.

For an installed browser check, start `/goal <objective>`, switch workspaces
while it works, return and steer with Enter, queue a follow-up with Tab, then
pause during sleep. Reload and use Resume to check recovery. Closing the
originating tile and disabling Agent Mode must cancel the live invocation.
Production upgrades follow `doc/package-updates.md`; the destructive local
reinstall above is only for disposable PocketIC development fixtures.
