# Isolated real-Matrix smoke — initial bootstrap failure (#121)

**Follow-up:** the approved room-v12 fix and same-state recovery now pass the
bounded native-launch/hierarchy/account smoke. See
[remediation and retest evidence](managed-room-v12-evidence.md). This document
preserves the initial failed attempt; it is not the current remediation status.

## Authorization and scope

After the offline staging checkpoint, the operator provisioned two new non-admin
accounts, `@pi-smoke-owner:matrix.bepis.lol` and
`@pi-smoke-bot:matrix.bepis.lol`, with devices `PI_SMOKE_OWNER` and
`PI_SMOKE_BOT`, and explicitly authorized running the isolated test. Both identities
were verified by authenticated whoami; both joined-room inventories were empty
before any mutation. Token files were private/current-user-owned and never printed.
No production account, secret repository or existing room was used.

The test used candidate packages from harness HEAD `02376f3` (runtime fix
`99f5941`) and the owning picker through `132c3d9`/handoff `2d2f278`.
The actual harness module's dispatcher/direnv/launcher PATH was evaluated with
minimal test option declarations and a disposable workspace root, not the fleet
configuration. Initial fixture evaluations selected the wrong service namespace
and option type; those fixture errors were corrected before any live traffic.
No host system was built, installed, activated or restarted.

Private HOME, XDG directories, agent state, runtime, manifests, histories and a
new Git checkout were used. Processes received an allowlisted environment. The
account worker trusted only the test bot/device; its assistant room scope was a
nonexistent test-only room and no model worker was started. The owner token was
exposed only to the account transport through a temporary mode0600 credential,
removed on exit. The relay held only the test bot token. No model requests ran.

## Result: FAIL, not end-to-end acceptance

Passed:
- Private credential permissions, exact account/device identities and empty
  initial joined-room inventories.
- Real packaged account transport authenticated and initialized its watermark
  with the narrow test trust policy.
- Real packaged relay authenticated, opened local control IPC and created one
  attested test host Space on the actual Synapse server.

Blocked:
- Coordinator provisioning never completed. The runner reached its bounded
  bootstrap deadline; no coordinator or project Pi attachment was established.
- Consequently project creation/open, owner automatic joins, commentary/final
  projection, tool approvals, navigation and retirement were **not** verified live.
- Account worker startup alone is not account-automation acceptance.

The newly created Space is room version **12** and has a hash-based room ID with
no `:server` suffix. It contains the expected `host_space` provenance for
`isolated-smoke`, was created by the test bot, and has only that bot joined.
The coordinator journal remains `hostAttempted:true`, `roomAttempted:false`,
`linked:false`, with no committed hostSpace. Repeated recovery did not create a
second Space. The single test Space was retained, not deleted or migrated.
Its exact ID and safe metadata are in the local artifacts below.

## Confirmed source incompatibility

**High / current epic at the initial failure:** subsequent tracing confirmed
that the real client rejected the returned/aliased ID even before journal commit.
The journal and provenance errors below were additional reproduced blockers;
all are addressed by the linked remediation.
`config/agent/extensions/managed-sessions/relay/coordinator-provisioning.ts:8`
requires a legacy `!localpart:server` room ID. Persisting the returned v12 host
Space therefore throws `Invalid coordinator provisioning intent`.
`managed-provenance.ts:8` also rejects the same ID as a parent room. Other shared
contracts contain legacy-only room patterns and require an audit before claiming
v12 compatibility; this finding is not resolved by changing one regex blindly.

A deterministic offline reproduction invokes the **shipped production**
`provisionCoordinatorRooms` with only the Matrix port replaced by bounded return
values. A legacy host ID succeeds with two create calls; the exact observed v12
ID fails at the durable journal with one create call and the error above.
The shipped provenance parser independently rejects that v12 parent ID.
The reproduction takes less than a second and makes no HTTP requests.

Matrix room v12 intentionally derives the room ID from the create event hash,
without a server-name suffix:
<https://spec.matrix.org/unstable/rooms/v12/>.
No room-version downgrade, server setting change, disabled validation, journal
rewrite, automatic enrollment retry or production-code patch was used to get a
passing test. The next step is a compatibility fix with regression coverage,
followed by an explicit same-state recovery/retest (not a fresh duplicate run).

## Evidence and retained state

- Live runner: `.pi/tmp/live-managed-smoke.py`.
- Live result: `.pi/tmp/live-smoke-report.json`.
- Live command/log:
  `.pi/tmp/workers/2026-10-27T02-26-50-420Z-isolated-real-matrix-managed-smoke-355ac8c54765/`.
- Safe actual room metadata: `.pi/tmp/live-smoke-room-metadata.json`.
- Offline repro: `.pi/tmp/live-smoke-room-id-repro.cjs`.
- Repro result:
  `.pi/tmp/workers/2026-10-27T02-31-09-629Z-live-smoke-v12-room-id-reproduction-4ba3aa440166/`.
- Private local state: `/tmp/pi-live-smoke-2dsA99` (retain for recovery evidence).
- Both owned relay/account processes were stopped; private tmux cleanup was
  scoped to that root only. No shared tmux/service operation occurred.
- The temporary owner credential copy was removed; the operator's original
  token files and test logins were retained for a future authorized retest.

The runner deliberately refuses accounts with pre-existing joined rooms. Do not
rerun it unchanged against the retained Space, delete the journal, or discard the
old reservation as a workaround. Recovery needs to preserve the established
identity and validate that exact test Space after fixing compatibility.

#120's unpublished source pin/actual fleet-lock boundary, #121 real-client
acceptance and the epic remain open. Previously passing offline tests do not
supersede this failed live test. Desktop/Element X and deployment evidence remain
absent, and no production migration is recommended.
