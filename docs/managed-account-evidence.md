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

## Host account transport foundation

Added a bounded host-private request/ack journal and the fixed bot-side to-device
HTTP method. Requests and transmission identities are durable before HTTP;
uncertain attempts retain their IDs across restart, accepted-send redelivery gets
a new ID, and completed cleanup is not periodically retransmitted. Ensures can be
polled for saved NAS progress without replaying completed NAS effects. Recipient
identity changes fail closed for explicit recovery. A slow send never holds the
journal's acknowledgement lane, and shutdown cancels/drains the bounded send.
The host stores no owner credential and reads no owner push rules.

Acknowledgements must come from the configured owner and match a saved host,
request ID and digest. Pending responses cannot regress terminal progress. Only
conversation departure records are exposed as candidates for irreversible host
retirement; coordinator membership is not retirement authority.

The departure binding now also accompanies NAS departure acknowledgements. A
completed coordinator restoration invalidates its old ensure response atomically;
the host can ignore a delayed notice for that restored departure without clearing
a different departure. This implements the approved departure-specific correction,
not a new model argument or a broader account capability. Mutable coordinator
membership still requires the owner's fresh scope checks when runtime wiring lands.

Focused host/NAS/protocol checks passed **29 tests**:
`.pi/tmp/workers/2026-10-05T00-24-10-485Z-host-account-transport-focused-56869adf62df/`.
Affected packaged checks passed **447 managed-session tests and 86 bridge-chat
tests, zero skips**, plus source contracts:
`.pi/tmp/workers/2026-10-05T00-25-12-123Z-host-account-transport-affected-05274a94102d/`.

The host client is not yet assembled into the production relay. Remaining work:
hierarchy/coordinator ensure producers, ack ingestion before host cursor advance,
readiness reporting, exact cleanup and approved membership-restore ports, then
full #112 review and final canonical verification. These are transport/fixture and
package results, not a claim of end-to-end host assembly or live acceptance.


## Approved progress revisions and host production assembly

The operator approved mandatory monotonic per-request acknowledgement revisions.
NAS counters survive acknowledgement invalidation; identical redelivery retains
its revision. Host journals preserve the high-water mark across restoration and
restart, ignore older progress, and reject conflicting same-revision content.
Unversioned saved acknowledgements fail closed for explicit recovery.

The production host now composes hierarchy/coordinator producers, account intake
before both initial and incremental cursor advancement, per-conversation setup
status, exact retirement/Space cleanup ports and independently approved coordinator
membership restoration. Restoration freezes a fresh authenticated self-departure,
rechecks it before the one caller-owned bot invitation, and sends the departure-bound
NAS request. The background worker never retries that model-owned invitation.
Only exact active conversation departure notices enter canonical host retirement.

A private baseline preserves existing rooms/reservations across restarts. New-room
suppression uses an underride (superseding the experimental override described in
the earlier foundation section), allowing manual room/override preferences to win.
Experimental override journals require explicit recovery rather than automatic
personal-account edits. Trusted invitations followed by a self-leave *before*
host attestation now retain a negative observation; later attestation cannot revive
them. Unrelated rooms do not enter this journal.

Retired host ensures are cancelled. Their saved attestation may be redelivered
only after a matching NAS pending/unverified retirement acknowledgement proves
negative intake is durable; this cannot authorize joining a retired room. Unknown
or unverifiable ownership remains pending, not adopted or guessed. Account worker
HTTP and new setup failures do not occupy local IPC or running Pi work.

| New boundary | Recovery / evidence |
|---|---|
| baseline before producers | atomic private snapshot; restart never reclassifies old reservations |
| progress before ack transmission | counter/ack/outbox transaction; restart and reorder regression |
| restored ensure high-water mark | superseded marker retains revision; delayed negatives ignored |
| trusted invite before attestation | self-leave survives restart and suppresses later join |
| host intake before cursor | initial and incremental router barrier tests |
| approved restore before invite | exact fresh self-departure rechecked; lost invitation reply stays uncertain |
| retired positive ensure | cancelled durably; supplemental proof requires negative NAS receipt |
| host/NAS cleanup exchange | real JSON/SQLite journals with deterministic Matrix ports; positive forget acknowledgement |

Focused account/runtime checks passed **48 tests, zero skips**:
`.pi/tmp/workers/2026-10-05T02-57-44-206Z-account-runtime-final-focused-3fe1217b385f/`.
This includes a production hierarchy/account-owner to NAS-consumer roundtrip over
real journals, preservation/new-room rules, departure-triggered retirement and
exact cleanup. Matrix effects in that roundtrip are deterministic port fixtures,
not a live homeserver, NAS login, phone or deployment test. Full affected checks,
issue-boundary review and canonical verification are still pending at this entry.

Affected packaged checks subsequently passed **453 managed-session tests and 87
bridge-chat tests, zero skips**, plus source contracts, including both host cursor
barrier tests:
`.pi/tmp/workers/2026-10-05T03-02-46-431Z-account-production-affected-385a4a029039/`.
The NAS builder SSH connection was unavailable; the authorized local Nix fallback
completed. No live services or credentials were exercised.
