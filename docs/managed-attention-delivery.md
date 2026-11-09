# Managed attention delivery and diagnostics (#159)

## Scope and invariants

Transport availability, outstanding attention and delivery are independent.
Reconnect never creates a new notification identity, resumes execution, or grants
approval. Original notifying publications own their notification slot. A silently
published question/approval may receive one recovery reminder per exact
conversation/session/attention identity. Matrix acknowledgement is not a read receipt.

The existing recovery store becomes the attention-delivery policy owner; the
monitor supplies fresh adapter/approval evidence and the existing projector owns
Matrix transactions. No second outbox, session manager or database is introduced.

## Acceptance / evidence matrix

| Criterion | Change | Evidence |
|---|---|---|
| No repeated reminders across outages | Durable attention identity/receipts | 100 outage cycles and restart tests |
| Original notifying publication occupies slot | Original publication receipts and projected disposition | Monitor/projector tests |
| Unknown send outcomes preserve identity | Persist attempted before send; retain frozen payload | Lost-ack/restart/obsolete-attention tests |
| Obsolete unattempted reminders suppressed | Fresh pre-send evidence; unknown evidence holds | Answer/expiry and disconnected tests |
| Safe upgrade | Read v1, preserve existing source IDs and uncertain sends | Migration tests; no downgrade after v2 write |
| Diagnose failures without secrets | Classified HTTP errors and phase-tagged sync observations | Timeout/network/HTTP/redaction tests |
| Read-only explanation | Optional host/conversation diagnostic fields | Contract/read-model tests |
| Production readiness | Review, deterministic gate, package builds | Pending final verification |

## Crash-boundary matrix

| Boundary | Durable state / effect | Recovery |
|---|---|---|
| Before attention selection write | No new intent | Fresh evidence may select |
| After selection, before send claim | Frozen unattempted intent | Revalidate; suppress obsolete, hold unknown |
| After attempted write, before/after network send | Potentially applied side effect | Retry same source/payload/Matrix transaction |
| After Matrix accepts, before receipt write | Attempted, outcome uncertain locally | Idempotent transaction retry, never new identity |
| After receipt write, later outage/restart | Delivered identity retained | Suppress duplicate |
| Original publication planned, before its send | Original projector owns delivery | Original projection retries; no competing reminder |
| Diagnostics persistence failure | No execution/delivery authority | Log diagnostics failure; never skip durable intake |

## Deployment

Do not restart services or clear pending questions/approvals as part of this
change. Upgrade relay before adapters; old adapter recovery messages remain valid.
Back up complete persistent state. The v2 attention store is not readable by older
relays: executable-only downgrade is unsupported. Existing uncertain v1 sends
retain their exact identity and may finish after upgrade, even if now obsolete.
Existing notifying checkpoint projections suppress new reminders without editing
session history. Receipt capacity exhaustion must fail closed rather than forget
deduplication history.

Underlying host/network failures and the separate recovery-probe request-ID limit
are outside this issue. No change to process ownership or automatic work replay.
