# Native managed navigation evidence (#114)

Status: implementation in progress under revised operator scope. Keep the working
Matrix process-replacement reset; defer native new/fork handoff and add bound
navigation guards. No SDK patch is authorized or needed for this revised scope.
Safe tree projection remains in scope; no deployment/live acceptance.

## Superseding operator decision

The operator explicitly chose to avoid the added complexity after the SDK
persistence explanation. Retain existing `!new --confirm`, including its confirmation,
busy/input-cutoff and exact process-replacement protections. Do not implement the
proposed SDK hook or native prepare/commit handoff. Guard bound native new/fork with
useful alternatives; leave unbound behavior unchanged. Independent worktree/summary
fork #125 is unaffected. Revised acceptance is authoritative in GitHub #114 and the
plan/contract. The original matrices and SDK preflight below are retained as
historical rationale, not remaining obligations or a pending approval request.

Revised evidence required: bound new/fork/resume/import guards, unchanged unbound
navigation, existing Matrix reset regression checks, and durable silent tree
boundaries with no historical replay or weakened input/retirement isolation.

## Revised guard implementation and evidence

Bound native `/new` and `/fork` are now vetoed by the shared native before-hooks,
not merely command-name interception. Project reset guidance points to the existing
Matrix `!new --confirm`; coordinator guidance does not promise an unsupported reset.
Unbound new/fork and saved navigation remain unchanged. No SDK code or Matrix reset
implementation changed.

Real SDK guard tests passed for project/coordinator roles, checking no source file
or entries changed and no abort/detach occurred. The packaged RPC fixture now checks
new/fork/resume cancellation while preserving the original attachment across relay
reconnect, rather than expecting the superseded unbinding behavior.

Focused guard evidence:
`.pi/tmp/workers/2026-10-06T00-22-03-830Z-native-navigation-revised-guards-75cfc6788881/`.
Affected packaged gate: **503 managed tests, zero skips**, plus source contracts,
including existing confirmed Matrix reset/generation protection tests:
`.pi/tmp/workers/2026-10-06T00-28-35-251Z-revised-navigation-affected-corrected-8e0adb9ead5a/`.
The first affected run identified the now-obsolete RPC expectation; it was updated
to verify actual veto responses rather than weakening the test.

The guard slice alone is not completion of #114 or the epic. The tree implementation
below is under final affected-suite and review verification.

### Current tree acceptance/crash plan

| Boundary | Implementation/evidence target |
| --- | --- |
| Before native tree change | Idle/queue checks; persisted session-local intent; retain the live attachment, hold incoming text locally without acknowledging it |
| Native change completes | Append scoped branch projection boundary and retain binding; project one stable silent metadata marker before new activity |
| Revisit older branch | Fresh boundary excludes all inherited messages; no replay or timeline rewrite |
| Cancellation or crash | Abort is only a request: cancel after an SDK idle fence and unchanged persisted source, or after restart proves the source unchanged. Otherwise hold for recovery |
| Input/control race | Deferred input remains relay-owned until completion; reject conflicting context controls, preserve stop/retirement authority |
| Marker response lost | Existing durable transcript projection identity/transaction deduplicates retry; no new daemon or SDK API |

Tests must exercise real SDK tree navigation, branch-before-binding, revisit/restart,
held input and cancellation, legacy capability rejection, silent metadata, and
existing Matrix reset behavior. Native new/fork handoff remains out of scope.

### Implemented in-place tree boundary

This is **not a native successor handoff**: no generation, process, session file,
room or SDK implementation is replaced. `branch-v1` negotiates a private delivery
fence with the existing relay; session-local `managed-session.tree` metadata records
intent and the completed projection boundary. Binding is restored on branches before
the original binding entry only through this scoped journal. Native metadata is not
model context. Each revisit gets its own silent `m.notice`, empty mentions and stable
transaction identity; historical messages and delivery receipts stay excluded.

Outstanding input, controls, checkpoint/control polls, compaction, projection and
workflow activity prevent admission. Text/media arriving during the boundary waits;
completion wakes existing relay routing without acknowledging or replaying input.
Retirement still wins. Successful confirmed process-replacement reset clears obsolete
tree fencing when the fresh generation activates; unproven native navigation cannot
be reset mid-flight. No existing reset confirmation or exact-process authority is
removed.

Pi 0.85 marks even plain tree navigation as compacting before its before-hook, so
checking `ctx.isIdle()` there would veto every change. The packaged 0.84 SDK has a
different idle contract. Both support successful tree navigation unchanged. Only an
SDK that exposed its own busy tree fence can prove live cancellation; on older SDKs,
a vetoed/interrupted tree may hold input until restart. Restart cancels only with
an unchanged persisted source; ambiguous partial navigation stays held rather than
guessing. No private SDK fields or persistence hook are used.

