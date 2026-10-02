# Managed notification acceptance evidence (#111)

## Ownership and plan

Complete durable notification classification and recovery integration through
existing projection/approval owners. Do not add a notification manager, overwrite
user preferences, wake dormant sessions, or read saved transcripts. NAS push-rule
initialization is #112; phone delivery and rollout remain separately authorized
#121 acceptance. #108 remains open for its unfinished mutation-owner assembly.

| Acceptance | Existing foundation / remaining evidence |
| --- | --- |
| Completed commentary and persisted local text, no reasoning/tools/history | Adapter/transcript projection fixtures; confirm mixed-content and final dedup coverage |
| Finals/questions/blockers/approvals notify; routine output silent | Existing projection dispositions; complete approval publication classification |
| Stable payload/transaction/chunk/order across uncertainty | Existing durable projection fixtures; freeze approval disposition before publication |
| Silent catch-up and one fresh recovery alert | Existing recovery tickets/probes; integrate fresh live unexpired approvals without waking sessions |
| No runtime notification editor or preference overwrite | Contract/policy checks; account rule initialization remains #112 |

## Crash boundaries

| Boundary | Required behavior |
| --- | --- |
| Approval prepared before HTTP | Persist chosen disposition with immutable consent before publication |
| Poll accepted, reply lost | Never change that transaction's payload/disposition; no automatic mutation replay |
| Outage / replay | Preserve accepted payloads; newly classified catch-up is silent |
| Recovery probe / send | Fresh attachment/run and unresolved/unexpired attention; at most one durable alert per conversation/outage |
| Approval expires or requester disappears during recovery | Do not claim still-live attention or execute mutation |

## Implementation and affected evidence

Approval, checkpoint-option and model/thinking poll sends now use a disposition
persisted before publication. Startup/outage classification is silent; live
attention is notifying. Legacy intents without a disposition retain their exact
old payload shape, including on uncertain retry. Poll verification accepts the
strict new metadata without accepting arbitrary mentions or content.

Recovery still queries only a currently attached adapter after backlog drains.
When no checkpoint remains, an unexpired pending Matrix approval can supply a
fresh live-tool attestation. Approval resolution/cancellation, stale attachments
and elapsed attestation freshness revoke this evidence. A newly notifying poll
occupies the existing recovery slot; no second notification manager was added.

Existing commentary/transcript/final projection tests remain the evidence for
source ordering, chunking, mixed content, reasoning/tool filtering and final
coalescing. Packaged affected verification passed, including all managed-session
regressions and source contracts:
`.pi/tmp/workers/2026-10-02T08-09-31-257Z-notification-approval-recovery-affected-be9f9362274c/`.
Strengthened replay and recovery assertions then passed 43 focused tests, zero
skips: `.pi/tmp/workers/2026-10-02T08-13-07-740Z-notification-replay-focused-55f518b3b8a6/`.

Individual subjective review is omitted; the mandatory cumulative epic review
remains required. Canonical verification passed at `d5188b4`: all 12 groups,
including 437 managed-session tests with zero skips and production package checks.
Artifact: `.pi/tmp/workers/2026-10-02T08-15-09-705Z-notification-final-canonical-00e6814d098d/`.
These are deterministic fixtures and packaged tests, not phone push, live TUI or
deployed acceptance. No push, deployment, activation or live migration occurred.
