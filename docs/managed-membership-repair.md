# Original-room membership repair (#149)

Status: internal host/account implementation and issue-level verification complete.
No new live repair control is advertised.

## Scope and policy

Every existing NAS `retired` flag is terminal, including departure-only flags.
Never clear or reinterpret it. Host archive/retirement also denies repair.
Consequently an existing inaccessible original room may be non-restorable.
No replacement rooms, unbans, notification changes or history rewriting are
permitted. Public orchestration belongs to #150; activation/live repairs and
cumulative acceptance belong to #151 and separate operator approvals.

The account protocol offers a read-only capability/terminal inspection and
an expiring, exact approved membership intent. Both project and coordinator
restoration use the same account execution path. A missing capability response
means support is unconfirmed/upgrade required, not permission to invite.
Only a live exact admission can protect a non-retired project from the matching
departure; a new departure or any independent terminal authority always wins.
An admitted request never clears an existing retired flag.

## Acceptance-to-evidence matrix

| Acceptance | Implementation | Focused evidence |
| --- | --- | --- |
| Original identity/provenance and account | trusted host manifest/hierarchy plus NAS pinned room proof | foreign identity, changed account and provenance fixtures |
| Terminal flags remain terminal | inspect response and execution-time checks, no migration of old flags | departure-only and explicit retirement, reload and races |
| No unsupported NAS effects | strict typed inspection and gated admission before invitation | old/no capability, offline account, terminal reply |
| Explicit bounded admission | exact membership/departure, request digest, expiry and durable ack | stale scope, expiry, replay, restart |
| Invite/join uncertainty | observe original room and stable request before retry | lost replies and duplicate attempts |
| Departure arbitration | matching live admission only; changed departure invalidates | same-batch intake and new departure during awaited I/O |
| Shared coordinator behavior | shared account restore execution, compatible old wire operation | existing coordinator regression suite |
| No incidental effects | no room creation or push-rule writer in repair | counters and history/identity comparisons |

## Crash boundaries

| Boundary | Durable state/effect | Recovery rule |
| --- | --- | --- |
| Inspection | typed request/ack, no room mutation | unknown support/terminal evidence blocks effects |
| Host admission | exact expiring account request | restart retains intent; old consent cannot expand scope |
| NAS admission | separate durable admission bit plus admitted acknowledgement; queued intent grants no protection | terminal/expiry/changed departure rechecked; expired suppressed project departure becomes terminal |
| Host invitation | original-room invite, response may be lost | fresh membership read; never blindly reinvite |
| Host join authorization | durable exact observed membership authorization after NAS admission | changed evidence fails; only a recorded own invitation permits leave-to-invite |
| Account join | original-room join, response may be lost | require actual full invite event to match host authorization; retain once-only attempt |
| Post-join confirmation | host freezes exact joined event after NAS own-attempt observation | NAS must reread matching event before completion; no unrelated joined-state shortcut |
| Completion | suppression clearance and completion ack atomically | never clear a newer departure or any retired flag |
| New retirement/departure | independent negative authority | invalidate repair; no restored logical identity |

## Implemented seams and limits

`MembershipRepairOwner` freezes trusted identity, current membership and the NAS
suppression observation. `HostAccountOwner` supplies project/coordinator adapters,
checks provenance and configured account identity, and serializes admission against
automatic departure retirement. The client binds a fresh host authority check to
transmission. This is an internal orchestration port for #150, not a public action.

Strict `room.membership.inspect` replies advertise `original-room-repair-v1` only
for the exact pinned room. Missing/stale replies block effects with an account
connectivity/upgrade obligation. `room.membership.restore` is bound to operation,
source digest, membership/departure and a maximum ten-minute deadline. A positive
NAS `admitted` acknowledgement precedes host invitations. A separate durable
NAS admission bit—not a queued intent—controls departure protection. Host protection
requires the received admitted acknowledgement. Expired/rejected project admissions
are rechecked and an unprotected saved departure becomes terminal. Existing NAS terminal
flags are never migrated or cleared. A matching authenticated live request may
protect only the exact departure of an already verified, non-retired identity.
`room.membership.authorize` subsequently binds the fresh exact membership event to
that restore request before NAS may join. Uncaused membership transitions invalidate
consent in every mode; only this operation's durable invitation receipt allows
leave-to-invite, and a recorded invite authorization allows the resulting join.
Frozen invite/join modes must match their exact event in both owners. NAS reads
the full current operator membership event, rather than accepting a stripped
invitation or `/joined_rooms` alone. It compares the authorized invite event
immediately before its once-only join. After its own join attempt, `join_observed`
requires a fresh host `room.membership.confirm` for the exact joined event; NAS
compares that event again before completion. Already-joined plans instead require
the original frozen join event. Missing event IDs, stale/history-limited state or
insufficient account read permission remain unverified external obligations—never
permission to weaken the comparison. Manual acceptance followed by a fresh joined
plan is possible only while the identity remains non-retired.

