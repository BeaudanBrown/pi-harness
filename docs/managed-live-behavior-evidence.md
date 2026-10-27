# Isolated live behavior acceptance (#121)

Status: authorized step-1 live acceptance complete. Both source fixes and review
remediations passed the final canonical gate; desktop/deployment remain separate.

The operator authorized step 1: extend isolated acceptance to commentary/finals,
approvals, split/fork/tree, stop/resume and retirement. This does not authorize
publication, lock resolution, fleet activation, production migration or desktop/
Element X acceptance. #120 still blocks full #121 completion, not this separately
authorized isolated test slice.

Reuse the retained private smoke root and original host Space from
[room-v12 recovery](managed-room-v12-evidence.md). Verify exact dedicated account
identities, retained inventory and provenance before effects. Preserve the original
host/coordinator and sample conversation; destructive scenarios target newly
created test conversations only. Never reset journals, adopt production rooms,
use shared tmux or read SOPS credentials.

## Acceptance-to-evidence matrix

| Acceptance | Intended live evidence | Current result |
| --- | --- | --- |
| Commentary/final | Synthetic Matrix prompt reaches actual native Pi; completed commentary is silent, final has expected notification metadata; no tool/reasoning content or duplicate user echo | PASS, actual gpt-6.1-sol turns and Matrix events |
| Independent approvals | Real model host-tool request remains pending before test-owner consent; approval executes exact action once; denial/cancellation produces no mutation | PASS after adapter-origin fix, including actual 15-minute expiry |
| Split fork | Approved summary fork creates independent committed worktree/session/room, visible summary once, idle until subsequent input; original source unchanged | PASS, including dirty source exclusion |
| Native navigation | Bound native new/fork/saved-switch are vetoed with existing guidance; supported tree navigation preserves room/generation and emits a silent boundary without historical replay | PASS via native public APIs from test-only terminal command; not full keyboard UX |
| Stop/resume | Public control stops exact test window, retains room/session, then resumes same generation with a single writer | PASS, repeated open joined same launch |
| Retirement | Confirmed retirement persists tombstone; open/resume/creation identity cannot resurrect; history/workspace files preserved; coordinator protected | PASS for both new test conversations, including restart and original frozen cleanup recovery |
| Isolation and cleanup | Stop owned test processes; remove temporary credential copies; retain evidence/journals and surviving test rooms; record intentional retired identities | PASS; original five rooms remain, both test tombstones retained, credential audit clean |

Native `/fork` successor handoff is deliberately **not** implemented: #114 was
revised to guard it, keeping summary/worktree fork separate. This acceptance work
must not silently reintroduce the superseded feature. Refer to
[native navigation evidence](managed-native-navigation-evidence.md) and
[split-fork evidence](managed-split-fork-evidence.md).

## Crash / external-effect boundaries

| Boundary | Required behavior and evidence |
| --- | --- |
| Accepted Matrix input / model start | Persist stable event/delivery identity; no blind replay after timeout; inspect retained status before continuing |
| Model mutation / owner consent | Separate exact test-owner approval; no model self-approval or approval-store edits; freeze target and reject stale scope |
| Fork Git/session/room/summary effects | Durable creation key and committed base; preserve partial state and recover exact identity rather than create another target |
| Tree boundary / transcript send | Native navigation with durable projection fence; deduplicate marker and exclude historical replay |
| Stop / resume | Verify exact process exit before successor; preserve history and generation, never kill by title |
| Retirement / cleanup receipt | Tombstone wins before further effects; cleanup only frozen owned resources, never original host Space or unrelated siblings |
| Runner interruption | Bounded operations, safe failure report, owned-process cleanup; preserve journals and unknown outcomes for explicit recovery |

## Credential boundary

The existing dedicated credentials authenticate Matrix only. The previous smoke
intentionally had no model credentials or model worker. Actual model-driven
commentary and approval acceptance needs an explicitly selected model/login for
the isolated Pi processes. A deterministic fake provider would be useful offline
coverage but must not be substituted and reported as real-model acceptance.

The operator subsequently approved using the existing Pi login for bounded
synthetic prompts. The initial Spark selection was rejected by the provider. The runner now uses
the operator's configured openai-codex/gpt-6.1-sol model and
copies only that provider's login into the private test agent directory, requiring
at least 30 minutes of existing token validity for bounded runs (15 minutes,
or 20 minutes when exercising the actual 15-minute approval expiry). It
never copies user settings, other providers or custom endpoints. Temporary
credential material must never enter prompts/logs/Matrix and is removed in cleanup.
The test-only project extension further denies model tools except README reading
and the selected host-tool scenarios; it never bypasses production approval.

