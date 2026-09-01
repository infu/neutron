# Agent

Resident OpenRouter chat agent for Neutron. The kernel owns authorization and
durable credentials; the app background process receives its declared key in
memory and uses the Vercel AI SDK to stream model requests directly.

Each Agent tile has its own visible transcript, hidden model turns, reset
boundary, and state-change recovery journal. The resident derives that scope
from the kernel-authenticated tile endpoint; the tile cannot select or read
another tile's conversation. A tile keeps its history across reloads and
workspace moves because its instance id is durable, while a newly opened tile
starts empty. The OpenRouter connection and model catalog stay shared in the
resident process. Model selection belongs to each tile; changing it also sets
the initial model for future tiles without changing any existing tile. Turns
from different tiles can run in parallel, while the same tile remains limited
to one turn across all of its open browser tabs. Shared connection changes and
the explicit clear-all action are blocked while any turn is active.
The legacy shared conversation stored before tile-scoped histories had no tile
identity, so it is moved once to the first authenticated Agent tile that loads
after the upgrade instead of being copied into every tile.
The tile menu can clear only the current conversation or, after explicit
confirmation, clear retained conversation history for every Agent tile.
If a transcript grows beyond the safe tile-transport budget, the tile shows
the newest messages and the count of earlier messages that remain retained.

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
challenges normally exclude raw tool arguments. Two deliberate exceptions
carry the complete bounded value being decided: a v2 external signed-call
challenge includes its canonical prepared argument array, and a nested
`provider_once` challenge includes the target provider's complete prepared
review. The runtime makes one separate `generateText` request
with the selected OpenRouter model and one forced `permission_decision` tool.
It receives the current owner goal and those permission facts, not the
transcript, tool output, credentials, private keys, or transport ids.

A direct root call to a `provider_once` tool resolves the provider's scoped
approval callback without owner UI. If an invoked app calls that provider as a
descendant, the complete provider review reaches the decision path above;
exact or wildcard frontend session grants cannot bypass it. This remains
live-turn authority. Enabling Agent Mode does not let the resident start future
turns unattended: every root still begins from the focused Agent tile with
transient user activation.

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
Each tile also has a default-off Web control in its composer. Enabling it makes
bounded OpenRouter server-side search and public-page or PDF extraction
available for that tile's turns until the tile reloads or the owner turns it
off. The browser still connects only to OpenRouter; target-site CORS does not
apply and no Motoko HTTP outcall is involved. Web tools are available only to
the initial model step, and provider retries are disabled for Web turns.
Provider citation metadata is reduced to validated HTTP(S) titles and URLs;
raw result excerpts are not appended, although the model's answer may quote or
summarize them. Search queries and fetched content cross an additional
third-party boundary. The system prompt forbids placing private workspace data
in them and treats every result as untrusted input, but this is a model
instruction rather than a browser-enforced separation. Enable Web only when
the prompt and retained conversation context are suitable to share.

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
disconnect live in the settings menu. The short model-family selector, Web and
Agent Mode icons, settings icon, and Send or Stop control share a compact footer
inside the message composer and remain usable in narrow tiles. Every icon-only
control has an accessible name and a tooltip. Opening the selector
shows variants of the current model family; its Back control opens the complete
catalog. Reasoning is set to high when the model advertises it. Complete AI SDK
assistant tool-call and tool-result messages are retained as bounded whole
turns and sent back on later requests. The visible transcript remains a compact
projection, but it is not used to reconstruct model tool history.
Existing visible conversations from older builds remain on screen, while their
incomplete hidden protocol history is discarded once instead of being trusted.
While a turn runs, one compact tool row shows the latest activity. A new tool
replaces it, a completed tool remains visible while the model continues
thinking, and the row disappears only with the final response or error.
Completed assistant text is rendered locally as CommonMark with GitHub
Flavored Markdown tables, task lists, autolinks, strikethrough, and inline or
block TeX math. Footnote links stay within the transcript. Raw HTML and images
are not rendered, unsafe or relative links remain
inert text, and safe HTTP(S) destinations are shown and can be copied through
the trusted Kernel clipboard control. User prompts remain literal text. Agent
stores the original bounded Markdown, never rendered HTML.

Provider errors, timeout, disconnect, abort, malformed output, or a missing
decision fail closed as deny with no retry. Stop aborts this tile's active model
request, and the kernel invalidates the full invocation tree. The kernel can
bind a decision to this approved app and version, but it cannot prove that this
app obtained the response from a model. Enabling Agent Mode therefore means
trusting Agent as the orchestrator; other installed apps remain
untrusted.

For the PocketIC-only Playwright login, composer preparation, trace API, and
its production security boundary, see [Agent Local Development](./DEVELOPMENT.md).
