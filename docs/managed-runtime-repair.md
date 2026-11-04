# Runtime repair implementation (#148)

Status: runtime owner implemented and issue-level verification passed. Not an available live control. This is the
runtime part of [unified repair](managed-conversation-repair.md), not a new public
recovery-command family. #150 owns preview/apply and final release of work holds.

## Ownership and implementation seam

`RuntimeRepairOwner` inspects, admits and reconciles the same saved identity
for project and coordinator. It receives narrow read-only session/process adapters
and the serialized registry owner. It must not receive arbitrary commands,
caller-selected paths, raw credentials or untrusted process identifiers.

The registry owns the durable repair hold and receipt in the same atomic writer
as runtime observations. The hold is not terminal authority: independent archive
and retirement remain authoritative. The external owner must use a fresh exact
scope and the shared independent approval result before calling mutating methods.
No startup path executes a repair or repeats an uncertain launch.

A repair snapshot binds logical manifest/generation, saved-file identity,
launch/window/nonce observations and process evidence. Pending input is not
closure evidence. New accepted input can remain durable behind the hold, without
expanding any approved queue-resume/abandonment scope.

Admit while detached and with no producer or launcher in flight. Persist the
hold before clearing any runtime observation. Reinspect the saved session and
process evidence after admission, then atomically reconcile stale runtime facts
and invalidate the old attachment nonce. Preserve a monotonic launch high-water
mark even when the obsolete launch reservation is cleared. A cleared nonce is
only an attachment fence, never proof the old writer stopped.

Keep the hold until the later orchestration owner has resolved queue and account
choices. This slice must not implicitly open the conversation, invite anyone,
finish queued work or resume accepted prompts. Legacy compatibility paths may
share the same verified metadata-reconciliation primitive while retaining their
existing explicit closure consent and non-launching behavior; they must not
become a way to bypass an admitted repair hold.

The implemented receipt phases are `held`, `reconciled`, `released` and
`superseded`. Only the latest receipt can hold work. A newly approved plan can
explicitly supersede the frozen prior held operation in one atomic commit: no
unheld interval, no dropped audit, and no reuse of the consumed operation ID.
The array is bounded to 32 records; capacity never silently prunes authority.
Supersession is allowed from either `held` or `reconciled` (both still hold work).
A superseded reconciled receipt retains `reconciledAt`: this records an actual
completed runtime step, not a release. Superseded receipts must never have
`releasedAt`, and must have `supersededAt`.
`releaseEmptyRuntimeRepair` is an internal orchestration seam and refuses any
unfinished queue or lifecycle obligation. No public tool calls it in this slice.

`HostLifecycle` constructs the shared owner with trusted project/coordinator
session paths. Its launch promise now holds a producer lease from before the
first asynchronous resolution until observation settles. Registry launch,
nonce, attachment, refresh and window writers reject an admitted repair hold;
producer I/O is fenced through the existing queue-activity gate. New accepted
input remains durable behind the hold. Older legacy migration/recovery uses the
same metadata reset primitive and cannot clear an admitted hold.

Repair holds, audit and launch high-water belong to the registry backup boundary.
Restoring an older registry is not a supported way to undo repairs or resume work;
this does not claim a separate rollback-proof repair authority. Independent
archive/retirement fences remain effective even after such a restoration.

## Acceptance/evidence matrix

| Acceptance | Implementation | Evidence |
| --- | --- | --- |
| Legacy project/coordinator and reserved launches | shared runtime repair owner; trusted per-kind saved-session adapter | passed real-registry runtime-repair fixtures for both kinds and reservation recovery |
| Exact process exit preferred | birth-aware exact-window check before any legacy fallback | PID reuse, retained pane, changed proof, unreadable observer tests |
| Explicit legacy uncertainty | frozen boot/visibility digest and explicit closure/acceptance flags | missing consent/changed unreadable set/conflict rejection |
| No duplicate automatic launch | durable hold plus launch/attach/dispatch admission gates | concurrent launcher/admission, new input, restart and old nonce tests |
| Same identity/history | frozen manifest and saved-file stat/identity verification | passed byte-preservation, changed file and symlink rejection tests |
| Monotonic launch fencing | retained ordinal high-water independent of cleared reservation | launch-repair-launch and reload tests |
| Crash-safe commit | admission and reconciliation receipts in serialized writer; poison uncertain writes | fault injection before/after atomic file replacement |
| Terminal authority dominates | fresh archive/retirement checks at admission and commit | passed repair refusal after terminal admission and older registry restoration tests |
| Compatibility shares safety | legacy migration/recovery delegates to shared reconcile primitive | affected legacy and exact lifecycle suites |
| Production integration | lifecycle constructs owner with trusted project/coordinator adapters; no public apply yet | package builds; #150 later wires approved execution |

