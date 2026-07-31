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
kernel suspends that exact request and sends a redacted challenge to the
resident runtime. The runtime makes one separate `generateText` request with
the selected OpenRouter model and one forced `permission_decision` tool. It
receives only the current owner goal and kernel-produced permission facts, not
the transcript, tool output, raw arguments, credentials, or transport ids.

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

The main agent uses strict OpenRouter compatibility, sequential tool calls,
and requires the model to choose a real tool on the first step of every turn.
The OpenRouter runtime has no artificial AI SDK step-count or total-turn
timeout: it continues through tool results until the model naturally finishes,
the owner presses Stop, a model step stalls or times out, or a real
provider/tool error occurs. Neutron's separate invocation lifetime and delegated
call budgets still apply. The model is explicitly required to summarize the
result before ending instead of stopping directly after its last tool call.
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
