# Unpatched Pi upgrade

Approved implementation contract: use Pi 1.5.2 without downstream Pi patches.
Native Pi owns execution/history; the bridge owns routing and durable delivery.
No substitute execution manager, runtime monkey-patching, or copied Pi internals.

## Acceptance and evidence plan

| Contract | Implementation | Required evidence |
| --- | --- | --- |
| Unmodified CLI and SDK, restricted workers | Nix packaging, profiles and SDK callers | package/type/profile and real SDK checks |
| Literal attributed remote text/images, ordered idle batches | adapter, relay, input | real Pi + bridge tests; local queues unaffected |
| No replay after abort/disconnect or uncertain handoff | transactional inbox | interruption/restart tests |
| Offline input/votes rejected; first connection wins | relay registration/intake | duplicate/offline tests |
| No writer lock/start/stop; local picker still works | local helper and host integration | local-helper and host picker checks |
| Delayed enrollment; historical privacy and provenance retained | adapter and projection | first persistence, reconnect, old metadata tests |
| Best-effort controls fail fast | native-controls | busy/auth/compaction failure tests |
| Matrix-only ask_user, late answers, no conversation gate | adapter and interactions | poll/reply/duplicate tests |
| Independent creation approvals retained | tasks and provenance | local/Matrix approval and idle child tests |
| Archive is presentation only | store, relay, organization | archive delivery/grouping tests |
| Existing history and room identities unchanged | ledger compatibility | upgrade/restart fixtures |

Run tests after substantial implementation chunks. Do not run live model or
Matrix traffic, restart services/sessions, migrate live history or push without
separate authorization. The consuming host must pin a published commit before
an ordinary remote-backed rebuild; a local input override is only validation.

## Crash boundaries

| Boundary | Durable state / effect | Interruption policy |
| --- | --- | --- |
| Matrix intake | raw event + cursor in one SQLite transaction | queued input held after daemon restart |
| Native handoff | mark entire batch handed before IPC | never automatically retry; explain uncertainty |
| Abort/disconnect | mark pending input interrupted | reconnect never releases it |
| Poll answer | claim first answer with input authorization transaction | no duplicate answer; offline vote does not claim |
| Matrix output | frozen output transaction ID before HTTP | retry same output ID; no model replay |
| Creation approval | original independent approval and frozen intent | retain existing idempotent creation protocol |
| Enrollment | observe persisted upstream history before register | no forced idle flush or replacement history |

## Agreed semantics

- Only already-running native sessions receive remote input. First live adapter
  connection wins, without claiming single-writer ownership.
- Matrix text is literal; native command/skill/template execution is local-only.
- Waiting chat is delivered as one ordered attributed batch when fully idle.
  Local input does not invalidate it. No native steering/follow-up integration.
- Abort/disconnect holds waiting input without a release interface or replay.
  Offline messages/votes are rejected. Uncertain submitted operations may finish.
- Keep status, model, thinking, compaction and best-effort abort. Reject conflicting
  controls; no rollback, process killing or automatic retries.
- Replace remote_checkpoint with ask_user: Matrix questions/polls, no blocking
  answer state. First eligible answer wins; late answers include their question.
- Keep images and current local-user/completed-assistant projection. Do not expose
  thinking, tools, private entries or pre-enrollment history.
- Keep independently approved project/worktree creation with saved idle histories.
- Archive/restore only organizes the picker and Matrix Spaces; archived rooms may
  still instruct a connected session.

## Runtime and compatibility notes

- Protocol 2 requires reopening existing Pi processes locally after an approved
  activation. Old adapters fail closed with an upgrade message; no daemon action
  restarts a process or replays its inbox. First registration alone is not intake
  readiness: each attachment must survive a complete fresh sync.
- Schema 5 preserves native/room identities, historical custom/metadata provenance,
  independent creation approvals and frozen outbox IDs. Pending input is held on
  startup. This is not a request to rerun legacy history migration.
- Idle control results use the bridge ledger directly, including saved idle child
  histories which upstream has not yet flushed. At idle, unobserved handed input
  is marked uncertain only after projection and outside an active handoff.
- Pi 1.5.2 native defaults include built-in MCP, llama.cpp, codemode and tool-search
  extensions, plus idle cache warming. Ordinary Pi retains upstream defaults;
  this repository adds no MCP server configuration. Lean CLI launchers keep
  `--no-extensions` with explicit additions. Restricted SDK workers supply their
  own empty ResourceLoader, exact tool allowlists, disabled compaction and
  `cacheWarming: "off"`; no discovery of built-ins or background cache requests.
- The separate stateless chat default is now `gpt-5.6-luna`: `gpt-5.4` is absent
  from the pinned 1.5.2 catalog. Explicit unavailable models fail at startup;
  no runtime fallback is added. Confirm account entitlement during activation.
  Stateless chat also disables cache warming and validates the exact tool set.
- Pi-R, AgentGraph and LSP pins are unchanged. Native registry ordering can change;
  Pi-R capability/restoration tests compare exact tool membership, not order.
- Harness-owned daemon/creation/publication locks remain local utility locks.
  They do not lock native Pi sessions or restore the removed writer guarantee.

## Verification and commits

- Unpatched Pi 1.5.2 CLI/SDK built; TypeScript compilation passed.
- Focused real-Pi, relay, archive and hierarchy regressions: 12/12 passed in
  11.9 seconds (2026-11-18). The initial broad run was interrupted: an obsolete
  archive test awaited the removed remote-wake callback indefinitely. Replaced
  it with a bounded offline-rejection regression, retaining hierarchy coverage.
- Busy fake-model tests now use explicit release signals rather than ten-second
  sleeps. An observed stale-idle race is covered: an explicit no-submission
  receipt returns the batch to the inbox, never reviving interrupted input.
- Final canonical `nix run --keep-going -L .#verify`: **all 11 checks passed**
  in 65.4 seconds on 2026-11-18. Main units: 289/289 in 43.9 seconds;
  stateless chat: 93/93 in 15.9 seconds; Pi-R: 6/6; eval: 73/73;
  packaged CLI/headless probes: 8/8 and 17/17. No skipped/cancelled tests.
- The later chat hang was distinct: an unavailable catalog model caused setup
  to throw before socket cleanup, and that separate runner was unbounded.
  Cleanup is now registered first, unavailable models fail closed, and SDK
  assertions account for native system-patch messages. Every deterministic
  component has a 180-second deadline, five-second kill grace and explicit
  start/pass/fail logs. Node tests have a 60-second default; independent unit
  and chat files run four at a time.
- Consuming `grill` and `nas` module evaluations with a local harness override:
  Pi 1.5.2, native-only bridge, independent process/service lifetimes, all
  assertions passed (six integration tests).
- Full `grill` toplevel evaluation with import-from-derivation disabled stopped
  at the existing KDE/base16 theme dependency, which requires IFD. No full host
  system build or activation was performed; this does not invalidate the focused
  integration evaluations. No live Matrix/account/model smoke test was run.
- Publication is still pending. The consuming flake remains pinned to `21f9a4b`
  (Pi 0.84.4); local override validation does not update that GitHub-backed lock.
  Publish the verified harness commit only with approval, then update the host
  input pin and lock, repeat host validation, and request activation separately.
  Reopen existing sessions locally on the new runtime; do not restart them from
  the daemon or replay held input. Preserve the existing ledger and histories.
- Canonical builds use the pinned 1.5.2 types. An already-running editor LSP may
  retain cached 0.84.4 types until refreshed; no unsafe casts or runtime patches
  were added to accommodate those stale diagnostics.
