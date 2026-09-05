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
the initial model for future tiles without changing any existing tile. Kernel Agent Mode permits one active root across tiles. Each tile remains
limited to one turn across all of its open browser tabs; ordinary chat outside
Agent Mode can run in different tiles concurrently. Shared connection changes and
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
The one-time enable request starts from a focused Agent tile during transient
user activation. Once granted, an exact live tile in that Agent installation
may start a turn without another focus or activation check. Reload, logout, app
update, endpoint replacement, uninstall, or explicit disable revokes the grant.

During an active turn the model uses the invocation-scoped Neutron message bus
to discover apps, inspect one tool schema, and call tools. Direct agent actions
do not show owner dialogs. If a called app requests a new permission, the
kernel suspends that exact request and sends a bounded, kernel-produced
challenge to the resident runtime. Frontend, backend, connection, and workspace
challenges exclude raw tool arguments. A v2 external signed-call challenge is
the deliberate exception: it includes the complete canonical prepared argument
array shown for approval. The runtime makes one separate `generateText` request
with the selected OpenRouter model and one forced `permission_decision` tool.
It receives the original owner goal, applied steering instructions, and those
permission facts, not the transcript, tool output, credentials, private keys, or transport ids.

Tools that opt into both `"neutron:visibility":"same_app"` and
`"neutron:audience":"agent_root"` are a separate automation surface. Kernel
shows and routes such a tool only to the incoming live depth-zero Agent root,
attests that audience to the handler, and adds no owner dialog. Human callers
and nested agent calls are rejected before target dispatch. Provider-owned
foreground UI is likewise unavailable to delegated Agent calls; an app that
supports both people and root automation exposes a narrowly scoped root tool in
addition to its human presentation flow. This remains live-turn authority.
Enabling Agent Mode does not let the resident originate future roots by itself:
every root still comes from a live tile in the granted Agent installation and
the exact granted entrypoint, but it does not depend on browser focus or a
fresh activation.

Agent contains no app ids, app-specific paths, or app-specific calling rules.
Its installed-app list, live endpoints, tool descriptions, schemas, and
visibility all come from the kernel's current catalog. Apps own that contract;
adding or changing an app does not require an Agent code change.

That same discovery path exposes the Kernel's visual workspace tools. Agent
uses `list_app_tools` with `appId: "kernel"`, inspects the schema, then calls
`workspace.inspect` or `workspace.control` through the generic app-tool bridge.
Inspection reports exact workspace, tile-instance, focus, expansion, and split
state. Control applies one `open`, `focus`, `close`, `place`, `resize`, `move`,
`switch`, `expand`, or `restore` operation through the Kernel's canonical
workspace store. There is no Agent-side layout implementation.

Because Agent is a live resident background with declared `agent_entrypoints`,
these visual tools work on invocation-free calls without enabling Agent Mode.
During Agent Mode they are available only to the direct depth-zero root, not a
delegated child. They require no owner dialog and have no navigation cooldown.
The older `workspace.open_tile` tool remains the generic active-workspace
compatibility route for other app endpoints.

`move` leaves the current workspace active. `open`, `switch`, `focus`, or
`expand` brings its target workspace into view. During an Agent Mode root,
Kernel keeps the originating tile's exact endpoint connected while its
workspace is hidden. Closing that tile, replacing its endpoint, disabling Agent
Mode, logging out, or updating the app still cancels the invocation. Work does
not run after the browser closes; the saved goal is available to resume from a
live tile.

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

If a model step is interrupted after a state-changing call starts,
Agent atomically replaces the journal with a small warning turn. Startup does
the same for a journal left by a browser or process failure, pairing it with
the exact bounded owner prompt saved by the journal commit before Agent can
accept another turn. A successfully persisted complete step records its tool outcomes and clears
the journal atomically, so later steps do not exhaust the journal with already
recorded mutations. Structured stream errors, aborts, and output exhaustion
never count as successful completion. If that turn's detailed tool transcript exceeds the durable history
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

