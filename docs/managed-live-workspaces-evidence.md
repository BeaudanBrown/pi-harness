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
