# Agent

Resident OpenRouter chat agent for Neutron. The kernel owns authorization and
durable credentials; the app background process receives its declared key in
memory and uses the Vercel AI SDK to stream model requests directly.

The app declares `agent_chat` as its exact Agent Mode entrypoint. Enabling
Agent Mode requires a kernel-owned owner confirmation and binds the grant to
this installed app version and entrypoint for the current frontend session.
The tile must be focused and have transient user activation to start each turn.
Reload, logout, app update, endpoint replacement, uninstall, or explicit
disable revokes the grant.

During an active turn the model uses the invocation-scoped Neutron message bus
to discover apps, inspect one tool schema, and call tools. Direct agent actions
do not show owner dialogs. If a called app requests a new permission, the
kernel suspends that exact request and sends a bounded, kernel-produced
challenge to the resident runtime. Frontend, backend, connection, and workspace
challenges exclude raw tool arguments. A v2 external signed-call challenge is
the deliberate exception: it includes the complete canonical prepared argument
array shown for approval. The runtime makes one separate `generateText` request
with the selected OpenRouter model and one forced `permission_decision` tool.
It receives the current owner goal and those permission facts, not the
transcript, tool output, credentials, private keys, or transport ids.

Agent contains no app ids, app-specific paths, or app-specific calling rules.
Its installed-app list, live endpoints, tool descriptions, schemas, and
visibility all come from the kernel's current catalog. Apps own that contract;
adding or changing an app does not require an Agent code change.

Agent discovery intentionally omits transient tray endpoints, and delegated
agent calls cannot target them. Apps that want to support agents should expose
their durable operations as tools on the resident background (or a normal tile).
A tray popout may call those same background tools through Neutron's no-prompt
same-app route, but it remains short-lived UI rather than an agent target. See
the [app tray contract](../../doc/app-tray.md) for the complete capability and
privilege boundary.

Before every app-tool call, Agent reads the current descriptor again. It treats
a method as read-only only when the descriptor explicitly declares `read` and
contains no effect outside the known read-compatible set. Missing, malformed,
unknown, `write`, `signature_request`, and `persistent_permission` effects are
handled conservatively as state-changing. Agent durably journals the endpoint
and method in its existing isolated IndexedDB state before dispatch; a journal
failure prevents the call. If the dispatched call fails or is cancelled, Agent
reports `retrySafe: false`. The model must inspect a read or status method to
reconcile the outcome before attempting it again; it must not assume that a
transport failure means the app made no change.

If the whole model turn is interrupted after a state-changing call starts,
Agent atomically replaces the journal with a small warning turn. Startup does
the same for a journal left by a browser or process failure, pairing it with
the exact bounded owner prompt saved by the journal commit before Agent can
accept another turn. A successfully persisted terminal turn clears the
journal. If that turn's detailed tool transcript exceeds the durable history
bound, Agent first retains a compact turn containing the owner prompt, final
summary, and attempted endpoint/method pairs. The bounded journal records every
distinct endpoint and method it can admit; once full, it records that condition
and blocks further distinct state-changing calls before dispatch instead of
silently omitting them. Raw tool arguments and results are not copied into the
journal or recovery records. Existing Agent browser state without this field
loads as an empty journal in the same database and store. The most recent
recovery record is always retained in the next model request even when ordinary
history is trimmed to the model budget.

The main agent uses strict OpenRouter compatibility, sequential tool calls,
and requires the model to choose a real tool on the first step of every turn.
The OpenRouter runtime uses a bounded tool-step budget. Its final allowed step
disables tools so the model must synthesize a response instead of ending on an
unreported tool result. The owner can still press Stop, and model-step,
invocation-lifetime, and delegated-call budgets apply independently. The model
is explicitly required to summarize the result before ending instead of
stopping directly after its last tool call.
Models shown in the searchable picker must advertise both `tools` and
`tool_choice`. The picker searches friendly names, exact model ids, and
publisher names; it can filter for reasoning-capable or free models and shows
context size plus labelled per-million-token input and output pricing. Model
refresh lives in the picker, while conversation reset and credential
disconnect live in the header's overflow menu. The compact header keeps the
Agent Mode control visible and remains usable in narrow tiles. Reasoning is set to high when
the model advertises it. Complete AI SDK
assistant tool-call and tool-result messages are retained as bounded whole
turns and sent back on later requests. The visible transcript remains a compact
projection, but it is not used to reconstruct model tool history.
Existing visible conversations from older builds remain on screen, while their
incomplete hidden protocol history is discarded once instead of being trusted.
While a turn runs, one compact tool row shows the latest activity. A new tool
replaces it, a completed tool remains visible while the model continues
thinking, and the row disappears only with the final response or error.

Provider errors, timeout, disconnect, abort, malformed output, or a missing
decision fail closed as deny with no retry. Stop aborts the active model
request, and the kernel invalidates the full invocation tree. The kernel can
bind a decision to this approved app and version, but it cannot prove that this
app obtained the response from a model. Enabling Agent Mode therefore means
trusting Agent as the orchestrator; other installed apps remain
untrusted.

For the PocketIC-only Playwright login, composer preparation, trace API, and
its production security boundary, see [Agent Local Development](./DEVELOPMENT.md).