Use `/goal <objective>` to start durable goal work. `/goal` shows its state;
`/goal pause`, `/goal resume`, and `/goal clear` control it. Stop also pauses an
active goal and retains queued messages. The goal panel displays its objective,
status, and latest checkpoint. A fresh reviewer context checks actual tool
results against the objective and later owner instructions whenever the worker
proposes completion or reaches a 32-step checkpoint. It returns complete,
continue with concrete next work, or needs-input with an actual missing owner
decision. It is separate from the permission judge and grants no additional
authority. Review failure pauses the saved goal rather than accepting completion.

Enter applies a new owner message at the next safe model step, after an
in-flight tool call settles. Tab or **Queue** saves it for the next work cycle;
`/queue <message>` also queues a request. Queued messages run in order. **Run
queued** starts retained requests after an interruption. Steering wakes sleep,
and applied messages are retained as user messages in model history. Goal and
inbox records use separate IndexedDB keys so released residents cannot erase
them when saving their older conversation shape.

In **Agent Mode**, the main agent can delegate independent tasks to parallel
workers inside the same tile. `spawn_agent` starts a worker with a separate
context and the current model, or an explicit available `modelId`.
`send_message` steers a worker or resumes its saved context; `wait_agents`
waits without model requests; `stop_agent` cancels one worker with a recorded
reason. `list_agents`
lists saved workers and `get_agent_result` retrieves a worker's report and
actual tool evidence. Only the main agent receives these coordination tools.
The **Workers** panel shows tasks, models, status, results, and the latest stop
and recovery details. Intentional cancellation is shown as stopped, with its
reason, rather than as a worker error. A recovered worker retains the issue it
resumed from; a recovery is marked successful only when that worker completes.

Both the main agent and workers automatically continue responses that end at
the model's output limit. Completed tool results and partial text are saved
before the next request; partial text is not presented as a final answer, and
goal review cannot accept the truncated response as completion. Continuation
asks the model to synthesize saved evidence before collecting more and to
reconcile uncertain writes before retrying. Workers are also prompted to leave
brief summaries with source identifiers after meaningful batches of reads.
Output exhaustion is recorded as a generation limit, without guessing that
input context overflowed. Other stream errors still preserve the existing
interruption and uncertain-write recovery behavior. Steering and Stop remain
available during continuation.

Workers are internal model contexts sharing the live root's authority, not
additional tiles or Kernel roots. Model requests run concurrently. App calls
share the root's existing serial queue, so permission challenges cannot overlap.
The root permission judge receives the owner's goal and applied owner steering;
worker tasks, messages, reports, and app output cannot expand that authority.
Coordination tools are absent outside the live Agent Mode permission context.

The main agent receives completed worker reports with saved tool evidence and
keeps the root alive until active workers settle. It remains responsible for
checking the overall result. Applied owner steering reaches active workers at
their next safe step and wakes their sleep. Stop, tile closure, and Kernel
revocation cancel all workers before the root releases its permission handler.
Each worker has a separate durable conversation and mutation recovery journal;
one worker's successful step cannot clear another worker's uncertain write.
Worker records use a separate IndexedDB key that older resident saves preserve.
After a browser interruption, a new Agent Mode root can inspect paused workers
and use `send_message` to resume them. Clearing the conversation clears its
saved workers too.

The `current_time` tool returns UTC time. `sleep` waits for a finite non-negative
number of seconds without model requests, returning elapsed seconds and either
`elapsed`, `steering`, or `agent` when a worker report wakes the main agent.
Stop cancels sleep. Browser timer delays are chunked to
avoid timer overflow; they do not cap the requested wait. Sleep runs between
SDK requests, outside the model-step deadline. Individual app-tool and model
request deadlines remain; Kernel roots have no total duration, call-count,
permission-count, or start-rate cap. One root remains active at a time.

Each complete model step is saved, and context compaction retains the owner
request and recent quoted tool evidence when a single turn exceeds the model
window. Omitted details are marked, with reconciliation required for uncertain
mutations. The composer shows sleep and queue status. Completed model
messages appear while work continues; oversized progress falls back to a fresh
bounded status response. The periodic status refresh also covers the message
bus's existing progress-event limit.

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