Host invitation and NAS join attempts are persisted before HTTP. An uncertain
attempt can complete from observed acceptance but is never blindly resent;
changed evidence/expiry requires fresh consent. New departures, explicit
retirement and operation cancellation defeat admission, including cancellation
received before the positive request. Terminal host identities enqueue a bounded
`room.membership.cancel` request. Normal account journals retain their existing
capacity bounds and fail closed when unavailable/full; no authority is pruned.

Terminal authority is checked before and after awaited I/O. Cancellation cannot
undo an HTTP request already issued: a racing in-flight effect remains uncertain,
never a restored logical identity, and existing retirement cleanup remains owed.
Transport partitions may delay cancellation delivery, but cannot extend the
original expiry. No code claims distributed atomicity with Matrix.

The old coordinator wire operation remains readable on NAS for compatibility,
and its account join/proof/completion path is shared with project repair. The old
host coordinator freeze/apply entry point now fails closed before any effect:
#150 must route that frontend through the unified admission-gated owner. Retaining
an ungated legacy invitation route would defeat the new safety boundary. Both production
recipes already copy the modified strict protocol and account sources; relay's
recursive source selection includes the new owner. Actual package builds are
required below, rather than adding redundant source-copy rules.

Initial focused checks passed 43 tests. Broader affected account/host/hierarchy/
retirement checks passed 82 tests, zero skips/failures, with TypeScript compilation.
Additional production-adapter tests cover both kinds and terminal changes during
proof I/O. The review-ready affected rerun passed 84 tests with zero skips/failures;
TypeScript, LSP (no errors/warnings) and whitespace checks passed. Subsequent
review disposition and final canonical/package results are recorded below.
Review-ready log: `.pi/tmp/workers/2026-11-04T02-17-21-067Z-membership-repair-review-ready-1b52c18e7a18/command.log`.

Affected log: `.pi/tmp/workers/2026-11-04T02-14-05-056Z-membership-repair-affected-0ed297642183/command.log`.

## Review remediation

First pinned Standards/Spec review:
`.pi/tmp/reviews/2026-11-04T02-17-56-560Z-worktree-f0112ee44158-60a4f5536e8d/`.
All three current-issue findings were accepted: medium legacy invitation bypass;
high queued-intent departure protection; high incomplete membership-transition
validation. The batch disables the legacy host effect route, introduces a real
NAS admission receipt plus expiry terminalization, and adds a separate exact host
join-authorization phase with transition/negative-authority regression tests.
The latter materially changes the protocol design, so a second pinned review is
required rather than treating the first review as sufficient for the new phase.
The remediation affected suite passed 87 tests, zero skips/failures, with TypeScript.
Log: `.pi/tmp/workers/2026-11-04T02-27-55-679Z-membership-repair-remediation-f7396ac14773/command.log`.

The second review identified a high current-issue gap in actual NAS event checking
(both axes): matching authorization fields alone did not compare the real invite
or already-joined event. Accepted. NAS now reads and compares full membership
state before join/completion; an own-join result needs exact host confirmation.
Actual changed invite/confirmation fixtures and the existing host handshake cover
this correction. Because post-join confirmation adds a protocol boundary, it also
requires a final pinned review rather than claiming the earlier review covers it.
Second review: `.pi/tmp/reviews/2026-11-04T02-29-30-945Z-worktree-7563aea48be9-faee3d4eb11c/`.

Final corrected affected run: 88 passed, zero skips/failures, with TypeScript.
Log: `.pi/tmp/workers/2026-11-04T02-38-44-034Z-membership-repair-exact-events-eef0b411a16c/command.log`.
Final pinned review: `.pi/tmp/reviews/2026-11-04T02-39-11-813Z-worktree-f958282833cd-454abdf6cd74/`.
Spec has no findings. Standards' only remaining medium note is to execute the
scheduled post-review canonical and production-build gates before completion;
that note is resolved by the final results below. No further executable remediation
was required.

## Final verification

- `nix run .#verify`: all 12 canonical gates passed. Managed: 771; unit: 135;
  bridge: 98. All passed with zero skips/failures in these suites.
- `nix build --no-link .#managed-session-relay .#bridge-chat`: actual production
  packages passed separately. The optional NAS builder was unreachable; local
  builds completed successfully. This is not host activation.
- TypeScript and 88 affected tests passed. LSP: no errors/warnings, one existing
  async-conversion hint. Git whitespace checks passed.
- Final gate log:
  `.pi/tmp/workers/2026-11-04T02-42-07-168Z-membership-repair-final-gates-c1d53c989cc6/command.log`.
- Only evidence prose changed after the final gate. Public orchestration and the
  legacy coordinator frontend replacement remain #150; cumulative review and
  live/release acceptance remain #151.

No deployment or live room changes have been performed. The actual NAS terminal
status of timeline/ihp-update remains unverified; this implementation does not
promise that either existing room is restorable.
