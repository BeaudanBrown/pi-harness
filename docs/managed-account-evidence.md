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

Initial foundation commit implemented isolated account modules; transport wiring
and its subsequent evidence are recorded below:

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

## Approved protocol corrections

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

The operator explicitly approved both corrections. The contract and executable
restore schema now require the exact departure event. The NAS journal now keeps
uncertain transmission IDs stable, rotates IDs for intentional redelivery, and
binds restoration to a saved departure. Neither correction grants new model
arguments or arbitrary Matrix authority.

## NAS worker integration evidence

The bounded account worker is now wired into the existing owner transport, with
independent effect processing and atomic account intake before its shared cursor.
Empty `managedAccountHosts` leaves account effects disabled. Account-only
configuration changes are excluded from the assistant policy fingerprint. Pending
account work, departure suppression, exact cleanup and ack transmission remain
separate from assistant selection and uncertain-send state. Startup and failed sync
suspend account effects until successful intake; private journal capacity/integrity
failures are not permission to skip intake or overwrite state.

| Boundary | Implemented proof |
| --- | --- |
| Failed account batch | No partial action/room records; effects wait for healthy intake |
| Initial rule / join / readiness | Rule attempted before accepting invite; full hierarchy and membership rechecked |
| Uncertain notification initialization | Room becomes ready with bounded warning, no rewrite |
| Migration/preserve request | No notification rule writes |
| Ack HTTP response lost / NAS restart | Same frozen transmission ID and payload retained |
| Accepted ack needs intentional redelivery | New transmission ID, same account request identity and content |
| Older ack response after newer progress | Compare transaction ID before removal; newer outbox entry survives |
| Retirement arrives before ensure | Durable negative fence before effects; no join to acquire cleanup proof |
| Leave accepted, reply lost, NAS restart | Already-left observation skips repeated leave; exact forget completes |
| Voluntary departure / foreign kick / Space leave | Only authenticated self-leave suppresses; conversation retirement is terminal; no Space cascade |
| Coordinator restore / repeated departure / restart | Departure-specific IDs, atomic completion plus suppression clear, old request/event replay cannot undo new state |
| Owner HTTP boundary | Fixed endpoint/ack schema; forget errors remain pending rather than presumed success |
| Assistant isolation | Account config does not reset its fingerprint; unchanged default sync filter; existing package regressions pass |

Focused account/protocol verification passed after the round-robin scheduling test
was corrected to allow intervening independent work. Additional atomic-intake,
configuration and HTTP-port cases passed in the final affected packaged gate:
**86 bridge-chat tests and 443 managed-session tests, zero skips**, plus source
contracts and packaged builds. Artifact:
`.pi/tmp/workers/2026-10-04T23-56-29-704Z-account-worker-final-affected-3f893ba5e254/`.

This evidence combines deterministic worker/HTTP fixtures, real SQLite restart
boundaries and packaged regressions, not actual Matrix/NAS or phone acceptance.
Host request/ack production, account readiness reporting and cleanup/restore port
integration still remain, followed by full #112 review and canonical verification.
#112 is not complete. No services were activated, no personal-account traffic was
sent, and nothing was pushed or deployed.
