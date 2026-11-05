# Approved conversation repair (#150)

## Operator contract

`conversation.repair.preview` selects one exact conversation. Independently
approved `conversation.repair.apply` reconciles stale runtime observations when
needed and verifies/restores access to the original room. It never launches or
stops Pi, creates replacement rooms, changes notification preferences, replays
queued work or abandons it. **No hold/resume/abandon choice is required.**

Closure attestation and acceptance of disclosed unreadable-process uncertainty
remain separate explicit assertions when required by the frozen process evidence.
Known conflicts cannot be waived. An already attached session is preserved, not
replaced. Its previously accepted native work may continue and produce new output;
repair cannot undo prior effects or promise that ongoing execution has stopped.

NAS support and current original-room evidence must be confirmed before admission.
Every existing NAS retired flag is terminal, regardless of why it was created.
Bans, foreign authority, unavailable evidence and unconfirmed capability require
external intervention, never a replacement room. Even an already joined room uses
the account owner's durable authorization protocol before repair completes.

## Preservation, not a queue-management wizard

Admission durably holds future input/control delivery and records per-item holds
for unfinished host input/control/output entries. Existing pending output cannot
be retried while its preservation hold remains. New output from an already running producer, including fresh repair
status notices, may publish normally during account-only repair. Runtime repair
itself still uses #148's producer, attachment and launcher fences.

The atomic completion boundary preserves every entry still pending at cutover,
including arrivals during repair, while releasing the general repair admission.
Later fresh input/control/output is ordinary independently initiated work. This
is not a persistent pause of the entire conversation. Ordinary stop/reset paths
cannot silently cancel preserved inputs. No item becomes successfully completed
merely because repair finishes.

Only if the operator subsequently wants preserved work attempted again, use the
separate `conversation.queue.resume.preview/apply` flow. It freezes up to 32 exact
items and the source digest, requires independent consent, audits removal of those
holds, and may invoke ordinary wake/delivery. Prior effects may already have
occurred: resumption is permission for future attempts, not proof of execution or
delivery. Unselected held entries remain held. `ProjectionResumptionOwner` retries
separately authorized durable output using the frozen bytes, Matrix transaction
identity and notification semantics, including after a crash between permission
commit and the first attempt. It reads only resumption audit, never repair intent,
so repair alone cannot start this outbox. Missing legacy payload bytes are not
reconstructed: the preview discloses that the original adapter/producer must
reoffer them through its existing retry path. Existing project-only queue
cancellation remains a separate alternative; repair does not require either one.

## Owner and durability boundaries

`ConversationRepairOwner` composes the existing runtime and account owners.
`ManagedHostMutationOwner`, preview store and approval runtime remain the shared
consent boundary. No second approval store or recursive public-tool invocation is
introduced. Registry admission/cutover use the existing producer exclusion gate
and serialized writer. Uncertain writes poison mutation until reload.

Receipts retain bounded frozen plan JSON, digest, generation, deadline and phases
`held → account_pending → runtime_pending → complete`. A newly approved plan can
supersede an interrupted one without dropping preservation holds or audit. Old
host continuations cannot mutate runtime or invite after supersession checks.
Already issued account requests retain their original bounded authority and
uncertainty; supersession does not claim distributed cancellation of HTTP.
Archive/retirement authority wins at every local admission/read boundary and in
the existing account protocol. No queue or repair history is implicitly pruned.

The original invocation polls account progress at one-second intervals within
its original five-minute plan deadline, without blocking Matrix approval intake.
It does not reset or extend that deadline while waiting for queued replies. Restart
never recreates that invocation or replays approval. Incomplete receipts remain
held: obtain a fresh preview and fresh consent. NAS admission expiry rules from
#149 remain authoritative; an expired/unprotected departure can become terminal.
Inspection exposes the latest receipt phase and whether a live continuation exists,
not blanket readiness. An apply result of `pending` is not completion evidence.

## Frontends and compatibility

Tool/CLI/Matrix grammar, exact schemas, policy and approval disclosure share the
same operations. Capabilities are advertised only with their required owners
wired. On a fully wired host, live `conversation.recover` delegates to unified
repair; retired cleanup retains its separate negative-authority path. Standalone
migration and legacy coordinator membership restoration direct callers to repair.
Unwired legacy hosts do not advertise unified repair semantics.

