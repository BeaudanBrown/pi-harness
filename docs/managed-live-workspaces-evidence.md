# Live-workspace implementation evidence

Implementation authorised by the operator in the epic conversation. Deployment,
activation, live migration and push are not authorised. GitHub #103 remains the
tracker; this file records acceptance evidence, not a second task queue.

## #105 — default-off experiments

| Acceptance | Change | Evidence |
| --- | --- | --- |
| Default normal resources exclude experiments | Engineering profile and guarded package resource selection | Profile/source tests; real packaged RPC command/tool inventory |
| Explicit opt-in, disabled beats development paths | Strict 0/1 launcher switches; NixOS experiment options | RPC probes with stale development overrides; enabled Pi-R probe |
| Dedicated local evaluator unchanged | Keep pi-r-local and its runtime environment/identity | Pi-R integration and eval self-test |
| Managed and inherited workers remain narrow | Existing managed exclusions and worker profiles retained | Profile/module contracts |

Scope: #105 owns experiment resource defaults, not local-only binding/launch
semantics (#116). `pi-local` remains the dedicated experimental lean profile.
No durable state or external side effects change; crash analysis is inapplicable.
Verification: `nix build` of `pi-r-integration`, `source-contracts`,
`module-contracts`, `unit-tests`, and `eval-self-test` passed (2026-10-01).
The real packaged RPC probes cover unset and explicit-off switches, stale
AgentGraph development paths, invalid switch values, opted-in Pi-R activation
and restoration, and unchanged lean Pi-R behavior. Workspace LSP diagnostics
are clean. `nix run .#verify` subsequently passed against commit 9893e0f.
Cumulative review remains at the epic boundary. Local-only alias integration is
owned by #116.

## #104 — foundation contracts

| Acceptance | Change/evidence |
| --- | --- |
| Separate identity from title and generations | Target identity/persistence table and ADR amendment |
| Exact operations, actor origin, pagination and errors | Host action/request syntax fixtures, all-operation classification test, CLI/result tables |
| Launch/retirement/approval precedence | Durable phase and recovery tables with dependent test ownership |
| Authenticated bounded host/NAS protocol | Strict account schema, full hierarchy fixtures, credential/endpoint negative tests |
| Frozen notification and recovery semantics | Projection contract and once-attempted rule recovery fixture |
| Old adapters and pending #63 boundary | Explicit baseline inspection and capability/sidecar rollout specification |

Scope: #104 pins target contracts only. Runtime adoption, authentication and
external effects remain owned by the dependent leaves listed in the foundation
contract. The schemas do not prove those behaviors. Recovery analysis is the
contract's crash-boundary matrix. The operator resolved uncertain notification
setup: continue synchronization with current client settings and a warning,
never automatically overwrite a potentially later manual preference.

Focused `managed-session-tests` and `source-contracts` passed before review.
Standards review: two high current-issue findings (executable response contracts,
Matrix origin shape) and one medium (account digest/ID binding). Spec review:
two medium current-issue findings (response contracts, protected coordinator
policy) and one low traceability correction. All accepted and remediated in one
batch: strict per-operation response schemas with every-operation fixtures,
bounded frames/errors, typed Matrix room/MXID provenance, canonical account
identity validation and tampering fixtures, target-aware coordinator protection,
and corrected issue reference. Runtime authentication still belongs to dependent
leaves, not schema validation. Post-remediation `nix run .#verify` passed all
deterministic checks on 2026-10-01; workspace LSP diagnostics are clean. This is
contract-only work, so no separate runtime production build or live activation
is applicable. The gate includes the production package contract build.

## #111 — transcript and notification implementation

| Acceptance | Planned implementation/evidence |
| --- | --- |
| Commentary without tool/thinking leakage | Persisted assistant text segmentation using Pi phase metadata; mixed-content/stop-reason fixtures |
| Silent commentary/local input and notifying finals/attention | Capability-gated transcript metadata and frozen relay delivery disposition; Matrix payload tests |
| Stable order, identities and retries | Existing projection ledger plus segment source keys and persisted offer metadata; lost-ack/chunk/generation tests |
| Catch-up silence and one actionable recovery alert | Durable recovery epoch and live attention revalidation; outage/stale-approval fixtures |
| NAS event contract, no notification controls | Narrow metadata consumed by #112; no client settings mutation in projector |

Scope: #111 owns projection and attention classification. #112 owns account push
rules, #108 owns approval execution, and #114 owns generation/branch controls.
Existing in-flight frozen payloads cannot be rewritten during migration. The
first implementation chunk isolates persisted-message classification; wiring and
outbox recovery are subsequent chunks of the same issue, not yet complete.
The segmentation chunk passes the full managed-session test suite. It uses the
pinned Pi text-signature v1 phase format (confirmed against provider source),
keeps unsplit-final source identity, and excludes tool results, thinking,
incomplete messages and unknown phases. Focused source LSP is clean; inspecting
the vendored Pi declaration exposed a cached missing pi-telemetry declaration,
while the repository TypeScript build passes.

The next chunk wires capability-negotiated commentary into the existing planner,
IPC and projection ledger. Legacy attachments receive unchanged responses;
unnegotiated commentary is rejected. Previously offered whole-entry finals keep
their original body/transactions rather than being split on upgrade. Commentary
uses silent notification metadata, deterministic chunks and exact lost-ack
retries. The tool-call hook reads persisted assistant state without blocking
local tool execution on Matrix. Managed-session and source checks pass; the
expanded adapter fixture additionally checks early commentary and no tool or
thinking leakage. Final/attention classification and outage recovery remain
unfinished within #111.

The following chunk freezes transcript disposition in both Pi offer markers and
the relay projection record. New live finals notify on their first chunk only;
local text/commentary are silent. Reconnect/retry captures a durable current-
branch cutoff before offering previously unoffered historical finals silently.
Already offered bodies and dispositions never change. New checkpoints notify;
new housekeeping notices are silent and typed permanent-failure callers can
request one notification. Notice outbox retries retain their first disposition,
including legacy records without metadata. Focused managed tests cover actual
adapter reconnect classification, persisted watermarks, mixed-content order,
chunking, and acceptance-before-ack retries. The bounded actionable recovery
alert and approval integration remain to finish #111. The canonical verification
gate passed at c8f2a8d before the following recovery chunk.

### Recovery-attention chunk

Operator decision: wait for fresh adapter confirmation; never wake a dormant
conversation merely to check and never inspect its Pi transcript from the relay.
`recovery-attention-v1` supplies an exact-attachment, fresh request/response check.
The adapter waits for idle/backlog reconciliation and reads its own current
branch. A late checkpoint projection acknowledgement cannot reopen a checkpoint
superseded by local user input. The relay also checks the active Pi session,
current attachment, pending Matrix inbox, original projected checkpoint and any
subsequent accepted input. Unavailable/busy adapters leave the ticket pending.

| Crash/race boundary | Durable identity and recovery | Evidence |
| --- | --- | --- |
| Matrix outage before recovery | Persist epoch and exact conversation/session/room tickets; repeated failures reuse epoch | Recovery state tests |
| Adapter absent or replaced | No launch or session-file inspection; defer or reject stale evidence | Monitor fixture; real adapter attestation fixture |
| Local reply before a late checkpoint ack | Original offer position, not projection-marker position, defines unanswered state | Current-branch marker fixture |
| Revalidation before alert acceptance | Recheck exact attachment/session/inbox within serialized selection | Stale-attachment and guarded-liveness fixtures |
| Selection before external send | Persist chosen attention, body and stable source ID | Competing selection and original-checkpoint coalescing fixtures |
| Matrix acceptance before ack | Preserve exact body, mentions and transaction through restart | Real projector lost-ack fixture |
| Later outage with an uncertain send | Preserve old accepted send and coalesce identical pending attention | Repeated-epoch fixture |
| One room cannot send | Independent bounded room workers; same-room sends retain order | Failed-room/healthy-room fixture |

Focused managed-session/source checks pass for the initial recovery chunk.
Approval runtime does not exist yet: #108 must supply live, unexpired requester
validation and connect it to the recovery selection before #111's approval
acceptance can be claimed. The guarded selection primitive is not proof of that
integration. #111 remains open; phone delivery remains deployment-only.

## #106 — hierarchy provisioning (in progress)

| Acceptance | Implementation and evidence |
| --- | --- |
| Project identity shared, distinct checkout Spaces | Host/project/canonical checkout-derived IDs; HostLifecycle uses workspace root rather than cwd; root/linked and concurrent-conversation fixtures in `managed-session-live-hierarchy.test.ts` |
| Stable aliases, uncertain creates, no foreign adoption | Durable phase records and exact bot-authored provenance; remote create/link and local-write interruption fixtures; real Matrix-client lost-response fixtures in `managed-session-provenance.test.ts` and `managed-session-coordinator.test.ts` |
| Pre-join provenance | Atomic initial ownership state and verified full room state; NAS consumption remains #112 |
| Local identity while remote pending | Durable local reservations precede Matrix effects; `pending`/`hierarchy_ready` are distinct from account readiness; real relay IPC-outage fixture in `managed-session-startup-ipc.test.ts`; frontend enrollment/window-first dispatch remain #107/#110/#116 |
| Safe titles, names not identity | Sanitized bounded titles with immutable-ID fallback; duplicate labels accepted; canonical checkout derivation excludes relative cwd; retries retain frozen initial display values |
| Legacy compatibility | Old manifests and interrupted creation intents retain their old route; existing coordinator startup performs no Matrix identity/link repair; optional paired checkout fields survive V1-to-V2 conversion; legacy reconciliation excludes new checkout-backed bindings |

Crash boundaries: persist intent before room creation; resolve uncertain creates
by host-scoped alias and exact provenance; save verified room IDs before linking;
retry identical state links after lost acknowledgement; publish `hierarchy_ready`
only after every required link/proof succeeds (never infer account/phone readiness). Root/project/checkout creation must
serialize shared identities, without holding an unrelated room behind network
failure. Account joining/notification setup (#112), existing-room migration
(#119), title reconciliation/ancestor cleanup and launcher dispatch are dependent
work, not evidence supplied by provisioning alone.

The first #106 chunk adds strict provenance syntax, canonical checkout IDs,
host-scoped aliases independent of names/parents, safe title fallbacks, and a
Matrix primitive that includes provenance in the atomic create. It verifies the
bot-authored create and management events, private/non-federated state, required
power and membership, and absence of encryption before accepting an alias.
Lost-response retries resolve the same proven room; same-bot foreign-host aliases,
forged/missing proof, contradictory parents, public and encrypted targets are
rejected without writes. Managed-session/source checks pass after adding the new
root module to the relay's explicit packaged source list. This is a tested
primitive; subsequent chunks below wire it into the lifecycle and local-pending store.

The operator approved one narrow legacy-host exception: add missing ownership
metadata on the verified existing host Space during new conversation provisioning.
The primitive checks the exact saved coordinator/host binding, private and
non-federated state, bot ownership/membership and management-event power. An
existing matching proof is read-only; conflicting proof is never replaced. A
one-attempt write followed by fresh verification avoids blind transport retries
after uncertainty. Fixtures cover acceptance-before-lost-ack and conflict after
that acknowledgement loss. This is not bootstrap-wide migration and does not
move or rename rooms, change IDs, invite users, or modify notification rules.
The lifecycle call site is now wired for new hierarchy provisioning. No existing
Space has actually been mutated by this implementation work; verification uses fixtures.

A separate durable hierarchy module now reserves local conversation/checkout
identities before remote effects and serializes shared ancestor creation. It
invokes the approved host-only additive marker primitive only while provisioning
a reserved, incomplete conversation. Loading and completed retries are read-only
with respect to Matrix. Root/linked checkout and concurrent-conversation fixtures
share the correct ancestors; saved Space IDs survive alias changes. The module
reports `hierarchy_ready`, not account/phone readiness. Managed-session/source
checks pass, including before/after create/link faults and lost-response recovery.
HostLifecycle now uses it for new project conversations and project creation.
Persisted older project-creation intents deliberately continue through the old
layout, rather than reinterpreting an interrupted operation.

After an uncertain create, an absent alias cannot distinguish no creation from
accepted creation followed by alias removal. Durable attempt markers hold this
case pending for explicit reconciliation rather than risk a duplicate. This also
covers a crash after the attempt marker but before the network request. Fixtures
preserve accepted rooms without replacements. Broad scans of joined-room metadata
are not implemented or implicitly authorized; explicit recovery planning belongs
to #119.

Fresh coordinator bootstrap now includes atomic ownership state for both its host
Space and coordinator room, with durable attempt/ID/link phases. Existing bootstrap
bindings are read-only with respect to Matrix, including inaccessible rooms/Spaces;
there is no implicit replacement, reparenting or membership repair. Lost create or
link responses and manifest persistence failures recover the same identities.
The local IPC server remains available while Matrix provisioning is pending;
malformed local state still fails closed. Hierarchy shutdown cancels and drains
its remote work before relay ownership is released. No account notification rules
are read or written by this provisioning code.

Affected managed-session and source-contract gates pass for the lifecycle wiring,
real-client bootstrap recovery, relay IPC availability, complete-server-name Space
links, paired checkout persistence/migration, and cancellation fixtures. The 28 before/after local hierarchy-write fault cases also pass, and the canonical
`nix run .#verify` passes on the lifecycle integration chunk. The committed-state audit at `0cc46c0` found:

- Standards: high — hash-domain mismatch; low — fallback title shape/collisions.
  Both are corrected with fixed checkout/alias vectors and serialized fallback
  allocation (`conversation-<short ID>`, extending on collision). Affected gates
  pass; no released/live identities were migrated.
- Spec: high — a reservation alone is not fresh local management: `self.bind`
  still waits for Matrix before producing an attachable local conversation.
  This remains current-issue remediation, not a deferral to frontend leaves.
  The duplicate low title finding is addressed by the same correction.

The local binding must survive and remain usable independently of remote effects,
without placeholder room IDs or terminating the foreground Pi during the outage.
A subsequent private-registry chunk adds roomless local enrollment with nonce-
authenticated, capability-gated attachments. Synchronized manifests still require
real Matrix IDs. A verified receipt is durable before manifest publication;
receipt, publication and private-cleanup interruptions recover without replacing
IDs or changing the attached local session. An unrelated public file cannot
complete enrollment without the matching receipt. V2 bundle migration preserves
pending records. Focused managed-session/source gates pass (one stale diagnostic-
text assertion was updated to assert the unchanged typed conflict code).
HostLifecycle now admits those local registrations before coordinator bootstrap
or Matrix availability. A bounded background reconciler finishes only the Matrix
binding, without reopening Pi transcripts or launching/promoting a process. Unit
fixtures preserve the active attachment through outage/retry and isolate a stalled
conversation from other completions; affected gates pass. The ordinary frontend
now opts in, keeps the same Pi running, gates Matrix-only effects, and records a
durable historical cutoff before enabling projection on binding completion.
Production IPC tests admit and reattach a fresh roomless source across relay
restart while authentication remains blocked, then complete exactly the five
host/coordinator/project/checkout/conversation resources without launching Pi.
A real packaged Pi remains responsive after enrollment against a fake relay;
adapter fixtures verify silent catch-up, notifying new finals, and refusal to
publish readiness after a failed durable cutoff write. These address the high
Spec finding without claiming live Matrix/account/device acceptance.

The new shutdown fixture also exposed an existing ownership-release race: socket
closure did not drain asynchronous detach writes. IPC now drains admitted work
and disconnect callbacks before releasing ownership, including delayed admission
and peer checks. A gated detach test verifies this boundary deterministically.
All 305 managed-session tests and source contracts pass. Two intermediate fixture
failures were corrected without weakening production validation: Pi signatures
require `v: 1` / `final_answer`, and workspace-identify rejects resolve-only fields.
The full `nix run .#verify` gate passed. An intentional two-axis committed-state
#106 audit at `acd188f` reported no Standards or Spec findings. The source LSP
checks are clean; cached vendor telemetry declarations and an upstream settings
schema URL still emit unrelated editor diagnostics. Account readiness, actual
phone delivery and the remaining epic frontends are not claimed here.

No push, deployment, live migration or phone-delivery claim is made.

## #107 — host controls (in progress)

The first chunk packages the complete action policy in
`config/agent/managed-host-policy.json`, adds immutable typed policy evaluation,
and generates deployment-time Nix overrides. Both Nix assertions and runtime
validation reject unknown actions, model mutation approval bypasses and invented
confirmation fields. Protected coordinator operations remain forbidden; valid
unclassified actions require approval, while invalid requests remain invalid.
Protocol confirmation fields cannot be removed by policy overrides.

All declared operations have policy fixtures. Mutation, override, immutability,
unknown-action and coordinator-protection cases pass, along with actual Nix
positive/negative override assertions and generated policy-file checks.
`managed-session-tests`, `module-contracts` and `source-contracts` pass; affected
LSP diagnostics are clean. This chunk has no external effects or runtime policy
editor. It does not yet activate a dispatcher, control socket or CLI; their
integration, durable execution dependencies and full issue verification remain
open. Policy configuration is a startup snapshot, not hot reload.

The next chunk adds the authenticated-front-end dispatcher seam, typed response
results, explicit unresolved legacy summaries and bounded disposable inventory
pages. Requests and results are validated; unknown diagnostics are redacted.
Coordinator protection and per-model mutation gating precede backend reads;
human mutation routes remain explicitly unavailable until their durable owners
are integrated, never forwarded to old bypassing implementations. The bounded
request replay guard rejects changed retained identities, joins in-flight work,
and replays detached validated results/errors for 60 seconds after completion.
It fails closed at capacity and is not a durable mutation execution journal.

Snapshot cursors are authenticated and bound to host, operation/filter and the
current metadata revision. Expiry, restart, eviction, revision changes and
forgery fail stale. Pages are count/byte bounded, with at most eight snapshots,
4,096 rows per snapshot, 8 MiB per snapshot and 16 MiB total. Tests cover these
boundaries, immutable responses, requester mismatch, invalid fields, model
approval, protected targets, staged mutation exclusion and malformed output.
Legacy rows never synthesize checkout IDs; logical placement rejects host paths.
These are deterministic component fixtures, not a live control-socket or CLI
claim. Registry read models and runtime integration remain open.

The next component chunk implements the separate private `control.sock` server
and client plus packaged `pi-managed-session` CLI. UID lookup failure rejects;
only local-human actors are admitted on this transport. Socket/directory modes,
strict UTF-8 single frames, byte bounds, version/correlation checks, malformed
responses, private-field rejection, startup cancellation and admitted-work/peer
check shutdown drains have deterministic tests. A real packaged OS peer helper
also authenticates a fixture connection. Reply sockets have bounded drain time.

The schema-derived CLI covers every declared operation, exact conversation-ID
positionals, comma-separated bulk IDs, strict flags, logical placement defaults,
retained request IDs and generated bounded help. Real packaged subprocess tests
verify one versioned JSON result and distinct read/unavailable/forbidden/upgrade
exits. Disabled/missing endpoints fail unavailable without reading registry or
Pi transcripts. Human diagnostics and invalid server output do not expose paths
or raw errors. Managed-session, module and source gates pass; affected LSP checks
are clean. These are local component fixtures, not production relay integration:
startup wiring, cheap registry metadata projection and compatibility wrapper
integration were the remaining work at that component boundary. No deployment
or live acceptance is claimed.

Production integration now starts controls before Matrix authentication/bootstrap,
only with an explicitly configured, bounded startup policy. Adapter/control path
collisions fail before ownership or filesystem effects. All shutdown paths drain
controls before releasing ownership; repeated relay stop calls share completion.
The registry projection copies only logical metadata and matching live-attachment
observations, not queues, nonce material, physical paths or generation histories.
Unattached rows remain unknown rather than asserting a stopped Pi.

| #107 acceptance | Implementation/evidence |
| --- | --- |
| Separate private authenticated transport | `HostControlServer`, real OS peer helper, malformed/oversized/version/actor tests, startup/close race and drain fixtures |
| Public CLI and bounded machine output | Every catalog operation parses; packaged subprocess read/error tests; client validates full frame/schema/correlation/privacy |
| Central immutable policy | Nix positive/negative override assertions, startup file validation, per-model mutation floor and protected coordinator fixtures |
| Cheap canonical/display/placement inventory | Dedicated registry projection; cached bounded workspace/worktree discovery; real Git fixture checks existing project-key domain and absence of per-row status; detached branch absence is explicit |
| Early/local availability without false Matrix readiness | Production relay plus packaged CLI lists an attached roomless Pi while fake Matrix authentication is blocked, survives restart, and does not launch Pi or modify its transcript |
| Disabled-host absence and compatibility | Nix disabled service/command assertions; production no-policy socket absence; configured CLI ignores stale runtime overrides; health wrapper preserves pre-control rollout behavior |
| Safe staged exposure | Full typed catalog; previews/mutations lacking durable owners return upgrade/approval errors, never call legacy coordinator-role mutation wrappers |

The full `nix run .#verify` gate passed after integration, including managed-session,
module/package/source/schema, TypeScript, unit, bridge/chat, Pi-R and evaluator
gates. No current source LSP errors. Approval execution (#108), retirement/frozen
previews (#109), window-first open (#110), frontend rewiring and durable picker
cache ownership remain dependent work. The metadata discovery cache is disposable
and cannot authorize operations. Account readiness and actual phone delivery
remain explicitly unclaimed.

The intentional pinned-HEAD audit at `f291986` reported one Standards medium
finding (read retry result stability) and one Spec high finding (confirmation
policy override floor). Both were addressed in one remediation batch: in-flight
read retries share execution, validated results and sanitized errors are detached
and replayed for 60 seconds after completion, and capacity fails closed rather
than evicting retained or in-flight identities. The cache remains process-local
and disposable, not a durable mutation journal. Nix and runtime policy loading now
reject changing confirmation-required human entries to `direct` or replacing
them with another approval classification; `deny` remains a valid restriction.
The request schema already required explicit confirmation independently; no
bypassing mutation execution was available during this staged rollout.
Regression fixtures cover concurrent/lost-reply retries, caller/backend mutation,
completion-based expiry, error replay/recovery with a new request ID, and Nix
negative delete/apply overrides. The canonical `nix run .#verify` gate passed
again after these remediations. No additional subjective re-review was needed:
the existing bounded replay/policy seams were corrected without a new design.

## #108 private approval record/store foundation (not activated)

`host-approval-record.ts` freezes a model mutation's request, independently
identified run/tool call, exact enumerated effects, private owner preconditions
and original 15-minute expiry. Private JSON structure/bytes are bounded. Strict
phase transitions cannot skip consent or replace presentation/decision receipts.
The initial completed-result schema was superseded by the operator amendment
below before any production activation.
Matrix/local receipt shape validation is **not** sender or live-run authorization.

`host-approval-store.ts` persists private per-approval records with atomic fsync
writes under the existing host ownership contract. Restart validates complete
primary state; partial temporary files are never promoted. Admission is bounded
by count and aggregate bytes and fails closed without evicting durable identities.
Writes serialize only persistence, not approval waits. Close drains admitted writes
and initialization; an uncertain write poisons further access until ownership-safe
recovery instead of proceeding from potentially stale memory.

Ten focused record/store fixtures and the TypeScript build pass: immutable input,
phase/receipt invariants, independent call identity, fixed hash vector, original
expiry, input bounds, restart, write/close ordering, corruption, privacy,
symlink and capacity rejection, and uncertain-write fail-closed behavior. The
initial record slice also passed the managed-session suite. This foundation is
not imported by production startup and does not enable model mutation execution.
At this foundation boundary, trusted origin/run tracking, concrete execution,
Matrix/native presentation, authenticated votes, public dispatcher fault fixtures
and #111 recovery integration remained #108 work.

The next foundation separates shared identity-schema leaves (preserving existing
exports) so adapter envelopes can later reference host action contracts without
an import cycle. A bounded run witness contains only generation/run/tool IDs and
local or accepted-delivery references: no sender, room or authority claims.
`resolveHostRunActor` resolves Matrix provenance from relay-owned accepted input,
rejects stale tools/generations, missing/cancelled/unpersisted input and mixed
local/Matrix origins, and keeps every resulting actor a model. Multiple Matrix
participants in the same conversation never inherit operator mutation authority.
Five focused origin fixtures and existing live-workspace contract fixtures pass.
The helper explicitly requires fresh nonce-authenticated attachment evidence from
its caller; the fresh IPC exchange and native run tracker are not implemented by
these pure fixtures and remain necessary before production exposure.

### Operator amendment: single attempts, not completed-action replay

On 2026-10-02 the operator explicitly chose to accept disconnection-timing
failures instead of durable completed-action receipts and automatic mutation
replay. #108 and the normative plan/contract now reflect that decision. The
previous retention question is resolved, not an outstanding blocker.

`HostApprovals` now provides the dispatcher with a pending-consent execution
seam. It coalesces an active call only, freezes effects, waits without a broad
lifecycle lock, checks operator voter identity, expiry, live requester and exact
preconditions, then consumes consent before one execution attempt. Completed
outcomes are not persisted. Consumed records recovered after interruption yield
an uncertainty report and are discarded, never an instruction to execute again.
Settled records release store capacity through durable removal. Existing read
response caching and owner-specific safety checks remain separate.

Public-dispatcher fixtures cover independent concurrent approvals, duplicate
active calls/votes, denial and new-call consent, expiry, cancellation, stale
preconditions, fresh requester checks, unauthorized Matrix voters, uncertain
execution-response loss without retry, consumed-consent recovery without
execution, and admitted self-stop/caller-loss completion. These use controlled
presenters/executors and the real private store; they do not yet prove native
Pi dialogs, Matrix poll integration or deployed approval execution.

A subsequent presentation/transport slice adds exact Approve/Deny polls using
the existing Matrix client, bot-owned question/option verification, current joined
operator or exact configured bridge voting, late-vote suppression and silent poll
closure. Private preconditions are never rendered; the entire 100-conversation
bulk-delete target set fits the poll question, and oversized unsupported displays
fail rather than silently truncate. Local presentation delegates to a nonce-bound
native-dialog callback; this is not yet the actual Pi UI integration.

Strict adapter messages carry run/tool/generation references and typed actions,
not model-supplied sender or room authority. The `approval-v1` capability is withheld
unless explicitly enabled by the host; production does not enable it yet. A host
request may await approval without blocking the same socket's fresh-run proof,
vote or run-end messages. Such work is bounded per attachment and drained on close.
Unknown peer UID now fails closed. Adapter disconnect returns an uncertain,
non-retryable outcome and reconnect never resends the host mutation. Focused
protocol/real-socket fixtures prove the fresh-proof exchange remains responsive
while a host call is pending and its disconnected requester does not replay it.
The bounded fresh-proof helper additionally rejects unsolicited challenges, stale
replies, replacement attachments and wrong generations; legacy/absent peers,
timeout and shutdown supply no proof. Its seven focused proof/origin tests pass.
The helper alone is not production-wired evidence.

Native Pi tracking now captures ephemeral low-level run IDs, hashed active tool
IDs and persisted user-entry provenance. Mixed/local/Matrix sources do not inherit
operator authority; run/tool end aborts pending dialogs. Native dialogs serialize
only presentation, never fresh-proof intake, and headless UI returns unavailable
rather than inventing a denial or consent. The adapter requests `approval-v1`, but
the relay still withholds it until the runtime owners are assembled. Upgrade the
relay before launching this adapter against a pre-capability strict-schema relay.
A composed native/frontend/public-dispatcher fixture proves denial, fresh consent,
exact requester revalidation and run-end cancellation. A real packaged Pi session
against a fake relay proves actual native tool/run event ordering, local provenance,
headless unavailability, immediate loss of liveness on Pi's native abort signal
while the tool is still awaiting IPC, and absence of liveness after settlement. This is not live
Matrix delivery or interactive TUI acceptance. The initial real-Pi fixture omitted
its tool from the SDK allowlist; correcting that fixture made the focused check pass.

### #109 retirement authority and registry foundation

Private terminal records freeze exact generation/attachment/window and room cleanup
obligations before external effects. Cleanup progresses independently and compacts
only to a permanent host/conversation/creation-key/retirement-ID tombstone; there
is no removal or resurrection API. Completed effects cannot regress, retries cannot
replace frozen targets, coordinator retirement is rejected, and uncertain writes
make authority unavailable rather than accepting stale in-memory state. Reads are
private, no-follow, nonblocking, fatal-UTF-8 and bounded; interrupted temporary
files never substitute for primary authority. The store has a 100,000-entry safety
bound, 4,096 pending-cleanup limit and 128 MiB aggregate bound, and fails closed
at capacity rather than pruning terminal authority. Account effects freeze the
exact user ID; ancestor targets freeze complete expected ownership provenance.

The registry loads terminal authority before reconciling public manifests and
runtime state. It removes retired identities from ordinary discovery and rejects
stale nonce/attachment/creation/restore paths. Terminal persistence is separate
from the active runtime transaction: a failure of the latter cannot undo retirement
in memory or after restart. Exact required stop/account/bot obligations and source
resource identity are checked before committing. Pi transcript, project and Git
files are not deleted. Stale synchronized active manifest files are harmless to
registry admission while tombstones survive; deleting newer tombstones during
backup restoration remains prohibited.

Evidence: 23 focused store/registry/enrollment tests passed, including injected
runtime-write failure after terminal commit and restoration of a stale runtime
backup. Packaged managed-session and source-contract gates passed. This is **not**
the complete #109 cutover: ownership-checked cleanup execution, lifecycle/legacy
alias routing, departure handling and account integration remain. No existing
conversation has been retired or migrated by these tests.

A bounded cleanup scheduler now retries only unfinished exact effects, not model
calls or conversation creation. Up to four independent effects can progress, so a
stalled account request cannot hold up stop/bot cleanup for the same conversation.
Duplicate sweeps share in-flight work; shutdown aborts and drains admitted effects.
Ten focused cleanup/store/registry tests prove network failure retention, exact
unfinished-effect recovery and shutdown without erasing terminal authority. Concrete
ownership-checking effect executors and startup scheduling are still to be wired.

The operator authorized automatic ancestor cleanup after reconnection, limited to
originally captured IDs with fresh checks. The offline target planner now freezes
known checkout/project Space IDs, expected provenance and both account identities;
unresolved legacy ancestry is not guessed by alias or name. Record/registry
validation checks the original room/ancestor chain, project/checkout identity and
saved host parent. A read-only eligibility guard queries ownership, authority,
children, joined members and current references on every invocation. Host Space,
foreign children/members, changed accounts and pending/live references fail closed;
project cleanup cannot outrun its exact child Space's completed cleanup.
Four new fixtures plus ten retirement regressions prove frozen targets survive
outage/reload without expansion and eligibility is checked afresh. These checks
are not reusable approval or live cleanup evidence: the concrete effect owner must
hold its provisioning/cleanup lock across the check and next mutation. Runtime
cleanup assembly and live verification remain pending.

The live hierarchy now supplies the required per-project cleanup exclusion:
reservations and provisioning remain concurrent with each other, cleanup excludes
both within its project, and unrelated projects continue. Its reference query
includes unpublished reservations and accepts permanent retirement authority to
exclude terminal conversations. Shutdown aborts cleanup and drains queued scopes
without beginning their effects. Two new exclusion/shutdown fixtures and existing
hierarchy/enrollment/ancestor checks pass (23 focused tests). This supplies the
serialization boundary; it does not itself execute Space cleanup.

Ancestor cleanup now also has permanent resource-level negative authority in the
private hierarchy. Under the cleanup lock, a freshly verified unreferenced Space
is fenced before account effects. A fence prevents old binding reuse even if the
bot is later re-invited; shared ancestor retries match complete provenance and
both account identities. Completion cannot erase the fence. Only an explicit new
conversation reservation creates successor ancestor creation keys/aliases; load,
status and cleanup never do. Pending old cleanup does not block fresh identities,
and its frozen targets cannot follow those successors. The registry's permanent
conversation authority is injected into hierarchy admission and ordinary discovery.

| Boundary / acceptance | Evidence and recovery |
| --- | --- |
| Fence before account effects | Referenced and foreign targets reject; before/after write injection poisons admission until restart |
| Completion after exact effects | Before/after completion write injection recovers only the stored phase, without remote effects |
| New conversation/name reuse | Original aliases remain in the fixture; explicit new reservation creates distinct ancestor rooms and preserves host/checkout identity |
| Shared resource / retry identity | Frozen provenance and account IDs must match; changed account identity rejects |
| Offline/restart planning | Reload performs zero Matrix calls; successor provenance is frozen from private hierarchy, not rediscovered |

These are #109 ownership primitives, not deployed effects or completed runtime
assembly. Account execution remains #112's integration boundary.

`RetirementAncestorOwner` executes the ancestor obligation under the project
cleanup lock. It unlinks only the original retired child (allowing siblings to
make independent progress), then freshly verifies emptiness/references before
fencing and account effects. Ownership is rechecked after operator leave/forget
before bot departure. Shared ancestors converge through their permanent fence,
not per-model execution receipts. A lost bot-leave response is recovered through
read-only bot membership plus exact operator completion observations; missing
observations stay pending. Project cleanup removes only its original host link,
never the host Space or unrelated children. The bounded authenticated self-membership
query does not enroll discovered rooms into the client's mutation allowlist.
Four owner fixtures plus the self-membership fixture and existing guards/hierarchy
regressions pass (33 focused tests). These use fake account/Matrix effects; relay
scheduling/cutover and the #112 account transport are still to be connected.

The IPC server retains its authenticated attachment identity independently of
ordinary registry discovery so a terminal retirement can still address only its
original attachment/generation. Changed attachments/generations reject the push;
this socket observation is explicitly not a run/tool liveness proof. Disconnect
hooks now run even when permanent retirement makes the registry detach invalid,
so approval/proof owners can revoke their state. A real Unix-socket fixture covers
the post-retirement exact shutdown route and disconnect behavior; focused IPC,
host-wire and adapter-control regressions pass.

The operator authorized the launcher extension in nix-dotfiles. Work is isolated
at `/home/beau/documents/nix-dotfiles-managed-live-workspaces`, branch
`feat/managed-live-workspaces`, based on `c2a1ab8`; the original checkout's unrelated
edits remain untouched. Commit `1c9789a` adds exact create/inspect/terminate
operations to the existing launcher, not a second tmux controller. A launch birth
token prevents marker installation on a replaced target; server PID/start time
plus a private random server token, launch marker, original pane PID and IDs are
checked inside one server-side command queue before termination. Added panes,
respawn, legacy markers, changed session/launch/server identity and ambiguous
observations fail closed. Complete Go tests (including disposable real tmux
restart/ID reuse and last-window acknowledgement) and existing pre-commit hooks
pass. No nix-dotfiles Nix build/evaluation/activation or push occurred.

The harness has a matching strict private ownership schema and exact launcher
client with no fallback to legacy termination. Runtime persistence and frozen
retirement targets retain the complete proof, reject binding mismatch or proof
downgrade, and project-window parsing preserves the optional proof. Legacy state
remains readable without gaining new authority. Launch/retirement runtime cutover
still needs to select these new operations; these tests are not live deployment
or complete #109/#110 acceptance. Follow-up nix-dotfiles commits `879dec8` and
`ad2a05b` exercise the real exact-create dispatch with dummy Pi processes and add
read-only exact ownership checks plus linked-window refusal. The harness mirrors
`match`/`gone`/`changed` checks and bounds PIDs before accepting ownership. Complete
Go tests and five focused harness ownership tests pass; the packaged harness
managed-session/source gates passed for the ownership integration. The relay
package explicitly includes the new shared schema (an initial missing-copy
packaging failure was corrected). No live tmux sessions were used.