Focused coverage includes genuine Pi 0.85 revisit/reopen with two unique notices and
no historical replay/model call; adapter gate/lost-ack/crash/legacy-idle tests; real
IPC durable fence, competing operation, queued input and relay restart; retirement;
and exact silent Matrix transaction replay. Focused remediation: **20 tests plus
one real-SDK lifecycle test, no skips**:
`.pi/tmp/workers/2026-10-06T02-00-47-762Z-tree-focused-compatibility-remediation-8fd57243ab89/`.
The earlier standalone IPC run had one unavailable packaged-lock-helper skip; that
is not canonical acceptance. Initial affected run found the SDK idle-contract
difference, the need for actual `m.notice` rendering (not merely silent `m.text`),
and a pre-existing fixed-delay reconnect test race. The latter now waits for the
real reconnect and durable projection receipt before closing the RPC process.
Further crash/routing checks keep tree delivery fencing distinct from generation
cutoff: photos are durably queued, not discarded, and status remains usable. The
attachment advertises a pending operation so missing native metadata fails closed.
Real IPC/HTTP-port routing, SDK reopen and journal tests passed in
`.pi/tmp/workers/2026-10-06T02-23-40-193Z-tree-routing-and-sdk-focused-197ad57563a6/`
(three unavailable packaged-launcher cases were skipped in that standalone run).

Corrected affected gate: **518 managed tests, zero skips**, and source contracts:
`.pi/tmp/workers/2026-10-06T02-24-12-035Z-tree-affected-corrected-dc84a21d86fe/`.
This includes packaged SDK compatibility, complete launcher/reset coverage and the
RPC reconnect condition instead of a fixed sleep. Final focused guard/revisit/reopen
checks also passed against both actual SDK 0.84.4 and 0.85.0, including explicit
legacy-relay tree rejection (four checks, no skips):
`.pi/tmp/workers/2026-10-06T02-28-43-582Z-tree-final-sdk-guards-92d5d2f70be0/`.
Final review and canonical
evidence remain pending; these are deterministic tests, not live Matrix/phone
acceptance.

### Pinned issue review and remediation

Paired exhaustive audit at `cf7e946`:
`.pi/tmp/reviews/2026-10-06T02-31-17-303Z-audit-cf7e946961a5-b92618380377/`.

- **Standards:** one medium, current-issue finding: relay admission also needed to
  reject offered/projecting transcript chunks and closing checkpoint polls.
  Accepted and fixed in the registry owner; no subjective-smell findings.
- **Spec:** no verified defects in revised scope. This is an individual #114 audit,
  not the still-required cumulative epic review or live acceptance.

Both regression cases failed with the expected missing rejection before the fix:
`.pi/tmp/workers/2026-10-06T02-37-46-955Z-tree-review-regressions-red-corrected-d1c0d9d7ad39/`.
(The first poll fixture omitted required hash/origin evidence; it was corrected
before accepting the red result.) After remediation, both and adjacent real
text/image/status routing passed, **3 tests, no skips**:
`.pi/tmp/workers/2026-10-06T02-38-35-799Z-tree-review-remediation-green-fce58467fd2b/`.
Admission becomes available once all chunks and poll closure complete, without
consuming input or changing attachment state. No additional subjective pass was
needed for this bounded correction; final canonical verification follows.

## Original ownership and implementation boundaries (superseded)

This issue owns room-preserving native `/new` and `/fork`, branch-only `/tree`,
saved-session-switch guards, and safe parity with Matrix `!new --confirm`.
Matrix split-fork into an independent worktree/room is completed separately in
#125. Enrollment/local-only launcher integration, migration, picker and deployment
remain their own children. No source/target process replacement is authorized by
native navigation; retain existing exact-window authority and coordinator safety.

## Acceptance-to-evidence matrix

| Acceptance | Intended implementation | Evidence |
| --- | --- | --- |
| Block saved-session switching while bound | Shared native `session_before_switch` veto for resume/import; no command-name-only filter | Real Pi runtime switch/import tests for project/coordinator; unbound behavior unchanged |
| New/fork retain room | Capability-gated authenticated handoff around Pi extension teardown/reload | Real Pi lifecycle and actual IPC transitions |
| Exact fork context, no stale active ownership | Freeze selected source branch, verify successor and fresh binding boundary | Copied receipt/approval rejection, multiple writer and stale generation tests |
| Tree remains supported with silent marker | Durable branch projection boundary, not timeline rewrite | Revisited branches, no historical echo, uncertain marker sends |
| Serialized transition/input/stop/retirement | Existing registry authority and operation-specific transition journal | Deterministic crash and concurrency fixtures |
| Safe Matrix reset parity | Preserve confirmation, queued-input cutoff and busy guards | Existing reset tests plus new native/Matrix comparison |