## Live findings and evidence

- First attempt: Spark was not supported for this login. Its native error turn
  completed; no model-generated answer was claimed. A new explicitly requested
  test turn followed normal Matrix `!model` selection to the configured model.
- Two early resume attempts were refused while the relay preserved old attachment
  authority during its normal 10-second reconnect grace. The fixture now waits
  for read-only reconciliation before requesting resume, without editing state.
- Basic live pass:
  `.pi/tmp/workers/2026-10-27T04-11-37-723Z-isolated-live-model-after-reconnect-grace-db6062a0663c/`.
- Real Matrix model mutation initially failed closed with `Host request has no
  unambiguous presentation origin`. A real packaged SDK regression reproduced
  empty Matrix sources at the first tool (local sources still passed), without
  tree navigation: `.pi/tmp/workers/2026-10-27T04-19-44-533Z-matrix-native-origin-regression-red-9e2e7dd365db/`.
  The SDK dispatches `message_end` before persisting the user entry. The adapter
  deferred correlation until settlement, too late for a model host-tool request.
  The fix reuses exact persisted-entry correlation at `tool_execution_start`,
  before run/tool attestation. Missing/ambiguous entries still grant no authority;
  no sender, origin or consent is accepted from model arguments.
- Focused green: real SDK local/Matrix cases both pass; 12 origin/liveness/dialog
  checks pass. One production-helper test skipped in that ad-hoc invocation; the
  full packaged suite must supply its required helpers before final acceptance.
  `.pi/tmp/workers/2026-10-27T04-21-19-709Z-matrix-native-origin-focused-green-4ee1ddf09b0f/`.
- Follow-on fixture errors were corrected without replaying actions: settled
  approval files are intentionally pruned (assert the persisted native typed
  response instead), and fork creation keys are namespaced internally (use the
  actual tool-result conversation ID). The child's immutable Matrix create-event
  timestamp was verified after the owner's approval event on the same server.
- Approved fork/lifecycle pass:
  `.pi/tmp/workers/2026-10-27T04-28-04-033Z-isolated-live-fork-result-stop-resume-cccb2821a464/`.
  Denial returned typed `denied` with no new conversation; approved fork created
  an independent committed-only checkout, visible summary and idle native Pi.
  Exact stop/resume kept room/generation/session; later input used inherited
  context. Abort returned typed `cancelled`; a late vote caused no mutation.
  Original sample/coordinator remained unchanged; ten rooms existed at that phase.

Each bounded phase stopped its owned processes and removed its model-login copy.
No automatic retry of failed model input or spent approval was used. Outcomes and
private state are retained for explicit continuation. Desktop/Element X push
and UI behavior are not inferred from event metadata or these API tests.

## Expiry and retirement completion

- `.pi/tmp/workers/2026-10-27T04-32-29-280Z-isolated-live-expiry-and-retirement-f2bf03e2a847/`:
  actual **900,000ms** approval lifetime elapsed; native tool returned `expired`;
  a late owner vote did not create anything. No clock, TTL or approval-store edits.
  Coordinator deletion returned `forbidden`. Both new test conversations were
  stopped/retired, open/resume/reused creation identity refused, histories and
  Git/files preserved. The phase nevertheless **FAILED** because project-Space
  cleanup stayed blocked (six rooms rather than the expected five).
- Second genuine source defect: `leaveRoom` removed an owned child ID from the
  Matrix client scope, so the next `removeSpaceChild` could not clear that child
  reference in its still-owned parent. A direct real-client red reproduces the
  leave-then-unlink pattern:
  `.pi/tmp/workers/2026-10-27T04-54-13-677Z-departed-child-unlink-red-a376d744abf3/`.
- Fix: retain successfully departed IDs only as reference scope for removing
  links from still-managed parents. Sending, leaving, adding links to departed
  rooms, unknown child IDs and departed parents remain rejected. Cache capacity
  is bounded at 16,384; saturation fails before any leave and never evicts scope.
  Frozen retirement records remain recovery authority on restart; this cache
  neither grants lifecycle consent nor changes the ancestor owner's fresh
  provenance/membership/emptiness/reference checks.
  Focused 25 checks passed:
  `.pi/tmp/workers/2026-10-27T04-55-38-890Z-departed-reference-green-and-candidate-7fc8967cf6c7/`.
