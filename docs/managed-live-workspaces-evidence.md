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
60-second request fingerprint guard rejects changed retained identities and
fails closed at capacity; it is not a durable mutation execution journal.

Snapshot cursors are authenticated and bound to host, operation/filter and the
current metadata revision. Expiry, restart, eviction, revision changes and
forgery fail stale. Pages are count/byte bounded, with at most eight snapshots,
4,096 rows per snapshot, 8 MiB per snapshot and 16 MiB total. Tests cover these
boundaries, immutable responses, requester mismatch, invalid fields, model
approval, protected targets, staged mutation exclusion and malformed output.
Legacy rows never synthesize checkout IDs; logical placement rejects host paths.
These are deterministic component fixtures, not a live control-socket or CLI
claim. Transport, registry read models and runtime integration remain open.