Publication, downstream pinning, host activation and each live repair remain
separate approval boundaries. No production repair or release is implied here.
#151 owns cumulative compatibility, production-build and live acceptance evidence.

## Acceptance/evidence matrix

| Requirement | Boundary | Focused evidence |
| --- | --- | --- |
| No mandatory queue choices | strict repair actions and default preservation | action rejection of queue options; project/coordinator preservation |
| Process safety | #148 owner, frozen evidence, explicit assertions | closure/uncertainty consent; changed history; launch admission fences |
| Account authority | #149 owner, exact original room and NAS admission | unsupported/terminal/unknown evidence blocks before mutation; #149 protocol tests |
| No implicit replay or abandonment | durable per-item holds and cutover | reload, arrivals, fresh-input dispatch, stop/reset preservation, output retry tests |
| Independent queue authority | exact source/items and separate approval | stale resumption, audited permission change, unrelated pending input retained |
| Restart safety | receipt survives, continuation does not restart | interrupted receipt supersession; uncertain-write poison and reload |
| Consent is not bypassable | shared mutation owner | bounded preview/apply; model rejected by human execution route |
| No fabricated readiness | advisory inspect plus phase | completion is historical metadata/access result, not attachment/run proof |

## Crash and uncertainty matrix

| Point | Durable state / possible effect | Recovery |
| --- | --- | --- |
| Preview/approval wait | bounded snapshot; read-only account inspection request | changed identity/evidence or expiry requires new preview |
| Admission | receipt and holds in one commit | uncertain write poisons; reload retains committed admission |
| Account request/invite/join | #149 durable attempts, admission and actual event proof | observe, never blind repeat; unknown/terminal evidence blocks |
| Runtime reconciliation | #148 process evidence and receipt | held/reconciled history retained; newer plans fence older writers |
| Completion | per-item holds plus release in one commit | new arrivals cannot cross an uncommitted cutover |
| Separate resumption | exact hold removal plus audit in one commit | uncertain outcome requires inspection, not expanded retry |
| Resumed output | frozen payload/transaction plus durable resumption permission | restart retries only separately authorized durable output; holds/terminal authority defeat it |
| External archive/retirement | independent negative authority | older registry or repair intent cannot revive identity |

Repair holds and queue audits share the registry backup boundary. Restoring old
registry snapshots is not supported undo or replay authorization. Independent
archive/retirement fences remain authoritative across that rollback.

## Verification

Completed implementation verification on 2026-11-04:

- 24 focused orchestration regressions passed, including original project/coordinator
  preservation, separate coordinator resumption, output retry after restart and
  partial delivery, interrupted account-only reattachment, and atomic expiry.
- All 12 canonical gates passed; managed tests **795**, unit tests **135**, bridge
  tests **98**, with zero failures or skips in the Nix gates. Actual
  `managed-session-relay` and `bridge-chat` packages built successfully.
- Final command used the canonical entrypoints with the unavailable optional
  remote builder disabled for this invocation: `nix run --option builders ''
  .#verify && nix build --option builders '' --no-link .#managed-session-relay
  .#bridge-chat`. Evidence:
  `.pi/tmp/workers/2026-11-04T06-00-34-244Z-repair-capability-final-gates-4a38169d48a1/command.log`.
- Three pinned Standards/Spec review rounds. Added the durable output retry owner,
  corrected startup fallback dispatch gating, and made expiry rejection atomic.
  The coordinator-blocker finding was disproved with an actual preview/apply
  regression (resumption does not reuse cancellation blockers). Final Spec review
  found no verified gaps; Standards requested final gates, now satisfied. Final
  review: `.pi/tmp/reviews/2026-11-04T05-54-28-192Z-worktree-3eb18d9367cc-563ca7ceb588/`.
  Capability advertisement was subsequently narrowed to full owner/router/outbox
  wiring and explicitly tested before the final gates above.
- Earlier attempts exposed corrected terminal-test fixtures, one existing IPC
  timing failure, and a stalled eval-self-test. Focused reruns and the final full
  canonical gate passed; these attempts are not counted as passing evidence.

Only this evidence prose changed after the final gate. Publication, activation,
live repairs and #151 cumulative/live acceptance have not been performed.
