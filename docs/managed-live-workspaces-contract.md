# Live-workspace contract v1 — target, not deployed behavior

Foundation for #103/#104. The approved product requirements are in
[the consolidated plan](managed-live-workspaces-plan.md). This document pins the
implementation seams; it does not authorise activation, migration application,
service replacement, or push. The executable syntax fixtures are
`config/agent/extensions/managed-sessions/live-workspace-contracts.ts`.
Existing `contracts.ts` remains the deployed adapter/storage contract until the
corresponding feature issues integrate these seams. Do not infer implementation
from a schema declaration.

## Identity and persistence

| Entity | Authority and lifetime |
| --- | --- |
| host | Configured stable host ID plus exact configured bot MXID; never inferred from a name |
| project | Existing host-validated Git common-directory project key (#83); non-Git compatibility identity retained, but no default enrollment |
| checkout | `checkout_` plus 32 hex from host ID, project key and canonical checkout root; a subdirectory does not create another checkout |
| conversation | Existing `conv_` derivation from host and immutable creation key; multiple conversations may share a checkout |
| generation | Existing append-only ordinal and V2 generation derivation; newest generation alone is Matrix-active |
| creation | Caller frontend persists a random retry key before create; name/title never acts as the key |
| title | Mutable bounded human text, last accepted serialized change; fallback `conversation-<unique short ID>` lengthens on collision |
| launch | One durable `launch_` identity for conversation, generation and launch ordinal; concurrent requests join it |
| retirement | One terminal `retirement_` identity for conversation; never removed or reused |
| Matrix IDs | Exact verified room and Space IDs, independent of mutable aliases/names |

New identities use the existing length-framed SHA-256 convention with distinct
`pi-managed-sessions:<domain>:live-v1` domains and 32 hex suffixes. Checkout
inputs are host ID, project key, canonical root (not common directory or cwd).
Launch inputs are conversation ID, generation ID and monotonic launch ordinal.
Retirement inputs are conversation ID. Preview, approval, cleanup and account
IDs use respectively frozen preview identity, run/tool-call identity, retired
ancestor identity and frozen account operation identity in their own domains.
Preserve all existing conversation/project/generation derivations unchanged.

The logical conversation retains portable placement, checkout/project keys,
room/Space IDs, title revision and generation history. Private host state owns
canonical paths, exact process observations, approvals, launch/provisioning
intents, delivery/projection metadata and pending cleanup. Synchronized minimal
retirement tombstones contain host, conversation, creation and retirement IDs;
private cleanup keeps exact Matrix targets until both actors finish. Load and
validate tombstones **before** manifests. A matching tombstone excludes the
manifest from active inventory and rejects every attachment/create/open retry.
Conflicting ownership or mismatched creation keys fail closed, not a best-effort
merge. Local transcripts remain intact. A new conversation may explicitly use
retired history as context with new ownership and a fresh projection boundary.

### Roomless local enrollment

A locally registered conversation without a Matrix binding lives in the private
registry's versioned `localConversations` records, not in a synchronized manifest
with a placeholder room ID. Local identity, nonce and attachment persist
independently of remote provisioning. Before publishing a real bound manifest,
persist an exact verified binding receipt privately; recover an interrupted
publication only when its logical identity and Matrix IDs match that receipt.
Completing the binding preserves the existing attachment and nonce.

`local-enrollment-v1` is required to attach while roomless. Capable clients receive
`matrixBinding: pending|bound`; `bound` means a stored Matrix binding, not account
membership or phone readiness. Legacy binding requests retain their bound-only
behavior. A pending enrollment must not terminate the foreground Pi or authorize
an implicit later process handoff.

## Host operations

The public command is `pi-managed-session <noun> <action> ... [--json]`.
Action names in the executable schema are the wire IDs; CLI dots become spaces.
All interfaces call one dispatcher, not parallel lifecycle implementations.
The exact field names below are the schema fields. CLI fields use kebab-case
flags, except a sole conversation ID is positional. Workspace operations use
`--root-key` and `--workspace`. Nested creation placement uses those flags plus
`--relative-cwd` (default empty). No prefix/title lookup or arbitrary tmux target
is accepted. No shell interpolation or caller-provided executable/path exists.

| Action ID | Required fields (optional in parentheses) | Result data |
| --- | --- | --- |
| host.status | none | hostId, relayState, capabilities, accountState |
| workspace.list | (limit, cursor) | items of rootKey/workspace/checkoutId/projectKey/availability, nextCursor |
| project.create | creationKey, rootKey, workspace, title | conversationId, launchId, setupState |
| worktree.list | rootKey, workspace, (limit, cursor) | items of rootKey/workspace/checkoutId/branch/locked/availability, nextCursor |
| worktree.create | creationKey, rootKey, workspace, baseRef, branch | rootKey, workspace, checkoutId |
| worktree.conversation.create | previous fields plus title | conversationId, launchId, setupState |
| worktree.remove.preview | rootKey, workspace, (mergeTarget) | previewId, expiresAt, targets, activeRuns, blockers |
| worktree.remove.apply | previewId, confirmed=true | operationId, cleanupState |
| worktree.conversation.cleanup.preview | conversationId, (mergeTarget) | previewId, expiresAt, targets, activeRuns, blockers |
| worktree.conversation.cleanup.apply | previewId, confirmed=true | operationId, cleanupState |
| worktree.branch.preview | rootKey, workspace, branch, mergeTarget | previewId, expiresAt, targets, activeRuns, blockers |
| worktree.branch.delete | previewId, confirmed=true | operationId, cleanupState |
| conversation.list | (limit, cursor) | items of conversation summary, nextCursor |
| conversation.status | conversationId | conversation summary |
| conversation.create | creationKey, title, placement | conversationId, launchId, setupState |
| conversation.open | conversationId | conversationId, launchId, launchState, window |
| conversation.resume | conversationId | conversationId, launchId, launchState |
| conversation.stop | conversationId | conversationId, runtimeState |
| conversation.refresh | conversationId, confirmed=true | conversationId, launchId, launchState |
| conversation.delete | conversationId, confirmed=true | conversationId, retirementId, cleanupState |
| conversation.delete.preview | conversationIds (1–100 exact unique IDs) | previewId, expiresAt, targets, activeRuns, blockers |
| conversation.delete.apply | previewId, confirmed=true | operationId, cleanupState |
| space.reconcile.preview | none | previewId, expiresAt, targets, activeRuns, blockers |
| space.reconcile.apply | previewId, confirmed=true | operationId, cleanupState |
| space.cleanup.preview | none | previewId, expiresAt, targets, activeRuns, blockers |
| space.cleanup.apply | previewId, confirmed=true | operationId, cleanupState |
| coordinator.membership.restore | confirmed=true | conversationId, setupState |

Creation creates and opens an empty session; it never injects an objective.
Worktree/create and constructive bundles reuse existing #83 validated primitives.
Branch previews use an existing repository workspace, not the removed checkout or
an old removal receipt. This explicit read-only action was approved during #108;
branch deletion accepts only its fresh branch preview, not a removal preview.
Branch deletion uses a separately issued preview/confirmation of the unchanged
branch tip and merge target after checkout removal, not the earlier removal's
approval. Bulk lists never silently expand to subsequently discovered targets.
Space apply uses existing #68 reconciliation intents extended to checkout Spaces.

A conversation summary contains only conversationId, kind, title, checkoutId
(project only), projectKey (project only), runtimeState, launchState, setupState,
activeGenerationId, optional exact marked window, optional bounded error code,
and capabilities. Project summaries may include logical placement (rootKey,
workspace, relativeCwd) and project/checkout display names, never an absolute cwd.
Legacy project rows without a
verified checkout identity instead carry `reconciliationRequired: true`, omit
checkoutId, and include projectKey only when already known. Inventory reads do
not invent identities or perform migration. Window means sessionName, windowId, paneId and conversationId
observed by the trusted launcher; only the local picker may use it to switch.
No nonce, token, prompt, host path, raw exception or tool output is returned.
`runtimeState` is running/stopped/unknown; `launchState` is none/prepared/
window_created/attached/failed; `setupState` is pending/ready/disconnected/
notification_setup_uncertain; `cleanupState` is pending/complete/failed.
`relayState` is ready/disconnected; `accountState` is ready/pending/unavailable.
Workspace rows likewise use `reconciliationRequired: true` instead of inventing
missing or contradictory checkout identities, and may include display names.
Detached worktrees omit `branch`; metadata inventory does not imply a clean Git
working tree. Workspace/worktree discovery is bounded and cached for 30 seconds;
these last-known display observations never authorize mutations.

Each JSON response is exactly `{version, requestId, ok, data}` or
`{version, requestId, ok, error:{code,message,retryable}}`, with literal version
`1.0.0` and discriminating Boolean `ok`. Fields inside `data` are the exact
operation-specific table fields (no extras). Nullable `nextCursor` ends paging.
All responses/requests fit one 64 KiB UTF-8 LF frame. Messages are at most 512
characters; list pages default to 50 and cap at 100. A page also stops before the
frame byte bound. Opaque cursors bind host, action/filter and snapshot revision,
expire after 60 seconds and fail with `stale_preview` rather than mixing snapshots.
Sort inventory by immutable identity, independent of display/picker ordering.
Preview targets are at most 100 and bounded by the same frame limit; a larger
operation must be split by the caller, not silently truncated. Preview lifetime
is 15 minutes. Confirmation revalidates every target and precondition.

Exit status: success 0; invalid request 2; unavailable 3; not-found/retired 4;
forbidden/approval-required/denied/expired/cancelled 5; conflict/busy/stale-preview
6; upgrade-required 7; accepted-but-pending 8; terminal failure 9. No raw internal
error strings. With `--json`, stdout contains exactly one result and diagnostics
use stderr. A pending result is success-shaped with its durable operation ID,
but exit 8 distinguishes it from completed effects. Lost replies are recovered
by repeating the same requestId; changing payload under that ID is a conflict.
The staged read-only dispatcher joins in-flight retries and retains validated
responses/errors in memory for 60 seconds after completion (1,024 entries by
default, at most 4,096). It never evicts in-flight or unexpired identities to admit
new work. Use a new request ID for a fresh observation; restart/expiry discards
this read cache. It is not a mutation execution journal. Under the operator's
2026-10-02 amendment, uncertain host mutations are not automatically retried and
completed approval outcomes do not require durable replay receipts. Existing
operation-specific retirement/launch safety intents remain separate.

Compatibility wrappers: `pi-managed-session-status` calls host status when the
control endpoint is present, retaining its established health output/exit behavior
for existing scripts. During guarded rollout of pre-control relays, it retains
the legacy read-only health fallback; it is not the picker inventory interface. Legacy
`conversation.start` maps to create, `project.reconcile.*` to `space.reconcile.*`,
`project.space.cleanup` to frozen cleanup apply. Legacy `/remote delete` and all
close/delete aliases map to retirement, never the previous bridge-only deletion.
Adapters without the new approval capability cannot invoke legacy mutation
aliases to bypass approvals: return upgrade-required. During staged rollout,
`/remote delete` is disabled: its bridge-only implementation and help entry are
removed, and neither the adapter nor relay sends/executes legacy unbinding.
Canonical alias exposure belongs to the approved frontend cutover (#113); until
then, refusal preserves the binding. Verified operator room departure already
uses canonical retirement. Room-local human aliases
are normalized with authenticated event provenance before dispatch. `!start`
uses resume without a prompt; `!abort` remains a run interruption, not host stop.
All frontends expose bounded help generated from this operation contract.

## Authentication and approval

`$XDG_RUNTIME_DIR/pi-managed-sessions/control.sock` is a separate mode-0600
peer-UID-checked socket in the mode-0700 relay directory. UID lookup failure is
rejection. It never accepts adapter attachment nonces or impersonates a
coordinator. Disabled hosts create no socket. The adapter `relay.sock` retains
its separate nonce-authenticated channel. The same-user shell trust limitation
is intentional: typed approvals are not a sandbox against malicious local code.

Actor context is constructed by the frontend, never part of model tool fields.
Matrix actors resolve sender and originating room from accepted event provenance;
model calls bind exact conversation, generation, run and tool-call IDs. The
relay validates this against the live attachment/run before presenting approval.
Mixed users do not confer inherited operator authority. Ambiguous origin or
stale generation returns forbidden/cancelled, not a different approval route.
Only the configured operator or explicitly configured verified owner bridge
identity may issue lifecycle commands or vote on mutation approval. Ordinary
joined participants can prompt, steer and propose actions, but cannot approve.

Every valid mutation requested by a model requires its **own** approval. The
schema's enumerated read-only set is the only exemption; unknown actions fail
validation and newly classified mutations default gated. Nix owns centrally
validated policy overrides; no runtime policy editor exists. Human explicit
launch/open/resume/wake/start/stop need no extra approval. Human refresh/delete,
bulk/destructive work and Space apply/cleanup need confirmation of the exact
preview. Coordinator stop/delete remain forbidden regardless of approval.

Freeze the normalized action, all effects/preconditions, requester identity,
origin and expiry before presenting. Expiry is accepted time plus 15 minutes;
never extend it on retry. Local-origin model calls await a native Pi dialog;
Matrix-origin calls await a poll in the originating conversation. The tool stays
pending without a checkpoint abort and without holding a broad lifecycle lock.
Denial returns `denied by operator` as a normal tool result, allowing the turn to
continue. A new identical call may request approval again.

Pending phases: prepared → presented → approved/denied/expired/cancelled →
accepted (consent consumed before the execution attempt). Completion/failure is
reported to a connected caller, not retained as a durable replay receipt.
Revalidate immediately before consuming consent.
Run end, stop, retirement or generation replacement cancels **unaccepted**
approvals. Restart retains a pending approval only with original expiry and
positive live requester revalidation; unknown is cancel, not approve. Duplicate
votes cannot start another attempt while an approval is active. An admitted
attempt may finish independently of its caller, including self-stop/delete,
but an uncertain outcome is reported without automatic mutation retry. On relay
restart, consumed consent is never an instruction to resume execution; uncertain
or interrupted requests require inspection and a new explicit call/approval.
Completed approval records are discarded, not retained indefinitely. Pending
records retain their original expiry and are removed when no longer needed.
This operator-approved simplification replaces stable result replay and
at-most-once guarantees across disconnection/restart; existing owner-specific
safety intents and checks remain intact. Failed preconditions require a new
preview/call; never expand an already approved bundle.

## Launch, status and retirement ordering

Launch phases: prepared (generation and nonce verifier durable) → window_created
(exact server/window/pane identity and marker observed) → attached (matching live
adapter), or failed (redacted reason, retain exact failed window). Simultaneous
open/resume/wake use one launch identity. Reconcile an uncertain launcher result
by exact marker and generation, never by tmux index/name alone. `open` returns
at window_created; `resume` waits up to the existing 60-second attachment bound.
Continue bounded monitoring after open returns. Closing the picker does not
cancel the accepted launch. Remote requests never switch local clients.

Only an exact marked window with positive current Pi/process evidence counts as
running. During relay reconnect grace, use validated launcher process evidence;
a stale attachment, shell wrapper, dead pane or mere marker is insufficient.
Unavailable observation means unknown, not stopped or permission to recreate.
Revalidate stable server, window and pane identity/marker before switch/kill.
Prefer clear failures and explicit manual retry over elaborate recovery. A
retained dead pane is left untouched and blocks retry until the operator closes
it. Do not create archival or successor windows to work around it. After manual
closure, revalidate disappearance and ownership before permitting a fresh launch;
closure alone does not prove that an orphaned original process exited. Manual
window kill makes the conversation dormant; a new authorized input may wake it,
cancelled old work cannot. Coordinator opening uses its protected bootstrap/ensure path.

Names are `● title` for known running and `○ title` for stopped/failed. Unknown
keeps last-known presentation with honest detailed status. Typing indicates
active model work only. Reconcile all host-owned conversations on reconnect,
attachment changes and every 10 seconds through a shared bounded local snapshot;
coalesce requests and update Matrix only on changes. No cross-host heartbeat.
Manual title and Pi `/name` observations serialize to a monotonic title revision;
strip only the harness-owned status prefix, suppress self-echo by accepted event
identity, and never use title collisions as identity.

Retirement takes precedence over launch, input, generation transition and
unaccepted approvals. Under the conversation lock, persist retirement and exact
cleanup intent before cancelling input/approval work, stopping its exact process,
or changing active manifests. Never remove stop evidence before confirmed stop.
A process that cannot be stopped remains visible as pending cleanup failure.
Retirement is irreversible even during Matrix/NAS outage. Account leave/forget,
bot leave and worktree/project ancestor cleanup are independent durable effects.
Operator clarification: offline retirement freezes only the originally identified
ancestor Space IDs and expected ownership under the original delete consent.
After reconnection, cleanup may run automatically, but each attempt must freshly
verify ownership, emptiness and references. Never discover or add new ancestor
targets on retry, remove the host Space, or treat cached state as proof of emptiness. Never remove host Space, foreign children or other
participants. Compact only confirmed cleanup into a permanent tombstone. An
operator's verified voluntary room departure uses the same path; uncertain
membership removal does not authorize retirement. Space departure never
cascades. Coordinator departure suppresses auto-invite without retiring it;
explicit local membership restore is the recovery route.

## NAS account protocol

Reuse the dedicated secret-managed owner login in the isolated bridge-chat
transport. Account policy is a separate deterministic consumer of Matrix sync,
with its own durable inbox/outbox and no model socket traffic. Do not reuse the
assistant's uncertain-message-send state machine or question selection policy.

Use custom **to-device** events `lol.bepis.pi.account.request.v1` and
`lol.bepis.pi.account.ack.v1`, via fixed Matrix endpoints and recipient identities
from host/NAS configuration. Payloads are the executable AccountAction/Ack
schemas, at most 16 KiB. The `payloadDigest` is SHA-256 of compact UTF-8 JSON with
recursively sorted object keys, excluding requestId and payloadDigest; no
undefined values or floating-point data occur. The requestId is derived from
host ID and payload digest. Uncertain HTTP retries reuse exact content and transaction ID. Operator-approved
correction: intentional redelivery after an accepted send uses a fresh persisted
Matrix transmission ID, retaining the exact account content/request ID and durable
receiver deduplication. Otherwise Matrix's transaction deduplication would prevent
re-enqueueing a lost device message. Ack echoes hostId/requestId/payloadDigest.
Operator-approved ordering correction: every ack requires a positive safe-integer
`revision`, assigned durably and monotonically per request by the NAS. Identical
progress retains its revision; changed progress increments it. Invalidation must
retain the counter. Hosts retain the high-water mark across restart and coordinator
restoration, ignore older revisions, and reject conflicting reuse of a revision.
Unversioned persisted acknowledgements require explicit recovery rather than a
silent counter reset. Conflicting request identity reuse is rejected.
The authenticated Matrix envelope sender must match the configured host bot
(or owner account for an ack), never a payload sender string. Trusted host IDs
must map one-to-one to configured bot MXIDs. No arbitrary recipients, endpoints,
HTTP methods, credentials or message bodies are legal action fields.

Persist to-device intake before advancing the shared sync cursor. Lost request
or ack is recovered by resending the same frozen request; the NAS returns its
saved progress. Expired Matrix device queues are therefore not durable authority.
Only the NAS transport sees owner credentials. The host does not read account
rules through its bot token or send owner secrets over adapter IPC.

`room.ensure` supplies the exact full hierarchy and creation/conversation
identity **before invitation acceptance**, separately from limited stripped
invite state. It is an authenticated host attestation, not proof by room name.
Match an existing/new invite's sender against that host and exact target. Check
available create/encryption/management state and reject contradictions. After
joining, validate management state and exact parent relationships before marking
ready; do not adopt foreign rooms based on matching names. Management state
`lol.bepis.pi.managed.v1` contains version, hostId, kind, creationKey and applicable
conversationId/projectKey/checkoutId/parentRoomId, authored by the trusted bot.
An unavailable proof remains pending. Existing verified pending invites are
eligible; unrelated invites are untouched. Encrypted targets fail explicitly,
never silently downgrade. Migration requests use notificationSetup=preserve.

Operator-approved legacy-host exception: during **new conversation provisioning**,
the relay may add a missing ownership marker to the existing host Space identified
by its saved coordinator binding, after verifying bot ownership, private state
and authority. Existing matching proof is read-only; contradictory or foreign
proof blocks provisioning. This is not startup-wide migration: do not replace
the Space, move children, rename anything or alter notification settings. An
uncertain write must be followed by a fresh read before another write attempt.

Local hierarchy reservations precede remote effects. `hierarchy_ready` records
completed provisioning, not current account membership or phone readiness.
Creation attempts are durable before sending; saved room IDs outrank mutable
aliases. If an attempted create has no saved ID and its alias is now absent,
hold pending for explicit reconciliation: absence cannot distinguish no creation
from accepted creation followed by alias removal. Do not broaden metadata scans
or create a replacement automatically. Fresh coordinator bootstrap follows the
same ownership/attempt/ID/link discipline. Existing coordinator/host bindings
remain unchanged on startup, even when inaccessible; repair and membership
restoration require their separately authorized operations.

`room.retire` is only for a known verified conversation identity; `space.retire`
is only for a known verified empty non-host ancestor authorized by host cleanup.
The NAS persists suppression before leave/forget, keeping enough verified IDs to
finish if the bot already left. Deliberate account departure likewise persists
suppression before any ensure replay. A new conversation/room identity is needed
to reopen retired history. A matching coordinator ensure does not defeat its
intentional-departure suppression. A separately authorized membership restore
uses the typed `coordinator.membership.restore` account request and clears only
that coordinator suppression under its previously verified protected identity.
Operator-approved correction: the request additionally requires `departureEventId`,
the exact authenticated Matrix departure event frozen by the host, not supplied by
a model. It participates in the account request digest. Restoration atomically
records completion with clearing only that matching suppression; old requests and
old sync events cannot undo a later departure or a completed restoration.
Departure acknowledgements may echo `departureEventId` (only with `code=departed`)
so a delayed notice for the restored departure can be ignored. Restoration also
invalidates the NAS's old ensure acknowledgement before publishing completion.
Coordinator membership notices alone are not retirement authority.

### Notification initialization and the operator's uncertainty decision

For a new verified conversation, initialize its rules once, preferably before
join/ordinary traffic. Record each exact rule payload and an `attempted` marker
**before** its first PUT. A successful response yields confirmed; lost response
or crash in attempted yields uncertain. A pre-existing rule is preserved, never
replaced as initialization. Read-only reconciliation may confirm the exact
expected rule, but absent/changed rules after an attempted write **never** trigger
automatic writes: the operator may have deliberately removed or changed it.
Multiple rule steps track separate attempted markers, and uncertainty does not
justify rewriting earlier steps. Existing/migrated rooms use preserved state.
The host freezes a private preservation baseline before starting account producers;
restarts do not reclassify old reservations or reset room preferences. The silent
rule uses the `underride` category so manual room/override rules take priority;
attention relies on normal mention/default rules, not a notify override. Existing
experimental override-rule journals require explicit recovery, never automatic
removal or rewriting of personal account settings.

Matrix push-rule PUT has neither a transaction ID nor a specified conditional
compare-and-set update. GET-then-PUT cannot eliminate races with client changes.
The once-only attempt is therefore best-effort initialization, not exactly-once
application. A client edit racing the first request is outside an atomicity
guarantee; never claim otherwise. Source: [Matrix push rules](https://spec.matrix.org/v1.13/client-server-api/#push-rules).

**Operator decision (2026-10-01):** an uncertain setup does not block transcript
synchronization. Continue using current client settings and expose a bounded
`notification_setup_uncertain` warning in status/setup acknowledgement. Do not
repeatedly notify or automatically repair it; manual client choices prevail.
No `!notify` command is introduced. Account outages delay account effects, not
local work or existing session execution.

## Projection and notification disposition

Persist local-user entries, completed commentary, final answers, checkpoints and
existing bounded activity summaries with entry/generation/branch identity. Never
thinking, raw tools/logs, partial tokens, compaction or pre-binding history.
Matrix-origin user entries map to original events. Commentary is emitted once
per persisted completed entry, not accumulated again into the final answer.
`/tree` records a silent branch-change boundary with subsequent new activity only.
`/new` and `/fork` durably append a generation while keeping the room; block saved
session switching while bound. Transition/input/stop/retirement serialize on the
same conversation authority and invalidate stale attachment generations.

Freeze `{sourceId, generationId, branchId, disposition, attentionId?, chunks}`
before first network send; `disposition` is silent/notify. Local text/commentary,
activity and housekeeping are silent. Finals, unanswered checkpoints, approval
requests and persistent terminal failures notify. Chunking/order/transaction IDs
are stable; only one chunk bears notification for an attention event. Checkpoint
and final with the same explicit attentionId coalesce; do not infer equality from
similar prose. The narrow Matrix event metadata is `lol.bepis.pi.notification` with exactly
`{version:1, disposition:"silent"|"notify"}`. Silent text carries empty
`m.mentions`; notifying text requests a room mention. No metadata contains a
credential, notification rule, endpoint or model-provided authority. Matrix
account push rules implement requested disposition but
manual room muting and OS/phone policy still decide actual alerts.

Persist an outage epoch and source watermark before recovery offers are accepted.
Previously unaccepted historical finals/commentary are silent catch-up. Frozen
accepted sends retain their exact payload even if interrupted while notifying;
never reuse a transaction ID with newly silent content. This is the necessary
exception to silent historical catch-up, not permission to generate new alerts
for old answers. After backlog reconciliation, revalidate current attention
(unanswered checkpoint, unresolved blocker, live unexpired approval). At most one
new actionable recovery alert per conversation/outage epoch, with a stable
recovery attention ID; obsolete work gets none. Persist that selection before
send. Do not expire or reinterpret an accepted frozen payload on retry.

Checkpoint/blocker recovery requires fresh confirmation from the attached adapter
for the exact conversation and active generation, after backlog reconciliation.
The relay's publication ledger alone does not prove that local input has not
superseded a checkpoint. If the adapter is absent, defer the recovery check until
it naturally reconnects; never wake a dormant conversation just to check. Do not
inspect saved Pi transcripts from the relay to obtain this confirmation. Ordinary
synchronization continues independently. This freshness boundary was explicitly
approved by the operator for #111.

## Matrix split-fork amendment (#125; approved 2026-10-05)

The typed `worktree.conversation.fork` operation creates a
new branch/worktree from a frozen committed Git base and a new conversation/room,
with an explicit bounded summary as initial Pi context and a visible destination
Matrix message. It does not perform native `/fork`, clone the source transcript,
change the source conversation, or transfer uncommitted changes. The destination
stays idle until subsequent authorized input: summary persistence, publication,
attachment and recovery must not trigger a model turn.

Use existing host creation/approval authority. Consent freezes exact source and
target identities, the base commit, and summary content. A summary supplied by the
existing source agent is intentional inherited context, not relay transcript
inspection or a background summarization service. This is a narrow exception to
ordinary creation's no-initial-content rule, not arbitrary task injection. No
binding, input receipt, approval or unfinished execution is inherited. Persist
operation-specific construction and summary effects before execution; retries
cannot create another room, duplicate the summary, expand scope or revive retired
identities. Do not accept target input before context initialization is durable.
Publish the summary silently, with stable delivery identity.

Fields are `rootKey`, `workspace`, `creationKey`, `title`, `sourceConversationId`,
`baseRef`, `branch`, and `summary` (4096 characters / 8192 UTF-8 bytes). Model and
Matrix-human callers must originate in that source conversation; local humans may
supply an explicit source. The source must be a nontransitioning project at the
specified checkout. Source generation and base commit are frozen by the owner,
not supplied as caller authority. Approval shows the literal summary once and
rejects oversized displays without truncation. Result includes `conversationId`,
`launchId`, `setupState`, and `roomLink`.

The existing worktree intent stores an optional strict context seed. It is never
forwarded to the Git launcher. The seed is atomically published as a visible native
Pi custom-message alongside the new session/binding boundary. A silent notice is
persisted before registration with `awaitRegistration:true`; unknown registration
holds that notice, retirement discards it, and an unrelated replacement room is
refused. No registration exposes a session missing its initial context. Retries
must match the initial Pi session and exact frozen notice, even after later
navigation. Existing notices without this field retain their semantics; older
strict readers are not a supported downgrade.

#125 owns this implementation, separate from #114 native navigation. The operator
has now approved #114's scoped native handoff; implementation remains separate.
Deployment/live acceptance remains separately gated under #120/#121.

## Version and rollout boundary

At baseline 9893e0f, `contracts.ts` advertises adapter/state `1.0.0` and carries
staged V2 fields; `v2-contracts.ts` and its explicit migration are not the live
reader. #63 remains open and owns its V2 cutover. Do not silently activate its
migration, flatten generation history, or change its version constant here.
Host-control and account protocols have independent v1 versions. New live
workspace stores use a private `live-workspaces/` directory with explicit schema
version `1.0.0`; tombstones, account state and pending effects join the backup
boundary. Older relays ignoring that directory are an **unsupported downgrade**.

Adapter additions use explicit capability negotiation, not guessed build ages.
The new relay accepts the established baseline attach envelope unchanged. A new
adapter explicitly requests a bounded subset of implemented live-workspace
capabilities in its attach request; only a requesting adapter receives the
corresponding accepted-capabilities field or new messages. The first implemented
capabilities are `commentary-v1`, `notification-disposition-v1`, and
`recovery-attention-v1`. Legacy attach requests and responses remain
unchanged. New adapters require relay-first deployment; an older strict relay
cannot accept their new request fields.
Legacy attachments keep input/receipts/final projection and existing process
lifetime. They receive upgrade-required for new generation-navigation or model
host mutation operations, including old coordinator aliases. Do not claim old
in-memory adapters gain new session hooks. An old adapter's local `/new`/`/fork`
can still detach under its historical semantics: status must expose legacy
capabilities, and full navigation acceptance requires a deliberate idle refresh.
No busy process or tmux restart is authorised simply to complete migration.

Relay first, new adapters second. Gate feature paths on negotiated capability;
strict old adapters must never receive unrecognized message fields. Idle-only
runtime maintenance retains its existing authority; deployment/live acceptance
remains separate. The #63 future cutover must migrate the complete live-workspace
sidecar as well as existing registry/manifests, and then remove staging readers
in its separately authorised breaking release. A partial restore or mixed
pre-retirement backup plus current state is rejected unless tombstones are kept;
never restore active manifests while discarding newer retirement records.

Reuse #68 Space reconciliation, #83 Git intents/validation, #90/#97 isolated NAS
transport, #96 first-window placement/local prompt behavior and #91/#94/#95
activity/delivery/update recovery. No second migration engine or generic manager.

## Recovery and evidence ownership

| Crash boundary | Durable identity before effect | Required recovery/test owner |
| --- | --- | --- |
| provision room/Space, lost create response | provisioning key and alias target | #106: resolve same verified target, no duplicate/foreign adoption |
| control accept/result loss | requestId and normalized payload | #107: exact retry returns same result, conflict rejects |
| approval present/vote/execute | frozen approval/run/expiry | #108: duplicate votes, stopped requester and accepted self-delete |
| retire/stop/unlink/leave/forget | retirement + per-effect cleanup IDs | #109/#112: tombstone wins, independent retry, no false stopped claim |
| launch/window/attach | launch generation and stable marker | #110: concurrent open/resume, retained failure, picker exit, ID reuse |
| offer/chunk/send/ack | entry/chunk/transaction and disposition | #111: comment once, frozen notify, recovery alert coalescing |
| ensure/join/push-rule/ack | account ID/digest + per-rule attempt | #112: lost response and manual removal never cause overwrite; sync continues with warning |
| actor routing/tool wait | accepted provenance and live run | #113/#108: forged model origin rejected, no local/Matrix cross-routing |
| fork/new/branch change | generation transition + Pi boundary | #114: preserve room/history, no pre-bound replay, cancellation races |
| rename/status observation | title revision and exact process evidence | #115: stale names/markers, manual rename echo, shared snapshot |
| ordinary launcher dispatch | resolved eligible checkout and launch key | #116: local relay refusal vs Matrix outage, workers/local-only exclusion |
| migration link/update/unlink | existing #68 phase + exact IDs | #117: target link first, preserve IDs/preferences/processes |
| picker selection/disappearance | validated exact identity at action time | #118: no unrelated window switch, accepted launch survives close |
| cache publication/late inventory | atomic disposable cache snapshot | #119: concurrent writers, malformed cache, stable selection and timing |
| Nix wiring | evaluated settings/package identities | #120: roots/trust/aliases disabled surfaces, no activation claim |
| cumulative review/live acceptance | pinned Git revision + evidence | #121: canonical gate, both review axes, separately approved real clients |

#104 acceptance is executable positive/negative syntax and policy fixtures plus
these identity, action, recovery and compatibility tables. #105 has independent
profile/package tests. Every runtime leaf supplies public behavioral tests and
fault injection for its row; a passing foundation fixture is not runtime proof.
#118–#120 remain nix-dotfiles-owned handoffs and must follow that repository's
build/activation restrictions. Record exact timings separately from fixtures.
