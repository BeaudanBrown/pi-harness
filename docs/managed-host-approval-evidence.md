# Host approval integration (#108)

## Ownership

The current issue owns production composition of authenticated run proofs, pending
consent, native/Matrix presentation, cancellation, frozen-owner execution and
recovery without mutation replay. The existing policy remains deployment-only.
Unified tool/command ergonomics and remaining frontend aliases are #113; NAS
account execution is #112. No model mutation may reach a legacy bypass while an
owner or frontend remains unavailable. No rollout or live acceptance is authorized.

## Acceptance → evidence plan

| Acceptance | Intended proof |
| --- | --- |
| Freeze exact call and private owner preconditions before asking | Public dispatcher → owner → durable approval store; stale-target fixture |
| Derive native/Matrix origin from authenticated live attachment | Real IPC challenge, accepted-input lookup, mixed/forged-origin refusal |
| Native dialog or origin-room poll, operator-only consent | Native answer correlation and authenticated Matrix vote routing |
| Independent consent, expiry, deny, no broad lock during wait | Existing approval tests plus composed dispatcher lifecycle |
| Cancellation on tool/run end, disconnect and retirement | Production callbacks and cancellation fault injection |
| Restart and response-loss behavior | Unconsumed consent revalidated; consumed attempts discarded, never replayed |
| No automatic model mutation retry or completed receipts | Single executor attempt, ordinary denied/uncertain tool response |

## Crash boundaries

| Boundary | Authority / failure behavior |
| --- | --- |
| Before prompt | Persist immutable effects and original expiry; no executor side effect |
| Poll/dialog published before receipt write | Exact poll identity and saved request; no inferred approval |
| Vote before execution admission | Revalidate frozen owner state and fresh live tool; expiry/cancellation can revoke |
| Consent consumed before executor | Accepted record cannot authorize replay after restart |
| Effect completes before response | Unknown result is reported; operator inspects and makes a fresh explicit call |
| Pending run disappears | Cancel consent and close presentation; do not wake a dormant requester |

## Current integration evidence (not issue completion)

The production relay now composes the approval store, authenticated run frontend,
public dispatcher, native/Matrix presenters, cancellation and shutdown drain before
negotiating approval capability. Matrix intake forwards exact poll votes, and
retirement/disconnect revoke pending consent. Consumed startup records are never
executed again. Core open/resume/stop/delete owners freeze their current target or
retirement plan; unsupported owner translations still return upgrade-required
before asking rather than taking a legacy bypass.

The packaged managed-session gate passed after production composition. A real
Unix-IPC/peer-UID fixture proves native denial leaves the conversation intact and
a new independently approved self-delete commits terminal retirement. Composed
Matrix fixtures prove origin routing, operator-only/duplicate voting, private
precondition redaction, stale target rejection and cancellation. Existing expiry,
response-loss and restart/no-replay tests also passed.

Evidence: `.pi/tmp/workers/2026-10-02T06-53-34-125Z-approval-production-assembly-tests-2fe9e548fdc2/`.
Create/reconciliation/bundle owner translation and the final issue review/gate are
still pending; this is not a claim that #108 or the model-tool frontend is done.
