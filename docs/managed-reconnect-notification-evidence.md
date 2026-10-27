# Bounded relay reconnect notifications (#120 / #121)

## Scope and acceptance

The production-state startup failure was repaired in `9c79abe`, pinned by dotfiles
`3a7831b`. This follow-up fixes a separate symptom: every adapter reconnect failure
emitted `Warning: connect ENOENT .../relay.sock` indefinitely while the relay was
absent. The existing exponential retry schedule capped at 30 seconds, but the
notifications had no bound.

| Acceptance | Evidence |
|---|---|
| One warning per outage per bound adapter, automatic retry unchanged | Real Unix missing-socket regression for ordinary and coordinator adapters |
| One recovery notice, no repeated healthy notices | Stop/listen/reconnect cycles on disposable FakeRelay |
| A later outage can warn again | Same adapter and socket, second outage/recovery cycle |
| Repeated same-session startup cannot reset warning suppression | Repeated session_start during outage |
| Old asynchronous attempts cannot notify/change a new session or shutdown | Binding epoch/identity guards and session-switch/shutdown regressions |
| Existing state/startup fix and managed features preserved | Affected managed suite and canonical verification before publication |

The regression ran before the implementation and failed for both roles:
three warnings after three real failed attempts, where one was expected.
Artifact: `.pi/tmp/workers/2026-10-27T23-24-34-423Z-reconnect-warning-red-regression-38ead4ffadbb/`.

## Concurrency and state boundary

Notification suppression is in-memory and scoped to a binding epoch plus exact
conversation/session identity. It is not durable authority and changes no journal,
queue, approval, runtime-update policy or retry timing. An unchanged failed
connection stays quiet; a genuinely new binding/outage gets its own warning.
A successful current attachment clears the outage and reports restoration once.
Late failures after shutdown/session change must not reset current UI/tool state,
schedule old-session retries or notify another session. Process restart may warn
once again; suppression is deliberately not persisted.

| Boundary | Pre-operation state / effect | Durable or idempotency boundary | Interruption / retry | Evidence |
|---|---|---|---|---|
| Failed connect | Current attempt fails; show first warning | In-memory binding epoch/conversation/session key; no durable write | Further failures stay quiet; process restart may warn again | Real missing-socket red/green tests, both roles |
| Disconnect/retry | Clear current transport and refresh status; schedule unchanged backoff | Current client and binding checks | Stale callbacks cannot schedule old-session retries | Socket pause/resume and switch tests |
| Successful reconnect | Current authenticated attachment; show restoration once | Clear matching outage key only after current-attachment checks | Later outage warns once again; no healthy-repeat notices | Two outage/recovery cycles and repeated startup |
| Shutdown/session switch | Epoch/binding changes while attach is pending | Current-attempt guard before notifications/status mutation | Late failed old attachment is silent and cannot update shared UI | UI-enabled delayed handshake and shutdown tests |

No production service changes, credential reads, host evaluation/builds, state
writes or migration are part of this fix. Already-loaded adapters require their
normal idle runtime refresh to acquire new code; changing the relay alone cannot
replace an extension in a running Pi process.

## Results

- Red: selected socket regressions failed for both roles (`3 !== 1` warnings).
- Green: compiled tests selected with `node --test --test-name-pattern='warns once per missing-socket outage|shutdown racing attachment|session switch'` passed 5/5, zero skips.
  Artifact: `.pi/tmp/workers/2026-10-27T23-26-17-188Z-reconnect-warning-green-regression-fceba1c244f8/`.
- Affected: `nix build .#checks.x86_64-linux.managed-session-tests --option builders '' --option max-jobs 1 --no-link -L` passed 625/625, zero skips, including packaged SDK integration.
  Artifact: `.pi/tmp/workers/2026-10-27T23-27-38-138Z-reconnect-warning-affected-suite-750edd410da4/`.
- Paired review requested explicit cross-session stale-notice/status assertions and
  completed evidence/crash tables. Those findings were accepted; the delayed
  handshake switch test now captures both session UIs and old-context status
  writes rather than merely checking socket ownership. No finding deferred.
- The first post-review canonical run exposed an invalid pre-existing switch
  fixture: enabling UI revealed a missing binding-boundary entry. Both affected
  fixtures now contain valid boundaries; no error assertions were suppressed.
  The five focused UI/socket tests passed again with zero skips:
  `.pi/tmp/workers/2026-10-27T23-34-51-232Z-reconnect-warning-ui-remediation-check-0a4414acb9b2/`.
- Final `nix run .#verify --option builders '' --option max-jobs 1 -L` passed all
  12 gates: 625 managed and 87 bridge tests, zero skips, plus all other suites.
  Standalone default/relay/bridge-chat packages built successfully. Artifact:
  `.pi/tmp/workers/2026-10-27T23-35-28-177Z-reconnect-warning-final-confirmation-3d04040222df/`.
- Review snapshot/reports:
  `.pi/tmp/reviews/2026-10-27T23-29-12-058Z-worktree-9d8088a04298-bb8ead6cade7/`.
  All findings addressed; no deferrals. Only evidence results were added after the
  final gate; executable source is unchanged. Exact publication/pin receipts are
  recorded in #120. Host rebuild and live health remain operator-owned.
