# NAS managed-account automation (#112)

## Scope and preflight

Extend the existing isolated bridge-chat owner-account transport, not the model
service and not a second account daemon. The trusted host mapping is deployment
configuration; actions are the existing narrow, authenticated to-device protocol.
Credentials remain in the transport. No deployment, activation, personal-room
messages or live notification experiments are authorized. Actual host configuration
handoff belongs to #120 and live client acceptance to #121.

| Acceptance | Planned implementation/evidence |
| --- | --- |
| Exact trusted host identity; reject name-based/foreign/encrypted invitations | Strict one-to-one configuration and envelope validation; exact hierarchy proof tests |
| Initialize new-room rules once; preserve existing/manual settings | Durable per-rule attempted marker before PUT; loss/restart/manual-change tests |
| Narrow leave/forget and durable acknowledgements | Separate account inbox/room progress; exact verified target and actor-already-left tests |
| Deliberate departure suppresses rejoin; coordinator restore is explicit | Durable negative authority before ensure replay; replay/order tests |
| Account effects do not block Pi or assistant work | Separate bounded account consumer, no model socket traffic; existing bridge/file suite |
| Safe cursor and retry boundaries | Persist account intake before shared sync cursor; duplicate request and ack-loss tests |

## Crash boundaries

| Boundary | Required behavior / evidence |
| --- | --- |
| To-device received before shared cursor | Persist exact validated action first; duplicate intake does not broaden identity |
| Rule intent before HTTP PUT | Commit attempted marker; restart never repeats a potentially applied write |
| Successful rule response before local confirmation | Read-only exact-rule reconciliation; absent or changed rule remains uncertain |
| Account suppression before leave | Restart retains suppression; ensure cannot resurrect the identity |
| Leave/forget accepted before response | Observe/retry exact actor/room only; no bot credential fallback |
| Ack accepted before local receipt | Resend identical progress/transaction; host must verify sender and payload identity |

## First implementation evidence

Implemented isolated account foundations (not yet wired into the transport loop):

- Bounded separate SQLite journal, owner-account pinning, strict one-to-one host
  bot/device configuration and authenticated action intake. Duplicate intake is
  idempotent; model/assistant question state is never accessed.
- Exact stripped invitation/host-attestation checks and full four-level provenance,
  private-room and parent-link verification before readiness. Foreign, ambiguous,
  missing and encrypted proof is refused.
- Durable per-rule notification initialization. Attempt is committed before HTTP;
  restart changes attempted to uncertain. Exact read-only reconciliation may
  confirm, but absent/changed rules never authorize another write. Existing and
  manually changed/removed rules remain untouched.
- The initial silent override uses literal `event_property_is` room/sender checks
  and the escaped notification metadata key. It only suppresses notifications;
  attention relies on native mention/default rules, never a notify override that
  defeats a manual room mute. Phone/desktop behavior still requires #121.
- The HTTP rule port rejects retrying clients and reuses the existing one-attempt
  owner transport. Packaging includes the existing shared provenance parser.

Six focused tests passed, including table-driven crash/response-loss scenarios:
`.pi/tmp/workers/2026-10-04T23-10-41-136Z-account-policy-foundations-focused-a4f98a440939/`.
Packaged bridge-chat regressions (existing assistant/file/credential behavior) and
source contracts passed:
`.pi/tmp/workers/2026-10-04T23-11-37-828Z-account-foundations-bridge-affected-e33492234838/`.
After removing an unused future acknowledgement column, the final focused six
passed again:
`.pi/tmp/workers/2026-10-04T23-13-35-820Z-account-foundations-final-focused-4b8a1823375c/`.
TypeScript/LSP has no errors. This is not production NAS integration, completion
of #112, canonical final verification, or live acceptance.

## Protocol clarification needed before transport integration

The frozen contract currently requires retransmissions to reuse a Matrix
transaction ID while also requiring recovery after lost/expired device queues.
Matrix treats the same endpoint/transaction ID as a retransmission and does not
enqueue another message. Transport retransmission after a previously accepted send
therefore needs a fresh transmission ID while retaining the exact account payload,
request ID and durable receiver deduplication. Ordinary uncertain HTTP retries can
still use the original transaction ID. The Matrix spec does not itself prescribe a
queue expiry period; the recovery requirement comes from this project's contract.
Source: https://spec.matrix.org/v1.13/client-server-api/#put_matrixclientv3sendtodeviceeventtypetxnid

Likewise, the current coordinator restore payload has only host/room/conversation
identities. Its derived request ID is identical after every departure. Replaying it
must not clear a *later* deliberate-departure suppression; retaining a completed
receipt forever instead prevents a genuinely new restore of that later departure.
The narrow proposed correction is to bind restoration to the exact departure
Matrix event ID, obtained by the host and frozen under approval, never supplied by
a model. A different departure then gets a different account request identity and
an old restore cannot clear its suppression.

These are proposed corrections, not silently amended contracts or deployed
behavior. Remaining work includes durable departure/cleanup/ack execution,
transport-loop wiring and host request/ack integration, followed by complete #112
acceptance evidence and final verification.