## Crash-boundary matrix

| Boundary | Durable authority / effect | Recovery / evidence requirement |
| --- | --- | --- |
| Native prepare before navigation | Exact source session/generation, selected branch, transition ID | Hold delivery; validate busy state; vetoed/uncertain transitions cannot silently release ownership |
| Native successor file created | Reserved source scope plus exact successor identity | Validate same authorized source directory, selected content and fresh boundary; no arbitrary adoption |
| Old extension shutdown / new extension start | Host transition survives in-memory adapter replacement | At most one accepted writer; raw secrets do not enter portable manifests |
| Activation commit / lost response | Appended generation and active pointer precede input | Retry the exact transition; stale source adapter cannot accept text |
| Tree navigation / marker send | Saved branch boundary and stable silent notice identity | No replay of history when revisiting or restarting |
| Concurrent stop/refresh/retirement | Existing conversation authority; tombstone precedence | Never resume cancelled input or revive retired identity |
| Unproven partial transition | Retained intent and diagnostic | Hold for explicit recovery rather than guess, replay or replace a process |

## Preflight observations

Pi 0.85.0 `AgentSessionRuntime` emits `session_before_switch` for direct saved
switches and JSONL imports before replacement/copy. Native new/fork tear down and
reload extensions; fork can write the child file before `session_shutdown`.
Therefore binding continuity cannot rely on an extension-local closure alone.
The current Matrix reset path replaces the project process; it must not be reused
unchanged for the approved in-process native handoff. Coordinator bootstrap and
active-session-file selection also need to follow the committed native generation.

## Saved-switch guard evidence

The adapter now vetoes native `session_before_switch` events with reason `resume`
while bound, including the runtime path used by `/resume`, `/sesh`, extension/API
switches and JSONL import. The warning directs the user to select another managed
conversation through the launcher. It does not intercept native new/fork/tree.

A genuine Pi `AgentSessionRuntime` test covers ordinary and coordinator roles:
nonexistent selected files are not opened, imported history is not copied, and the
source session is neither aborted, detached nor replaced. Unbound native switch/new
hooks remain uncancelled. Focused test passed, zero skips:
`.pi/tmp/workers/2026-10-05T12-59-12-334Z-native-saved-navigation-guard-3dd2dea2f7e5/`.
Affected packaged checks passed **472 managed tests, zero skips**, and source
contracts:
`.pi/tmp/workers/2026-10-05T13-01-36-796Z-native-navigation-guard-affected-9b3938450dfa/`.

## Additional SDK persistence preflight

After #115 completion, the native successor preflight found a boundary not solved
by the already approved IPC handoff alone. Pi 0.85.0 creates a fresh session manager
with deferred persistence. `appendCustomEntry` and `appendSessionInfo` do not create
the JSONL file until the first assistant response. `createBranchedSession` likewise
defers a fork containing no assistant messages, even when its source file exists.
The extension's documented `ReadonlySessionManager` exposes no explicit persistence
hook; native `/new` supplies no extension-controlled mutable setup callback.

A disposable, real SDK probe ran without model/network traffic:
`node .pi/tmp/native-persistence-preflight.mjs`.
`.pi/tmp/workers/2026-10-05T23-39-05-900Z-native-persistence-preflight-b6c6c9e754c0/`.
The intentionally red persistence assertion reproduced:

- Fresh native metadata file exists: **false**.
- Assistant-free fork file exists: **false**.
- Writing the file externally while the live manager still considers it unflushed
  causes **EEXIST** at the first subsequent fixture assistant append.

Thus blindly seeding a live native successor from the adapter/relay is not safe.
Waiting for a model response is also incompatible with durable ownership and input
receipts before model work. Fabricating an assistant message or mutating private
SDK fields is not an acceptable workaround. Existing launcher-created sessions do
not have this problem because their seed files exist before SessionManager opens
and owns them; this does not extend to native in-process replacement.

Recommended decision: authorize a small public metadata-persistence hook in the
Nix-distributed Pi SDK, used only by managed navigation, preserving ordinary native
behavior. Its implementation and real-SDK regression tests would precede the
handoff. This is additional SDK scope, not a request to reapprove the already
approved native protocol, and does not authorize deployment or external Nix builds.
No SDK patch or private-field workaround has been made pending that decision.

The handoff, successor validation, generation-aware session-file selection,
branch-boundary projection, recovery/concurrency tests, issue review and final
canonical gate remain pending. This guard is one acceptance slice, not completion
of #114. No push, activation/service restart or live traffic occurred.
