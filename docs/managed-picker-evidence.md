# Managed picker handoff evidence (#118 / #119)

## Authorization and ownership

Implementation belongs to nix-dotfiles, not this harness. Operator authorized
source changes, local commits and direct Go/disposable-tmux tests in
`/home/beau/documents/nix-dotfiles-managed-live-workspaces`. No external Nix
evaluation/build, push, activation, service/shared-tmux restart or live traffic.

Operator clarified #118: **managed selection fails closed during relay outages**;
ordinary sessions/raw paths remain available. This supersedes offline marked-window
switching: birth-bound tmux ownership cannot prove absence of retirement.

## #118 implementation

External commit `2286765` (baseline `1ea4bf7`): public bounded inventory and
single generation-fenced window-first open; exact captured name/PID focus; coordinator,
dormant, starting and failed-state rows; immutable conversation keys; canonical
checkout digest dedup; mixed ordinary sessions retained; autojump/name ordering.
No private-registry parsing, stop/delete/refresh hotkeys, launch replay or cancellation.
Ordinary rows explicitly target unmarked windows, so a mixed session's selected
managed window cannot bypass outage refusal. Raw paths are validated before shell
creation. Host lifecycle retains ownership of launch joining and error-window retry.

Acceptance/crash matrix and implementation notes live in the owning repository's
`.loom/workstreams/managed-picker/handoff.md`; durable behavior is documented in
`specs/tooling.md`.

Verification: **58 top-level Go tests passed, zero skips**, including seven new
picker tests (plus inventory subcases) and all existing ownership/kernel/PTY tests.
Focused and full logs:
- `.pi/tmp/workers/2026-10-07T23-52-10-738Z-picker-focused-contracts-401b51403991/`
- `.pi/tmp/workers/2026-10-07T23-55-33-349Z-picker-full-isolated-6c7c024bde4d/`

The integrated picker uses a fake public CLI and selection executable with real
private-socket tmux focus; no live relay is contacted. Backend single-launch,
startup/attachment and retained-window semantics remain covered by the harness's
existing #110 suite (last canonical gate at #117: all 12 checks passed). External
Go LSP lacks an active workspace; direct Go compilation/tests provide evidence.
`git diff --check` passes. No external Nix validation was run or implied.

Individual subjective review is omitted at this boundary; cumulative review is
still required. Real-fzf progressive discovery, cache/cancellation and latency
measurements remain #119, not evidence supplied by these fixture tests. Nothing
has been pushed or deployed; desktop/Element X acceptance remains separately gated.

## #119 implementation and verification evidence

External commits `146994a` and `a128141` extend `2286765`; the latter records
paired-review remediation. Source implementation, final affected checks and the
harness canonical gate pass. Completed external workstream notes were promoted to
`specs/tooling.md` and removed as required by the owning repository.

- Fzf starts first; one combined tmux inventory and one autojump read. Independent
  fd roots run concurrently, without per-repository Git; selected raw paths remain
  validated before ordinary shell creation.
- Disposable bounded XDG path cache, basic existence checks, every-invocation
  refresh, private atomic concurrent publication. Failed/cancelled scans do not
  publish partial snapshots. No conversation recency, secrets or transcripts.
- 50ms raw-row hold (headroom within the 100ms budget); live ordinary rows and UI
  never wait for managed inventory. Full late reload removes duplicate paths.
- Immutable selection keys are captured in fzf's event queue and restored on its
  result event with a revision receipt. Query survives reordering. A removed key
  disables Enter until explicit navigation/query change, not silent retargeting.
- Escape cancels/drains discovery/row assembly. Selected open has an independent
  context; accepted work is not cancelled or replayed.
- Native client of the **existing public host-control-v1** Unix protocol, with
  public-CLI-equivalent owner/mode checks, 64KiB UTF-8 LF/EOF framing and request-ID
  matching. No private-registry access or offline authority projection. Runtime
  path is `PI_MANAGED_SESSIONS_RUNTIME_DIR` or `$XDG_RUNTIME_DIR/pi-managed-sessions`;
  custom deployments must export the same endpoint to the picker. Missing runtime
  environment fails closed; there is **no CLI fallback** or transport retry.
- The public CLI's pending exit8 was identified during experiments. The final
  implementation uses the native public response directly, validating pending
  window-created admission before exact focus; it no longer interprets CLI exits.

Focused tests and final **65-test Go race suite pass, zero skips**. Final affected
artifact: `.pi/tmp/workers/2026-10-08T01-13-00-197Z-picker-final-remediation-race-conformance-bdeff51c59c5/`.
All **46 protocol fixtures** agree with the real production TypeBox parser (not
another handwritten schema fixture). The cross-parser check caught and corrected
Unicode-length semantics: the public parser counts code points, not bytes or UTF-16.
The real fixture uses an actual keybinding through `launcher-popup`, fzf0.70.0,
tmux3.6a, a controlling PTY, 80 checkout markers and a private in-memory server for
the public protocol. It checks late duplicate removal, retained/removed selection,
query preservation, cache additions/removals and early Escape while reads are delayed.
Early exit drained in **39.26ms** against a **1.5s** delayed host read.

