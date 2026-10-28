# Legacy window migration (#127)

A relay rebuild does not retrofit running tmux windows with exact launch/process
ownership. Older records can contain only a session/window/pane ID; those IDs are
reusable and may already be stale. Ordinary stop/start must not adopt or signal
such windows. `conversation.migrate` is an explicitly confirmed **project-only**
recovery path. It never signals a process, modifies tmux markers, restarts tmux,
launches Pi, changes the Matrix hierarchy, or replaces a conversation/session.
The coordinator remains protected.

## After rebuilding

Use the new relay's Matrix `!host` command or installed CLI; an old running
adapter need not already expose the new model tool. Identify the exact conversation
with `conversation list` / `conversation status`. Finish any active run first.

1. **Before closing the old window**, capture its exit evidence:
   ```text
   !host conversation migrate conv_<exact-id> --confirmed
   ```
   Terminal equivalent:
   ```sh
   pi-managed-session conversation migrate conv_<exact-id> --confirmed --json
   ```
   `awaiting_exit` means the private evidence was saved; nothing was stopped.
2. Quit Pi normally and manually close **only that conversation's old tmux
   window**. Quitting Pi alone can leave a shell/window behind. Do not close the
   project session, shared tmux server or unrelated windows. If the original
   window is unclear, investigate rather than selecting a window by stale pane ID.
3. Send the same confirmed command again, with a new command event/request.
   The host verifies the captured process births have exited, no marked
   conversation pane or original window remains, and no observable process
   still carries the conversation/session identity. `ready` means only stale
   runtime window metadata and the old attachment nonce were cleared atomically.
4. Use `!start` to resume the same conversation with exact ownership. Room,
   saved history, generation, settings and queued input remain unchanged. Queued
   input may resume through the usual wake/recovery behavior; migration does not
   cancel it or promise to undo prior effects.

Every model invocation requires separate approval. Migration does not reuse old
consent after relay restart; repeat the confirmed action. Stored evidence is only
an exit witness, never termination or adoption authority. There is no bulk or
background migration and no automatic busy-session upgrade.

## Blocked cases

- Busy/unknown activity, pending controls, transitions or refresh: finish or
  investigate first.
- Missing/duplicate/changed window, linked/split/dead pane, a current pane tree
  with no matching conversation/session process, unreadable process inventory,
  or missing session history: fail closed, without clearing anything.
- A stale saved pane ID (for example `%3` versus current `%54`) is not ownership
  authority. Capture may observe the current single pane only when both the
  window/conversation marker and a process in that pane tree identify this
  conversation/session. It records current process births solely to verify later
  exit, never to adopt or signal the pane. A marker on an unrelated replacement
  shell is insufficient. A pane change during observation also blocks capture.
- A window already closed before evidence capture cannot be recovered by this
  path. It needs separate manual investigation, **not** registry deletion.
- Surviving descendants or detached processes carrying the session identity block
  recovery even after window closure. Investigate their ownership; do not blindly
  kill them. The private `/proc` scan reads identity fields only and never logs
  process arguments or environment values.
- Exact-ownership launches are not legacy recovery targets. Use ordinary lifecycle
  controls. Do not clear an uncertain exact launch with this command.

This is Linux, same-Unix-user cooperative process recovery, not a sandbox against
processes deliberately hiding their identity. The launcher checks the configured
runtime socket and inspects process birth identity; missing tmux connectivity is
not proof of exit. An original-window ID reused by another window conservatively
blocks recovery. Nothing here claims every historical conversation is migratable.

## Acceptance / scope / crash evidence

| Acceptance | Evidence |
| --- | --- |
| Stop/refresh preflight precedes cancellation/shutdown; reset rejects legacy ownership before generation changes; start reports actionable legacy error | `managed-session-exact-lifecycle.test.ts` |
| Preserve history, manifest, generation and queue; fence old nonce atomically | lifecycle migration/restart tests |
| Explicit confirmation, model approval, coordinator protection | host frontend and live-workspace contract tests |
| PID reuse, descendants/detached writers, missing markers, retained windows and boot identity | `test_managed_legacy_observe.py`, invoked by the managed Node suite |
| Changed consent target, generation race, failed inspection and missing history | lifecycle negative tests |

| Crash boundary | Recovery |
| --- | --- |
| Before exit evidence write | No migration; repeat explicit consent while the window exists |
| After evidence write / before manual closure | Witness survives restart; no automatic action |
| After manual closure / before verification | Repeat explicit consent; verify births and current inventory |
| After verification / before registry commit | Recheck generation/state/window under the registry mutation lock |
| After registry commit / before reply | Old nonce and window removed together; repeated migration reports ready |
| Later ordinary launch fails | Existing exact-launch recovery applies; no second legacy cleanup |

Current issue owns the fixed read-only launcher probe, confirmed lifecycle owner,
public diagnostics, regression tests and this runbook. Nix evaluation/build,
activation and live migrations are deployment-only and deliberately not performed
at the operator's request. No changes to the external tmux launcher repository are
required; the harness wrapper distributes its own read-only probe.

## Review disposition

Both Standards and Spec reviewed the pinned worktree. Accepted current-issue
findings: refresh could request graceful shutdown before detecting legacy metadata;
reset could begin/activate a generation before that detection. Both now preflight
legacy ownership, including the registry's production reset admission seam and
recovery of already-persisted generation transitions.

Both reviewers also flagged capturing a current pane when its ID differs from
stale saved metadata. The underlying unrelated-replacement concern was accepted:
capture now additionally requires a matching conversation/session process in that
pane tree, with negative coverage for marker-only replacements. Requiring equality
with the historical reusable pane ID was not adopted: this path is explicitly
exit-witness capture for stale metadata, not process adoption/termination, and the
reported production case has `%3` versus `%54`. All observed session writers and
descendants must exit, and both the conversation marker and original window must
be absent at completion. Current pane changes during observation fail closed.

Final local verification: TypeScript compilation passed; the affected Node suite
passed **186 tests**, with **7 packaged integration tests skipped** because the
packaged launcher/helper/real-Pi environment was not built. The read-only observer
suite includes **7 Python cases** within its Node test. LSP reports no errors;
`git diff --check` passes. Evidence:
`.pi/tmp/workers/2026-10-28T00-59-03-530Z-legacy-migration-final-local-7ed7519e3793/`.
The canonical `nix run .#verify` and packaged/module checks remain pending for the
rebuild/CI, as explicitly requested. No live migration or activation was attempted.
