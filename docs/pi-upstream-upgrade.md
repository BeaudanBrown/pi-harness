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

## Verification and commits

- Unpatched Pi 1.5.2 CLI/SDK built; TypeScript compilation passed.
- Focused real-Pi, relay, archive and hierarchy regressions: 12/12 passed in
  11.9 seconds (2026-11-18). The initial broad run was interrupted: an obsolete
  archive test awaited the removed remote-wake callback indefinitely. Replaced
  it with a bounded offline-rejection regression, retaining hierarchy coverage.
- Busy fake-model tests now use explicit release signals rather than ten-second
  sleeps. An observed stale-idle race is covered: an explicit no-submission
  receipt returns the batch to the inbox, never reviving interrupted input.
- Broad verification and consuming-host integration remain outstanding.