Seven trials per scenario; numbers are median / maximum milliseconds (not promises):

| Scenario | Keypress → UI | First selectable row | First managed row | Full discovery |
| --- | --- | --- | --- | --- |
| Cold XDG path cache | 35.83 / 57.03 | 66.37 / 75.15 | 66.37 / 75.14 | 108.05 / 123.86 |
| Warm XDG path cache | 33.74 / 35.88 | 65.21 / 76.29 | 65.21 / 76.29 | 75.08 / 81.28 |
| Host error | 35.99 / 40.18 | 66.98 / 75.76 | intentionally absent | 77.21 / 80.94 |

OS page caches were not evicted. These are real terminal/Go/fd timings on isolated
fixtures, **not live-host or Matrix latency**. UI tails sometimes exceed the 50ms
target. Delayed-host fixtures released raw rows ~78–85ms after UI while managed
rows arrived ~0.42s later. The previous 0.343–0.399s candidate-only measurement is
not comparable to keypress→UI.

Experiments exposed and corrected fixture/client details: `display-popup` does
not expand client formats like `run-shell`; POST actions require `/`, not GET
query parameters; fzf index tracking is not stable identity tracking, and load
precedes completed query results. A **real packaged public CLI** baseline against
private IPC took ~0.5s to produce managed rows due to repeated Node/schema startup
(`.pi/tmp/workers/2026-10-08T00-29-05-616Z-picker-real-public-cli-latencies-209398148e3c/`).
This justified the native client of the same documented protocol, not private-state
shortcuts. Two repeated real-popup suites and race tests verify the result-event fix.

### Paired review disposition

Review artifact: `.pi/tmp/reviews/2026-10-08T00-51-27-788Z-worktree-188fab73f78c-471c9379569e/`.
Both reviewers inspected the immutable external `1ea4bf7..146994a` snapshot at
`/tmp/pi-picker-review-huDnoQ`, not just the harness documentation diff.

- **Standards medium/current:** uncorrelated CLI fallback. **Resolved** by removing
  that transport entirely; the remaining native path requires exact request-ID match.
- **Standards medium/current:** permissive public responses. **Resolved** with exact
  operation-specific decoding: required status/summary fields, known states/capabilities,
  tagged project/coordinator/reconciliation variants, nested placement/window rules,
  length bounds, null/missing/extra-field rejection and case-sensitive keys (Go's
  default decoder alone is case-insensitive). Updated fixtures exercise actual shapes.
- **Spec medium/current:** fallback cannot discover an endpoint without runtime
  environment. **Resolved** by removing both branch and claim; absent configuration
  refuses managed discovery without invoking another command.
- **Spec high/current as reported:** require `relayState === ready`. **Rejected with
  source evidence, not deferred:** `relay/host-read-model.ts:26` explicitly computes
  this field from **matrixReady()**, not local host-control availability. A reachable
  local owner still enforces retirement/generation without Matrix transport. Gating
  on Matrix readiness would incorrectly disable local window-first operation. The
  operator decision concerned inability to consult local retirement authority.
  `TestPickerDisconnectedMatrixRetainsLocalRetirementAuthority` records this
  distinction; unavailable/partial local IPC still discards managed inventory, and
  unavailable open never focuses cached markers. Unknown state values are rejected.

Focused remediation passed before the final 65-test affected/race suite. Endpoint
mode/symlink/deadline failures, malformed/foreign frames, native socket→exact tmux
roundtrip and query/identity/cancellation regressions all passed. LSP could not form
an active build for the external worktree; direct Go compilation/race tests provide
the compiler evidence. No reviewer finding is silently marked as accepted/deferred.

No external Nix evaluation/build or deployment/live acceptance was performed.
Compatible fzf Unix-listen/result/transform APIs and custom endpoint wiring are
explicit deployment prerequisites for #120.

### Final verification

`nix run .#verify --option builders '' -L` passed **all12 deterministic gates**:
managed566, bridge87, package13+17, zero skips. The durable TypeBox checker again
accepted all46 emitted conformance cases. Both worktrees passed `git diff --check`.
Final artifact: `.pi/tmp/workers/2026-10-08T01-18-04-708Z-picker-final-harness-canonical-003dfe5abd30/`.
Only this final evidence prose changed after the gate.

To reproduce the cross-parser check, capture verbose
`go test -count=1 -v -run TestPickerStrictPublicResponseSchemas ./...` output from
the owning Go directory, build the **harness** `.#checks.x86_64-linux.typescript-build`,
and run `NODE_PATH="$PWD/.pi-types/node_modules" node tests/fixtures/managed-picker-schema-check.cjs <build-path> <go-log>`
from the harness. This does not authorize external Nix evaluation or activation.

All work is locally committed only. #120 configuration/deployment and #121
cumulative/client acceptance remain open; this evidence is not their completion.