### Checks and review

TypeScript compilation and the initial 11 focused runtime tests passed. The
observer Python suite passed 15 tests. Affected exact-lifecycle, queue, registry,
archive and retirement checks passed except for two new-fixture metadata mistakes
(corrected and covered by the focused rerun); five local package-dependent tests
were skipped. The final affected rerun passed 111 tests with five local package-dependent
skips; all 15 Python observer tests passed. The final canonical
`nix run .#verify` passed all 12 gates: 763 managed, 135 unit and 87 bridge tests
passed with zero skips/failures in those suites. Actual
`nix build --no-link .#managed-session-relay .#bridge-chat` also passed. An
unavailable optional NAS builder produced a warning; local builds completed.
LSP has no errors/warnings (one existing async-conversion hint); whitespace checks
passed. JSON round-trip of frozen snapshots is covered so optional absent launch
fields cannot invalidate a serialized approval.

Final affected log:
`.pi/tmp/workers/2026-11-04T01-44-08-141Z-runtime-repair-remediation-affected-d2a5a37ba80c/command.log`.
Final canonical/package log:
`.pi/tmp/workers/2026-11-04T01-45-32-960Z-runtime-repair-final-gates-aaa07aea79b4/command.log`.
Only this evidence text changed after the final gate. No live repair or deployment
was performed. #149 account access, #150 public orchestration and #151 cumulative
epic acceptance remain outstanding.

Standards/Spec review used the pinned #148 diff. Spec had no findings. Standards'
low evidence-table finding is addressed by recording actual outcomes. Its medium
superseded-timestamp finding is not a product defect: the parser already forbids
`releasedAt` on a superseded receipt, and supersession from `reconciled` is
intentional because that phase still holds work. Retaining `reconciledAt`
preserves the completed-step audit. Added explicit positive and negative fixtures
and clarified the phase contract above rather than deleting valid audit evidence.

Review: `.pi/tmp/reviews/2026-11-04T01-40-16-331Z-worktree-3384283299ba-7c3b2b9afee8/`.
Initial focused: `.pi/tmp/workers/2026-11-04T01-39-01-505Z-runtime-repair-focused-final-44a5a7f953a6/command.log`.

## Crash matrix

| Stage | Before | Effect / durable commit | After interruption |
| --- | --- | --- | --- |
| Inspection | no intent | read session/process evidence | repeat reads; no consent or exit inference |
| Admission | freshly approved frozen scope | atomic hold and receipt | hold survives restart; no wake/attach/producer side effects |
| Evidence recheck | held original scope | read exact process and saved-session identity | changed observation requires fresh approval; hold remains |
| Reconciliation | held and revalidated | atomic stale-observation reset, nonce fence, launch high-water and receipt | reload to observe uncertain commit; never replay based on an exception |
| Release/open | reconciled but held | owned by #150 with explicit queue/account/open choices | no automatic release or launch in this slice |

## Audit notes

`HostLifecycle.launch` currently tracks in-flight launch promises separately from
`RelayRegistry` queue producers. The implemented launch lease fences that gap, including
coordinator launch and worktree serialization. Checking only `row.state` is
insufficient because workspace/session resolution awaits precede `beginLaunch`.

`manual-legacy-recovery` currently binds project session paths only. The new
observer uses a trusted coordinator session-file adapter; passing the project
conversation directory for the coordinator would miss a possible writer.

Existing `completeLegacyWindowMigration` clears the old nonce/window but deliberately
rejects launch reservations. Generalizing it without a durable hold, generation
recheck and ordinal high-water would create duplicate-launch/ABA hazards. Do not
merely broaden that predicate.
