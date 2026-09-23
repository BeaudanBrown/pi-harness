# Managed input and runtime updates (#95)

## Contract

The relay serializes only the input expansion/persistence boundary, not model
runs. A room has at most one unpersisted delivery in flight. A `persisted`,
`completed`, cancelled, or rejected-media receipt releases the next eligible
input. Steering is still available during a busy run. The durable registry is
consulted before sending: replayed sync events cannot revive terminal receipts.

The adapter correlates queued expansion markers and user entries in dispatch
order along their ancestry, checking expanded text and image digest, assigning
each user entry once. It writes explicit delivery/entry receipts on user
`message_end`, with settlement as a fallback. Transcript projection uses the same
correlation so queued Matrix messages are not echoed as terminal-origin input.

Historical expansion-only entries are uncertain: a matching user entry does not
prove whether the model already acted. They are retained and held, with a local
warning, not reinjected or automatically resumed. Repeated restarts preserve this
hold. Explicit persisted recovery requires relay receipt acceptance before any
model continuation; cancelled/completed/inconsistent relay state refuses it.
Use `!status` to see outstanding input, then `!stop` or `!new --confirm` to
explicitly discard stale work. There is no heuristic content-deduplication or
registry/cursor deletion repair. Distinct identical Matrix messages remain distinct.

`!stop` persists cancellation of outstanding deliveries with its control before
shutdown; the adapter also records local cancellation. `!new --confirm` captures
a delivery-ID cutoff when queued. Once the idle adapter authorizes reset,
cancellation of the pre-cutoff inputs is atomic with transition creation. Later
accepted text stays queued for the new generation. A rejected reset cancels
nothing and releases the gate. Replayed controls do not move the cutoff.
Cancellation never promises rollback of external effects already performed.

## Automatic project runtime updates

The managed project launcher hashes its immutable executable path. Attachments
report this opaque identity; the relay knows the desired identity from Nix.
Every 30 seconds (or the longer restart grace), it checks active managed project
conversations with exact window identities. Changed or legacy identities use the
existing idle-only refresh handshake; unchanged instances are untouched. Busy,
disconnected, transitioning, control-pending or otherwise unverifiable instances
are deferred. Refresh holds Matrix delivery, preserves the session/room/queue,
and never aborts a busy run. Dormant conversations are never woken for updates.
The existing host launcher replaces the exact managed window after graceful
shutdown; the shared tmux **server and unrelated windows are not restarted**.

`!status` reports current, pending, or next-launch project tooling updates. A
failed relaunch remains visible through the existing launch-failure status and
can be recovered by normal wake/explicit refresh. The relay stops scheduling
refreshes on shutdown and drains its current operation before closing IPC.

Scope: project engineering instances only. The lifecycle-only coordinator and
unmanaged ordinary Pi remain outside automatic refresh; this change does not
extend the project's coordinator refresh authority or replace all host processes.
Project-local mutable configuration is not watched; use explicit idle refresh
when changing it without changing the Nix launcher.

## Deployment

This adds strict optional attachment/runtime and reset-cutoff fields. Deploy the
new relay before new launchers/adapters; older readers cannot consume the new
fields and downgrade is unsupported. In particular, do not launch new adapters
against an old relay held back by the legacy-tmux guard. For the agreed one-time
cutover, finish work, deliberately close the old shared server, and activate the
new configuration from outside that server. Start `tmux-shared.service`, restart
`pi-managed-session-rollout.service`, and check `pi-managed-session-status` before
opening conversations. Preserve registry, inbox, notices, manifests and session
files. Never bypass the ownership guard.

The consuming dotfiles restore `nr` to generating imports then `nh os switch`.
Independent tmux ownership, guarded rollout and GC retention remain. There is no
custom detached activation/lock guarantee. System activation and relay rollout
health are separate; inspect both. Publishing/pinning and the live ownership
cutover are operator-authorized deployment steps, not performed by tests.

## Acceptance / evidence

| Acceptance | Evidence |
| --- | --- |
| Queued and identical user correlation; wrong branch/text rejected | `managed-session-delivery-order.test.ts` |
| One unpersisted input; cancellation never redelivered | `managed-session-controls.test.ts` ordered delivery regression |
| Reset cutoff survives restart; later input retained; late receipts rejected | `managed-session-relay-registry.test.ts` cutoff regression |
| Ambiguous expansion stays held; relay cancellation prevents local resume | `managed-session-adapter.test.ts` recovery cases |
| Runtime match/no-op, busy deferral, idle upgrade, no repeated refresh, dormant preservation | `managed-session-refresh.test.ts` real IPC/launcher fixture |
| Existing media, routing, lifecycle, real Pi behavior | `nix build .#checks.x86_64-linux.managed-session-tests --no-link` |
| Aggregate deterministic contracts | `nix run .#verify` |
| Consuming host config | Grill derivation evaluation with local harness override, no host build/switch |

## Crash boundaries

| Boundary | Durable authority and retry |
| --- | --- |
| Input queued, before injection | Stable event/delivery ID remains pending; no second identity on sync replay |
| Socket dispatch before user persistence | One delivered input gates successors; uncertain expansion is held, not guessed |
| User persisted before relay receipt | Explicit local receipt is replayed; relay terminal state wins |
| Stop accepted before shutdown | Control and cancellation share registry mutation; late persisted/completed acknowledgements cannot regress cancellation |
| Reset queued before authorization | Frozen cutoff survives restart; rejected reset does not cancel |
| Reset authorized before generation activation | Cancellation and transition share durable mutation; retry does not cancel post-cutoff input |
| Refresh requested before idle response | No termination until live idle consent and actual disconnection |
| Refresh shutdown before launch | Same saved session and queued input survive; failed launch stays dormant for recovery |
| New runtime attached before next poll | Attachment identity proves convergence; no persistent second update queue required |