- `.pi/tmp/workers/2026-10-27T04-57-00-737Z-isolated-live-frozen-retirement-recovery-cb0e5aa83a5e/`:
  **PASS**, same original tombstones/cleanup IDs, no repeated deletion, rejoin,
  new rooms, model calls or model credential copy. All frozen effects completed,
  including removing the project link after the bot left that project Space.
  Restarted open/resume remained refused. Exactly the original five rooms and
  original coordinator/sample conversations survived; both test Git worktrees,
  dirty source file and native histories remain.

Retired test identities:
- `conv_360072e89faef0b1202bdcc893d6ff7f` (behavior source)
- `conv_c8999e8e2af3fb540f65f3a5fb66bbbb` (summary fork)

No model or Matrix token material was found by a private literal-byte audit of
retained test files. Both temporary credential copies were absent. A leftover
private tmux socket was confirmed ECONNREFUSED and removed only after checking
current-user ownership and exact inode. Original credential files were not
modified or removed. No production rooms/accounts/services, shared tmux,
publication, fleet evaluation/activation or migration were touched.

## Verification and remaining ownership

The first full packaged affected run passed **573 managed / 87 bridge tests,
zero skips**, including the production-helper case skipped ad hoc:
`.pi/tmp/workers/2026-10-27T04-32-29-280Z-matrix-origin-full-affected-checks-dcc54808061a/`.
Both fixes plus cache-capacity regression then passed **575 managed / 87 bridge,
zero skips**, plus the real local/Matrix origin cases against Pi 0.85.0 (packaged
checks use 0.84.4):
`.pi/tmp/workers/2026-10-27T05-01-30-722Z-live-behavior-both-fixes-affected-4f5e9d1d2d4f/`.
Review remediation passed **29 focused / 576 managed / 87 bridge**, zero skips:
`.pi/tmp/workers/2026-10-27T05-14-59-303Z-retirement-reference-review-remediation-56e125a8a72d/`.

### Paired review disposition

`.pi/tmp/reviews/2026-10-27T05-03-41-362Z-worktree-0c9e8149428a-580c8f63fedb/`:
- **Standards: one high, one low, current issue.** Accepted both. The production
  factory previously restored all frozen cleanup IDs as ordinary Matrix scope.
  Durable completed bot/ancestor departures now seed a separate reference-only
  constructor input that overrides any overlapping mutation scope. A real
  persisted-registry restart test proves unlink remains possible while send,
  leave, relink and departed-parent mutation remain refused. Capacity is reserved
  before awaited leave I/O, including concurrent departures. Actual sanitized
  commands are listed below.
- **Spec: one medium, current issue.** Accepted: initial status prematurely said
  final review/gate results were recorded. Status now explicitly separates live
  success from pending final deterministic verification. Final results will be
  recorded after the gate, without treating affected tests as canonical.

The restart-scope change added a production constructor boundary, so a targeted
paired remediation review followed the affected checks:
`.pi/tmp/reviews/2026-10-27T05-17-58-893Z-worktree-06b1eeb35ffb-414fcda5312f/`.
- **Standards: no findings.**
- **Spec: one high, current issue; prior medium resolved.** Accepted the remaining
  crash gap: departure may succeed before its durable effect is marked done.
  Cleanup's existing authenticated `accountJoined` observation now revokes
  ordinary scope when departure is confirmed, retaining only the known unlink
  reference. Unknown discovered rooms never gain scope; revocation happens even
  if reference-cache capacity is exhausted. A successful-leave/no-done-write/
  persisted-restart regression covers this boundary. Restoring the pre-fix
  observation in an isolated compiled copy reproduced RED (a send reached the
  fake HTTP route instead of being rejected as not-owned):
  `.pi/tmp/workers/2026-10-27T05-21-33-872Z-unrecorded-departure-observation-red-aa3b650c4570/`.
  This is a narrow implementation of the requested negative-observation fix,
  not a new lifecycle authority or journal design.

The post-remediation live restart also passed against the original five rooms,
completed tombstones and preserved files, without model calls or model login:
`.pi/tmp/workers/2026-10-27T05-17-58-771Z-isolated-live-post-review-restart-d0603a77a6f8/`.
This restart did not re-exercise already-completed cleanup effects.

