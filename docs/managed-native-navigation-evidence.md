# Native managed navigation evidence (#114)

Status: implementation in progress. Scoped prepare/commit/recovery and durable
branch-boundary protocol approved by the operator; no deployment/live acceptance.
A newly reproduced SDK persistence limitation requires an additional SDK-scope
decision before completing native new/assistant-free fork adoption.

## Ownership and implementation boundaries

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
