# Matrix–Pi replacement: acceptance and release evidence

Authority: [epic #160](https://github.com/BeaudanBrown/pi-harness/issues/160),
[ADR 0003](architecture/decisions/0003-matrix-pi-bridge.md).
Baseline: harness `8a96e8c`; nix-dotfiles `09b2f884`, with unrelated staged and
unstaged changes preserved. This document records technical evidence, not a second
backlog. **Not rebuild-ready until the final gates and migration instructions below
are completed. No production migration/activation has been performed.**

## Acceptance-to-evidence matrix

Tests cross the approved public seams: native Pi SessionManager/packaged launcher,
local list/open/status, adapter socket, Matrix HTTP, typed workspace/archive actions
and offline migration. Test doubles substitute remote Matrix/model requests; real
Git/tmux/Pi test actual process, persistence and native-command semantics. Do not
mock internal methods or assert private database layouts as behavioral evidence.

| Issue / acceptance | Intended implementation | Focused evidence |
| --- | --- | --- |
| #161 terms/behavior/deletions | ADR 0003, amendment links, reusable scenario fixture | Documentation links, fixture validity; no shipped-behavior claim |
| #162 offline local launch, one writer | Native writer protection + local helper | Two actual processes, crash/reboot-equivalent release, native switch/fork, child inheritance |
| #163 durable text bridge | Small adapter, transactional store, Matrix transport | Duplicate intake, lost handoff/output ACK, persisted-only catch-up, isolated bad room |
| #164 native picker/Nix | Local list/open/status and downstream picker | Real disposable tmux focus/concurrency, offline picker, evaluated service lifetimes |
| #165 background organization | Idempotent room/Space setup, narrow invite acceptance | Lost create response, partial links, deliberate departure, NAS offline |
| #166 polls/media/controls | Native control adapter and interaction records | Joined votes/text race, duplicate/old polls, actual Pi expansion, original image bytes |
| #167 task workspaces | One approved Git/session/binding creation | Real Git, fixed base, retry after each effect, no child turn, collision preservation |
| #168 archive/restore | Stored dispatch policy + grouping | Busy final output, offline move, restore without old replay, original IDs preserved |
| #169 migration | Offline export/import/check | Original sessions/rooms and frozen output IDs, interrupted import, no live overlap |
| #170 removal | Delete old runtime/contracts/options/tests/docs | Package absence and net code/state/interface counts in both repos |
| #171 cumulative readiness | Full review and deterministic release checks | Both review axes, verify, production packages, downstream tests/evaluations |
| #172 deployment only | Approved maintenance/import/activation | Operator-approved actual Matrix/Pi/tmux/NAS canary, not attachment alone |

## Crash-boundary matrix

| Before / operation | Durable identity / side effect | Interruption policy and test |
| --- | --- | --- |
| Native file open/switch | Host-local kernel-held writer ownership | Only lock owner writes; dead process releases, unrelated child cannot retain; failed switch preserves usable old session |
| Background registration | Canonical file/header + native projection boundary | Offline Pi remains local; retry same binding, no old-history backfill |
| Matrix sync | Intake event IDs + next cursor in one transaction | Before commit replay safe; after commit no duplicate dispatch |
| Input handoff | Commit potentially-dispatched before socket send | Lost send/receipt is per-message interrupted; never blindly rerun; later fresh input works |
| Native output | Native persisted entry + frozen output/transaction IDs | In-memory event alone is not eligible; lost HTTP response reuses exact payload/ID |
| Poll start/answer/end | Stable publication identity and single resolved outcome | Duplicates/races cannot wake twice; archive suppresses future dispatch |
| Image download/transfer | Authenticated original bytes + digest/chunk index | No partial-image prompt; preserve text+image as one event; no arbitrary byte cap |
| Room create/link/invite | Durable setup key, stored room IDs/private aliases | Recover owned uncertain create; safe links retry independently; leave is not auto-rejoin authority |
| Task approval/create | Frozen source/base/key before branch/worktree/session | Retry own partial setup only; unrelated path unchanged; no automatic rollback or child execution |
| Archive/restore | Flag committed before dispatch + intended grouping | Active output can finish; offline links retry, pending old work never silently replayed |
| Offline migration | Frozen source/export + separate destination | Refuse live source, repeatable import, preserve history and uncertain identities |
| Activation/rollback | Approved scope + frozen versions/receipts | Never dual owners; after new execution no stale-queue restoration |

## Verification results

### #161 contract

Committed `b8b00e3`: ADR/amendment links, terminology and public-seam scenario
fixture. Nine scenarios and relative documentation links validated; JSON/Markdown
LSP clean. `tests/fixtures/matrix-bridge/workflows.json` specifies inputs/expected
behavior, not an invented execution simulator.

### #162 native writer and local helper

The pinned harness uses Pi **0.84.4** (the operator conversation's installed Pi
0.85.0 is not the package under test). A small N-API `flock` primitive works in
both its Bun executable and Node SDK. Native SessionManager acquires ownership
before reading/repairing/migrating a resume target, changes ownership on native
new/fork, and releases through disposal/exit. Same-process transient native
handoff references share one kernel lock; unrelated exec children cannot retain
it. Scratch files survive harmlessly; they contain no durable launch admission.

The Python `list/open/status` helper uses the same lock identity and a transient
per-file open lock. It runs without the relay or Matrix. A busy real owner is
reported even without a usable tmux focus hint; never kill/adopt it or start a
duplicate. tmux failures include stage/exit/local stderr; lost open replies can
retry without an unobserved-launch repair. These are not deployed picker changes.

Evidence:
- Four kernel-process tests: cross-process exclusion, SIGKILL release, transient
  same-process handoff, exec child close-on-exec, path aliases/stale files.
- Four packaged native/local tests: Bun/Node exclusion; new/resume/reload;
  fork/tree/dispose; missing/empty/malformed history preserved; concurrent
  disposable tmux open, lost-response reuse, server loss and reopen. **8 passed,
  zero skips**, no credentials/models/Matrix/shared live server.
- `nix build .#checks.x86_64-linux.unit-tests --no-link`: passed, including the
  broader ordinary suite and new tests. Initially caught FORCE_COLOR formatting
  of a test child's numeric PID; JSON encoding corrected the fixture.
- Patched pinned Pi package built successfully. The configured NAS builder was
  unavailable; Nix built locally. No NixOS output was built or activated.
- LSP and staged diff checks clean. Paired issue Standards/Spec review reported
  no findings (`2026-11-10T01-32-19-524Z-worktree-92806ab321ba-765d07295dc7`).

Canonical full-epic verification and builds remain #171. The deployed tmux crash
in #158 has not been diagnosed/fixed by these isolated tests. Old processes do
not honor the new native locks; quiescing them remains a cutover requirement.

### #163 isolated text bridge and delivery ledger

The replacement now has an asynchronous native adapter, private user-owned Unix
socket, one host-local SQLite ledger, and per-room Matrix delivery. There is no
new daemon activation or room provisioning in this slice: #164 wires packaging/
launchers, #165 supplies rooms and Spaces, and #166 adds polls/images and richer
controls. The existing managed runtime is still present until #170.

Important implementation boundaries:
- The daemon holds a kernel lock before opening/recovering its ledger or removing
  a stale socket. Socket and state directories are owner-only. The adapter imports
  neither Matrix HTTP nor process launching. Local launch receives only a saved
  binding through the #162 seam; production environment sanitization belongs to
  the #164 launcher wiring.
- First successful registration cuts at the **current persisted native tail**;
  an old/copied native marker is not permission to backfill. Reconnect retains the
  original database boundary. Native new/fork keeps native identity semantics.
- Pi's native custom-entry persistence now flushes buffered entries and fsyncs.
  This makes an idle session real without a model turn and persists local-only
  enrollment changes before private work. Headless workers do not enroll; resuming
  a previously bridged file headlessly disables its projection before new work.
- Raw event identity/cursor/checkpoints commit together. Queued input can recover;
  `handed` becomes per-message `interrupted` after lost attachment/restart and is
  never automatically resent. One immutable notice per interrupted event replaces
  recurring recovery-attention announcements. Fresh instructions remain usable.
- Normal busy input uses native steering; `!follow-up TEXT` uses the native
  follow-up queue. `!abort` withdraws older pending input and requests native abort;
  `!stop` additionally requests native shutdown. Neither claims tool effects were
  undone or work completed. Later fresh intent can reopen the original session,
  but cannot be handed to an attachment already stopping. Native preflight and
  observed idle are not external-effect receipts.
- Remote origin is native **message metadata**, not guessed from text. A copied
  or locally restored Matrix-captioned prompt is fresh local input and projects
  normally. Thinking, tool results, internal entries and pre-binding history do
  not project. The history reader only accepts complete persisted JSONL records,
  fsyncs the observed file before freezing output, caches unchanged observations,
  and checkpoints only after immutable output materialization.
- Output retries use the same persisted payload/transaction ID. A partial sync
  gap checkpoints each recovered page without advancing the global cursor;
  other rooms still intake independently. Invalid/missing history is an explicit
  error, not authority to create a replacement session.

Evidence so far:
- **10 focused bridge scenarios passed, zero skips**, including real packaged Pi
  and an ordinary TUI in a disposable tmux server: asynchronous/offline startup,
  persisted-only projection (`message_end` was observed before persistence),
  provenance, reconnect without replay, native new, worker exclusion, busy
  follow-up withdrawal, abort, stop, private-history boundaries, lost output ACK,
  duplicate/membership filtering, restart-safe sync gaps and daemon exclusion.
- Two additional packaged native cases prove idle custom-entry persistence and
  post-expansion attribution/preflight. The native writer/local helper regressions
  remain covered.
- Canonical affected checks: **155 unit tests and 856 managed-session regression
  tests passed, zero skips**, with the patched Pi package built. The real RPC probe
  exposed that its idle shutdown flag is observed at the next RPC checkpoint;
  the separate ordinary TUI test proves immediate native idle shutdown.
- Source TypeScript LSP and compiler checks passed. Isolated copied upstream
  declaration scratch files under `.pi/tmp/` lack their surrounding SDK and are
  not project compilation inputs.
- Paired pinned Standards/Spec issue review found no material findings
  (`2026-11-10T03-08-44-498Z-worktree-6219d38916af-ee4fa9c90f56`). The final
  cumulative review/gate remains #171; these fixtures are not live delivery
  receipts.

### #164 local picker, launchers and Nix wiring

Current boundary: native local integration, not a completed remote product or a
cutover. Rooms/Spaces remain #165, richer interactions #166, approved workspace/
archive actions #167/#168, migration #169, legacy deletion #170 and cumulative
release verification #171. No service was activated, no production process was
stopped, and no Matrix membership was changed. The unrelated downstream staged
patch remains byte-identical with an explicit eight-character diff abbreviation
(SHA-256 `2326317cd5691bd6b1a38eb9dc84588577e884a1425c7fec6c4bfcf08bc731be`).

Downstream implementation is committed locally as nix-dotfiles
`9f23c1bcfd607f21fc640dfa0b19d5435057893a` (parent `09b2f884`), followed by review
remediation `0e0bd07355d8064145e255aeb7fad095b8ce3b40`. No push occurred.
A temporary index excluded all pre-existing staged changes and the operator's
unstaged harness URL/lock edits. Only removal of the host's `nix-ai-tools` override
was committed in that shared flake file: substituting its newer Pi would bypass
the harness's tested **0.84.4** native patches. The final published input/lock
advance is still a release handoff, not implicit permission to publish or rebuild.

| Acceptance | Implementation and evidence |
| --- | --- |
| Native saved/live picker and shared remote wake | Version-1 `pi-session list/open/status`, selected file/ID fencing; daemon wake executes the same helper under an allowlisted environment. Actual Pi opens, same-writer reuse, outside-tmux reporting and requester-only focus tested. |
| No relay/platform admission | Five old picker host/schema/socket files deleted downstream. Real fzf fixtures use only the local CLI, with no bridge/host socket. Ordinary workspace rows remain available; native windows do not require Git. |
| Ordinary nonblocking startup | Native module wrapper bypasses managed launch/main.mjs; central engineering profile/default settings include the adapter. Text TUI is eligible, headless/workers/experiments are excluded, and explicit local-only remains available. |
| Tools, trust and PATH | Seventeen packaged engineering probes preserve tools/LSP, project executable precedence and lean experimental separation. Real direnv refusal/retry and allowed environment propagation tested; no trust bypass added. |
| Independent lifetimes and retention | One optional user daemon with LoadCredential, no EnvironmentFile/stop hooks/PartOf/BindsTo/Requires coupling; independent shared server retains stop/restart suppression. Three runtime-pin tests plus native module assertions cover closure retention; no idle replacement controller. |
| Optional archive presentation | Helper reads the real BridgeStore read-only, matches native identity, includes historical bound files and falls back on missing/corrupt/non-regular state. Archive cannot deny a direct native open. Picker reads no database. |

Focused crash/race evidence:
- Lost local-open reply/concurrent opens reuse the actual writer. Kernel locks
  remain the only writer authority; pane options never authorize killing.
- A slow bootstrap has a live PID/server/birth-fenced hint with a bounded lifetime.
  Replaced/dead/expired hints cannot reserve a file. A discovered regression after
  native `/new` was reproduced red and fixed: a prior matching native owner record
  invalidates bootstrap presentation without claiming current ownership.
- Listing/focusing tolerates live partial JSONL appends; actual launch still
  validates saved history. A kernel lock observation is not completed startup:
  the fixture now waits for actual `session_start` before injecting partial data.
- tmux interprets trailing semicolons even in argv. Red/green real-process tests
  prove literal cwd/session/argument handling; the downstream primitive refuses
  tmux's one-string shell form. Read/focus/annotation probes use `-N` and cannot
  start a replacement shared server.
- RPC shutdown can close stdin before its exit event. The test transport now
  rejects pending writes rather than emitting an unhandled EPIPE. Fixture cleanup
  waits for actual pane-process exit rather than treating kill-server's response
  as an exit receipt. These changes strengthen evidence, not delivery claims.

Final verification, including review remediation:
- **166 unit tests**, zero skips; full TypeScript build and source contracts pass.
- Package contracts: **17 engineering probes + 17 headless cases**, zero skips.
  Module contracts and all **3 runtime-pin tests** pass. Standalone bridge and
  harness packages build as part of these isolated gates.
- **9 actual-Pi helper scenarios in each of two suites** (direct tmux and the
  production packaged downstream launcher), zero skips. Archive fixtures use the
  real public BridgeStore API, not an invented database simulator.
- **67 downstream Go tests** pass with `-race`, zero skips; the isolated production
  picker package also builds and passes all 67 tests. Tests use disposable sockets.
  Measured popup latency is fixture/environment evidence, not a live-host promise.
- **5 downstream source/evaluation tests**, including GRILL and NAS, pass. Both
  evaluate to native bridge enabled, legacy disabled, Pi 0.84.4, independent
  lifetimes and no failed assertions. Privilege evaluation also passes on both.
  Evaluations use a local `git+file:` override and `--no-write-lock-file`; no NixOS
  system output was built. The unavailable NAS builder fell back to local builds.
- Downstream commit hooks pass. Go LSP cannot establish a build for this external
  folder; actual Go builds/tests provide evidence. The existing settings JSON
  schema URL returns 404; local JSON/resource/TypeScript checks pass.

Key local artifacts:
- `2026-11-10T07-02-26-504Z-native-post-review-harness-703038280217`
- `2026-11-10T07-04-18-980Z-native-post-review-packaged-helper-suite-9d58f377f0d1`
- `2026-11-10T07-02-26-504Z-native-post-review-picker-race-ae934d114e0f`
- `2026-11-10T07-02-26-504Z-native-post-review-picker-package-d48baeeb86b6`
- `2026-11-10T07-04-18-980Z-native-post-review-host-evaluations-c186bb0dbe65`

Paired review disposition:
- Harness review `2026-11-10T06-51-12-535Z-worktree-38482d4d9c55-b24e3ee5dafa`
  found no verified harness defects, but was explicitly incomplete for downstream:
  the file-only review interface could not execute the requested Git reads.
- The missing downstream/cross-repository portion was completed in
  `2026-11-10T06-54-25-519Z-worktree-0a7dcf163fbd-8adcbfc44aea`, using read-only
  ordinary files extracted from the exact downstream commit, not its dirty tree.
  The frozen diff SHA-256 is
  `d292256ef73e968737a001ff49714d1ef224d9566298b7f71f7cd648a2b2425c`.
- **Standards: one medium, current-issue finding, accepted/fixed.** The picker now
  rejects relative `PI_NATIVE_SESSION_HELPER` overrides before invocation. The
  documented absolute override contract and regression test agree.
- **Spec: one high, current-issue finding, rejected with source and executable
  evidence.** The claim that daemon wake lacked tmux on PATH omitted the existing
  `tmux_project.nix` wrapper, which prefixes its private tmux/runtime PATH. The
  added actual-production `localOpen` test removes tmux from inherited PATH,
  checks credential stripping, executes the public helper with the configured
  packaged launcher, and waits for actual native `session_start`. Both direct and
  packaged cases pass. No redundant service PATH dependency was added.

No accepted current-scope findings remain. The subsequent canonical gate exposed
an additional packaging regression: the preserved stateless `!pi` package's
wildcard TypeScript roots compiled the newly shared renderer despite not using
it. Its package now compiles the two real entrypoints and their transitive imports,
without adding an unused Markdown dependency. The focused `bridge-chat` gate
passes all **115 tests**, zero skips. This isolated compile-root correction does
not change the reviewed runtime design.

**`nix run .#verify` passes at the #164 boundary**, including all 12 constituent
gates, 166 unit tests and 856 legacy regression tests (zero skips), plus the
previously recorded chat/package/module checks. Final log:
`2026-11-10T07-11-41-840Z-native-164-canonical-recheck-55c485c0fb5f`.
Only this evidence text was changed afterward. The cumulative epic review and a
fresh canonical gate remain #171 release requirements; none of these fixtures
prove live Matrix delivery, NAS operation or safety around existing legacy writers.

### #165 preflight: background organization and trusted invitations

Current issue: native room/Space provisioning and a narrow account-side invitation
consumer. No model controls, process inspection, lifecycle registry, archive
closure, notification-policy writes or general account-action protocol. #166
owns richer interactions; #167/#168 own approved workspace/archive mutations;
#169 owns legacy identity/departure import; #170 removes old account machinery.
NAS source changes are authorized, not deployment or live membership effects.

| Acceptance | Planned seam | Required focused evidence |
| --- | --- | --- |
| One native room despite lost creation response | Frozen setup node/alias in existing bridge progress; immutable create provenance; saved room IDs win over aliases/names | Drop create ACK before/after server commit, restart, alias collision/removal, foreign creator and unsupported version; never create a second room after uncertainty |
| Host → project → checkout → conversation | Background organizer, bounded fixed-argv read-only Git grouping; shared node work coalesced | Two sessions share project/checkout Spaces; linked worktree has distinct checkout; no-Git workspace works; Git failure produces setup-pending only |
| Bound delivery survives grouping/account failures | Separate setup and delivery work/backoff, bounded status warning | Healthy text continues during blocked Space link, Git error and operator invitation outage; local startup never waits |
| Narrow exact-host invitation acceptance | Optional consumer in existing owner transport, independent sync cursor/work, separate private account-local invitation journal (not the assistant/legacy account database) | Trusted sender plus immutable room proof; reject arbitrary invite/encryption/foreign creator; restart/lost join ACK; observed departure and current membership recheck suppress retry |
| Preserve user policy and isolation | No push-rule writes, leave/forget/unban or operator token on host | Endpoint allowlist assertions; account-policy changes do not reset assistant requests/watermarks; helper failure does not occupy model work |
| Nix/downstream handoff | Public grouping config; exact host/bot map on NAS replacing managed account policy in consuming source | Package/module checks and both-host evaluation only; preserve unrelated staged NAS changes and stateless `!pi` |

Crash boundaries to implement/test:
1. Persist node identity/creation payload before external work. On uncertain create,
   resolve and verify the same private alias only; an absent alias is pending, not
   permission for a second create. Definitively rejected requests may retry safely.
2. Persist returned room ID before hierarchy work; verify immutable provenance and
   creator before adopting a recovered room. Grouping failure cannot unset routing.
3. Links are read/compare/PUT state with the same endpoints/content. Interrupted
   link work resumes independently; no process or account acknowledgement gates it.
4. Record invitation attempt before POST. Unknown outcome is observed, never
   blindly reinvited; leave/ban is negative authority, not a repair invitation.
5. Account intake and its cursor commit together. Recheck a current scoped account
   snapshot before first join, then persist attempted before POST. Lost join ACK
   is observed, not replayed; departures remain suppressed across restart.
   Matrix offers no conditional membership CAS: do not claim a client-side check
   can serialize a simultaneous human action on another client.
6. Shutdown cancels/awaits only bridge/account HTTP work; no Pi/tmux/room teardown.

Protocol references: Matrix Client-Server API `/createRoom` copies custom
`creation_content` into immutable `m.room.create`; `/sync` invitations include
stripped create state (required since spec 1.16). Room v12 may have additional
creators, which the existing shared single-creator verifier rejects. Sources:
<https://spec.matrix.org/v1.19/client-server-api/> and
<https://spec.matrix.org/v1.19/server-server-api/>. No live API probe was used.
Implemented seams: `matrix-bridge/organization.ts`, the shared immutable room
verifier, and `bridge-chat/trusted-invites.ts`. Setup uses the existing host
ledger's progress rows; it adds no runtime registry or daemon. The account
consumer deliberately uses a separate private `bridge-invites.sqlite` database:
this isolates its cursor/attempts from assistant requests and leaves the historical
account database untouched for #169. The preflight's proposed shared connection
was not adopted. This is one optional owner-account consumer in the existing
transport, not a second host database or a general mutation platform.

Acceptance evidence before review:
- **9 organization tests** use real SQLite reopen, HTTP-boundary fixtures and
  disposable Git repositories. They cover concurrent shared nodes/links, lost
  create/link/invite acknowledgements, definitive rejection, alias absence and
  collisions, immutable provenance, no-Git workspaces and linked worktrees.
- **12 invitation tests** cover exact trust/proof, transactional offer/cursor
  rollback, independent policy, lost ACK observation without replay, server retry
  delay, filtered join/leave sections, persistent departures, trust revocation,
  exclusive ownership and orderly shutdown. An endpoint allowlist rules out
  notification, to-device, leave/forget and unban effects.
- A public IPC/delivery test blocks setup HTTP while already-bound input and
  persisted output continue. Credential identity tests reject a mismatched/guest
  bot before any database or setup creation. The unchanged actual-Pi offline
  helper tests still pass; optional organization is not a local launch gate.
- Affected Nix gates pass: **177 unit tests**, **127 chat tests**, source, module,
  package and TypeScript checks; behavioral tests have **zero skips**. Includes
  existing 17 engineering and 17 headless probes. Log:
  `2026-11-10T08-35-39-634Z-native-165-pre-review-affected-476f98e93a83`.
- Both-host **evaluation only** plus source checks pass (**6 tests**); NAS has the
  exact grill/NAS native-bot map and both hosts have empty legacy account policy.
  Log: `2026-11-10T08-11-53-040Z-native-165-consuming-evaluation-ced850f610c3`.
- Downstream commit `c8d681d64b4a9086a9bbd19aa69f6e410f836e78` changes only
  native invitation configuration, its checks and guidance. Normal hooks pass.
  A temporary index excluded the pre-existing Signal fix in the same NAS file.
  The restored real index equals the expected preserved tree exactly:
  `ec5ea41a6c1c24505bc546f414779511f8a9f697`; all six pre-existing staged files
  remain staged. The #164 patch hash is not reused across changed base commits.

Legacy room provenance/departure conversion remains #169; this slice never
rewrites immutable create events or opens the old account journal. Unknown room
creation with an unavailable alias remains setup-pending rather than duplicating
rooms. Matrix membership has no CAS; the scoped pre-join recheck cannot serialize
another client's simultaneous action. These are protocol/fixture results, not
live homeserver receipts.

Paired pinned Standards/Spec review completed at
`.pi/tmp/reviews/2026-11-10T08-39-24-059Z-worktree-f3cf8015908d-07d0d815c5cc/`,
including the exact downstream committed diff/source export (SHA-256
`c847ee7b8d40eb2f5b060ebd8c5e8f1f0e43d6af997686dc00594b38eb8c655d`).
Neither axis found a current-issue defect. The Spec low/deployment-only note is
accepted: live acceptance remains #172, not evidence supplied by these fixtures.
**`nix run .#verify` then passed all 12 gates**, including 177 unit, 127 chat and
856 legacy tests, zero skips. Final log:
`2026-11-10T08-41-40-416Z-native-165-canonical-boundary-9ce56855a24f`.
Only this evidence text changed after the gate. Cumulative review/fresh
verification remain #171 requirements; no push, deployment or migration occurred.

### #166 preflight: polls, native controls and inbound images

Current scope is rich interaction only. #167/#168 own independently approved
workspace/archive effects; #169 migration; #170 legacy removal. Do not restore
an execution supervisor, general host controls, export spool or notification
repair. Production Matrix actions remain forbidden.

| Acceptance | Implementation seam | Required evidence |
| --- | --- | --- |
| Durable native questions/choice polls | Persist a native custom question before aborting; project it into frozen outputs plus a small interaction row | Real Pi question/idle, restart/lost publish/end ACK, obsolete question after local input/tree/switch, native history identity |
| One answer, joined-member collaboration | Atomically claim interaction and authorize its input; capture active-question association at intake; explicit stale replies/votes ignored | Concurrent votes/text, duplicate IDs, departed/ignored sender, restart before/after handoff, no automatic retry of uncertain execution |
| Native help/status/start/stop/abort/model/thinking/compact | Direct native APIs, durable result entries, selection polls for native available choices | Actual Pi preference/history changes, busy rejection/abort, no shell/TUI command synthesis or silent model switching |
| Original JPEG/PNG/WebP and captions | Authenticated same-homeserver media fetch; indexed private SQLite chunks; bounded digest-checked handoff to Pi | Original bytes persisted by actual Pi; captionless/default caption, repeat event IDs, malformed/encrypted/unsupported media and model-local explanation; no new size/pixel caps |
| Independent bounded failures | Existing per-room work/output identity, no additional daemon or process authority | Bad poll/media/control in one room cannot block another, interrupted transfer/abort, definitive rejection versus uncertain receipt |
| Native command/skill/template semantics | Existing patched preflight and post-expansion attribution remain the dispatch seam | Real extension command consumption and template/skill expansion with provenance; do not delete patches based on assumed SDK behavior |

Crash boundaries: intake/association/cursor together; interaction claim/input
queue together; freeze poll bodies/transaction IDs before send; publish/end retries
reuse them. Persist original image and its authorization together before handoff;
chunks never become execution receipts. Persist handed before native dispatch;
unknown receipt remains interrupted. Native question/result markers are fsynced
before projection, not inferred from tool events. Use branch/session identity and
abort epochs at the adapter, without gating ordinary local Pi on bridge state.
The additive delivery schema upgrade must preserve existing bindings, inputs,
outputs and cursors and reject an older daemon against the upgraded ledger.

Implementation now uses native `matrix-bridge.question`, `matrix-bridge.answer`
and `matrix-bridge.control` entries. Poll starts/ends retain frozen IDs and bodies;
first authorized input wins in the same transaction as its interaction claim.
Plain-text fallback follows recovered room order, not sender clocks. The adapter
also checks the original native question on the current branch before dispatch.
History projection checkpoints every processed entry so replay cannot cancel a
later question. No room/input identity is inferred from visible attribution.

Controls use only authenticated, session-scoped native choices. `!start` requests
an idle local open; its acknowledgement is not a startup receipt. Compaction has
separate requested/completed/failed results. A newly tested native API gap required
`pi-bridge-control-preflight.patch`: the loader forwards optional guards, model
selection checks again after authentication, and compaction checks across awaited
boundaries and before native history mutation. Each manual compaction retains its
own abort controller so a late callback cannot clear a replacement. The adapter
fences file/session, abort epoch, native branch and busy state as appropriate.
Existing expansion/provenance/persistence patches remain necessary and retained.
The SDK's ESM-only thinking helper is imported lazily, not eagerly through the
CommonJS headless enrollment-policy path.

Images use the authenticated v1 media-download endpoint with redirects rejected.
Untrusted MIME/size/pixel hints do not replace the original bytes. SQLite schema 2
atomically adds interaction association and indexed 24-KiB image chunks, advances
the version fence, and preserves existing delivery facts. There is no secondary
export spool or new payload/pixel cap. Full/chunk digests and live native scope are
checked before an image becomes a native user message. Unsupported media/model
requests never silently become caption-only prompts or select another model.

Focused and affected evidence:

- Ten HTTP-boundary/real-SQLite/private-IPC interaction cases cover competing
  votes/text, chronological fallback, stale/foreign/ignored senders, lost poll
  start/end receipts across reopen, per-entry projection replay, original image
  formats/captions/deduplication, unsupported input, corrupt chunks, room isolation
  and detached controls.
- Five store cases include the prior intake/output/restart contracts, schema-one
  upgrade preserving cursor/binding/queued input/frozen output, and a synthetic
  PNG-signature payload over 25 MiB exercising durable storage and bounded frames
  (not a codec-validity claim). Indexed chunk reads avoid repeatedly scanning a
  whole large blob.
- Four actual packaged-Pi cases include persisted text/daemon outage/new-session
  isolation, native extension/template/skill behavior, choice tool abort/idle,
  first-answer wins, local-tree obsolete-question rejection, real model/thinking
  and completed compaction, original JPEG/PNG/WebP bytes in native history,
  unsupported-model/busy rejection, and abort during an interrupted image read.
  Native API guard tests revoke scope while authentication awaits and inside a
  compaction hook; neither withdrawn mutation commits. RPC worker exclusion
  remains enforced. These use disposable homes and fake model/HTTP transports,
  not live Matrix/model receipts.
- Actual native compaction first failed in the tiny fixture under the native
  20,000-token keep-recent default. The fixture alone now has a one-token recent
  window and requires the completed callback/history entry. No production check
  was weakened. The model-scope test then deliberately failed against the old
  API (`false !== true`) and passed with the new native guard patch.
- Logs: `2026-11-10T10-11-38-725Z-native-166-boundary-regressions-60ad2524eae0`
  (19 passing, zero skips),
  `2026-11-10T10-35-43-629Z-native-166-control-scope-red-6994150f905a`, and
  `2026-11-10T10-41-37-102Z-native-166-control-scope-green-de99d8b4213a`
  (four actual-Pi cases passing, zero skips). The first broader gate exposed the
  eager CommonJS/ESM import mismatch. Its corrected recheck,
  `2026-11-10T10-54-32-517Z-native-166-affected-recheck-dffa25cdf823`, passed
  production Pi/bridge compilation, TypeScript, source/module/package contracts,
  **191 unit and 127 chat tests**, zero skips. Cached LSP resolution against the
  earlier SDK still reports stale types in the worktree; fresh local `tsc` and
  the isolated Nix compiler both pass against the patched declarations.

Pinned paired review:
`2026-11-10T10-58-23-599Z-worktree-026d7b96bc68-1d0d6a83540f`.

- **Standards:** one high/current-issue finding, accepted and fixed. Controls had
  received a session-only predicate rather than the captured live abort epoch.
  Both native preflight and result publication now use that captured scope;
  pending control/compaction flags carry their epoch so a revoked callback cannot
  clear or indefinitely hold a replacement. Disconnect/checkpoint/abort revokes
  only ephemeral preflight ownership, not local process authority.
- **Spec:** one medium/current-issue finding, accepted and fixed. A nonempty image
  body without optional `filename` was lost. It is now retained; blank bodies and
  known filename-equal bodies retain the captionless default.
- Both regressions failed first in
  `2026-11-10T11-03-45-191Z-native-166-review-regressions-red-1d7ba1b7a2bd`.
  The batched correction passed all 19 focused/native/store cases, zero skips,
  in `2026-11-10T11-08-01-877Z-native-166-review-regressions-green-acf1770d633e`.
  Actual Pi rejects a deliberately delayed control after abort, emits no late
  success and accepts a fresh control. Original caption bytes without `filename`
  also reach actual native history. No accepted current-scope finding remains;
  this remediation preserves the reviewed design and does not need a routine
  second subjective review.

Final **`nix run -L .#verify` passed all 12 gates** at
`2026-11-10T11-15-33-682Z-native-166-canonical-recheck-3ca7cce64edf`, including
191 unit, 127 chat and 856 legacy tests, zero skips. The initial canonical attempt
(`2026-11-10T11-09-19-146Z-native-166-canonical-boundary-997777a0b4ba`) passed the
new/affected suites but failed two existing legacy timing-boundary cases: reconnect
projection and abort-during-wake notice delivery. Both passed three focused repeats
using the exact failed derivation's immutable source, compiled tests, Node 24 and
Pi/resource artifacts (`2026-11-10T11-14-47-251Z-native-166-legacy-failure-isolation-3a2c26d4c45f`),
then the unchanged canonical recheck passed. No test assertions, timeouts,
concurrency or production code were weakened. The initial failure's root cause
is not proven; cumulative #171 verification must still run afresh. Only evidence
text changed after the passing gate. Final isolated production packages (`pi`,
`matrix-bridge`, `bridge-chat`, `pi-harness`) also passed:
`2026-11-10T11-19-29-050Z-native-166-final-packages-9d04f61b0f99`.

No production mutation, migration, restart, push or rollout evidence is implied.

## Rebuild and migration readiness

Pending implementation and cumulative verification. Do not run a host switch merely
because this document exists. Host builds/activation and real account/room effects
remain operator actions. Existing old managed sessions are not compatible writers
for a replacement kernel-lock protocol until the approved cutover has quiesced them.