Current-issue ownership: the two live-discovered fixes and regression/evidence
work. Desktop/Element X push behavior and full keyboard UX remain the next
separately coordinated client step; no guaranteed delivery is claimed. Native
room-preserving fork/new handoff remains the operator's justified #114 deferral.
Publication and actual dotfiles lock/host integration remain #120. Its currently
staged source pin is still `4415c7c`, so it must be advanced before future
publication/lock work. Local runtime fixes are `6de524a` (persisted Matrix origin)
and `590af41` (departure/reference scope and recovery). Neither #120 nor #121 is
closed; no commits have been pushed.

### Actual verification commands

Historical live invocations below consumed specific preserved test-state
preconditions. **Do not replay them as a fresh-state recipe**; the two test
conversations are permanently retired. No secret values appeared in argv.

```sh
# Basic real-model commentary/final + native guard/tree PASS
python3 .pi/tmp/live-managed-behavior-current-model.py
# Independent approval/denial, committed-only summary fork, stop/resume/cancel PASS
python3 .pi/tmp/live-managed-behavior-fork-continue.py
# Real expiry + retirement assertions PASS; ancestor cleanup FAILED (six rooms)
python3 .pi/tmp/live-managed-behavior-expiry-retirement.py
# Same original frozen obligations recovered; complete five-room cleanup PASS
python3 .pi/tmp/live-managed-behavior-retirement-recovery.py
```

Deterministic checks (full packaged runs passed with zero skips as counted above):

```sh
build=$(nix build .#checks.x86_64-linux.typescript-build \
  --option builders '' --no-link --print-out-paths)
# Initially RED, then GREEN with the narrow reference fix
NODE_PATH="$PWD/.pi-types/node_modules" node --test \
  --test-name-pattern='departed owned rooms' \
  "$build/build/tests/managed-session-relay-matrix.test.js"
# Final focused restart/client/ancestor cases: 30 PASS
NODE_PATH="$PWD/.pi-types/node_modules" node --test \
  "$build/build/tests/managed-session-relay-matrix.test.js" \
  "$build/build/tests/managed-session-retirement-registry.test.js" \
  "$build/build/tests/managed-session-retirement-ancestor.test.js"
nix build .#checks.x86_64-linux.managed-session-tests \
  .#checks.x86_64-linux.bridge-chat --option builders '' --no-link -L
# Real SDK local and Matrix origin against installed 0.85.0: 2 PASS
PI_MANAGED_ADAPTER_TEST_PI=/nix/store/801k9nslcf586zkwyqbsz7nffvagpg1b-pi-0.85.0/bin/pi \
  NODE_PATH="$PWD/.pi-types/node_modules" node --test \
  --test-name-pattern='native events attest' \
  "$build/build/tests/managed-session-adapter.test.js"
git diff --check
```

### Final post-review outcome

`.pi/tmp/workers/2026-10-27T05-22-37-231Z-live-behavior-final-canonical-and-isolation-2a39b4a3f871/`:
**PASS** — 30 focused, all 12 canonical gates, **577 managed / 87 bridge /
13+17 package tests, zero skips**. Default/relay/account production packages
built; seven unchanged dotfiles source checks and 46 existing Go fixtures against
current TypeBox schemas passed. The final relay/account restart preserved exactly
the original five rooms, both permanent test tombstones, histories and worktrees;
no new cleanup, model calls or model credential copy. Owned processes stopped and
temporary owner credential removed. TypeScript diagnostics are clean; external
Go workspace “No active builds” warnings are unchanged.

Actual final commands, after the focused command above:

```sh
nix run .#verify --option builders '' -L
nix build .#default .#managed-session-relay .#bridge-chat \
  --option builders '' --no-link -L
python3 /home/beau/documents/nix-dotfiles-managed-live-workspaces/modules/cli/pi-harness/check-managed-integration.py \
  --harness-source "$PWD" -v
NODE_PATH="$PWD/.pi-types/node_modules" node tests/fixtures/managed-picker-schema-check.cjs \
  "$build" .pi/tmp/managed-staging-go-post-isolation.log
nix build .#managed-session-relay --option builders '' -o .pi/tmp/smoke-relay
python3 .pi/tmp/live-managed-behavior-final-restart.py
git diff --check
```
