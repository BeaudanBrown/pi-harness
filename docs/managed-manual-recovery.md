# Operator-confirmed legacy recovery (#128)

Scope: recover one already-closed legacy conversation, or acknowledge the process
cleanup obligation of one already-retired conversation. This is not proof of
process exit and never authorizes signalling, adoption, automatic launch, history
replacement, or bulk recovery.

## Commands after deployment

Use exact IDs from inventory, never titles. Inspect the preview before applying:

```sh
pi-managed-session conversation recover preview conv_<exact-id> --json
pi-managed-session conversation recover apply --preview-id preview_<returned-id> \
  --confirmed --operator-closed --accept-incomplete-inspection --json
```

The same noun/action syntax works through `!host` or `/host`; the model uses typed
`managed_host` controls and must not substitute a shell invocation. The preview
states `recover` for a live identity or `retired_cleanup` for a terminal identity,
its saved generation/window, and the number of unreadable processes. The apply
flags explicitly attest closure and accept incomplete inspection. A detected
writer, matching marker, retained window/pane, active adapter, exact launch,
promotion or lifecycle transition blocks recovery. An unavailable or malformed
tmux inventory also blocks; this path does not infer an absent tmux server.

The inventory is a conflict screen, not a comprehensive proof of writer absence:
a process without a recognizable conversation identity or explicit managed
session argument may not be detected. Operator confirmation remains essential.

Preview expiry, relay restart or changed identity/history/inspection requires a
fresh preview and fresh consent. If apply times out, inspect status first; never
assume failure and recreate the conversation. After successful live recovery,
ordinary `!start`/resume is separate and may deliver preserved queued inputs.
Retired cleanup never grants start authority; NAS account cleanup may still be
pending. No rebuild or live operation was performed during source implementation.

Attestations live beside saved history as private
`manual-recovery-operation_<id>.json` receipts. A receipt is not completion proof:
status/retirement state remains authoritative. Receipts never authorize startup
replay. Older relay state readers need no new registry/retirement schema, but new
recovery operations require the new deployed host frontend and policy.

## Acceptance and evidence

| Acceptance | Implementation | Evidence |
| --- | --- | --- |
| Per-target consent, stale target rejection | Frozen recovery preview and existing approval owner | Frontend and approval tests |
| Conflicts block; incomplete inspection disclosed | Read-only launcher observation | Python observer tests |
| Ordinary scheduling changes do not invalidate process identity | Compare birth and parent, not volatile non-zombie state | Scheduling-transition regression through manual preview and legacy evidence capture |
| PID reuse, parent changes, disappearance and zombie transitions remain fenced | Retain identity/ancestry and zombie-read-branch checks | Observer race and stable-zombie tests |
| Room/generations/history/queue retained; nonce fenced | Existing atomic legacy migration commit | Registry and recovery tests |
| Retirement remains terminal; account effects independent | Exact stop-effect completion only | Retirement recovery tests |
| Operator attestation is not exit verification | Private audit receipt before commit | Recovery interruption tests |
| No implicit replay or launch | Explicit apply only; startup ignores audit receipts | Retry tests |

## Crash boundaries

| Boundary | Durable state | Retry |
| --- | --- | --- |
| Preview/consent | Existing expiring frozen approval | Fresh preview after restart; never auto-apply |
| Observation before audit | No mutation | Repeat all conflict checks |
| Audit write before metadata commit | Operator attestation, not completion proof | New consent and checks; no startup replay |
| Live atomic commit | Stale window and old nonce cleared together | Status shows cleared metadata; ordinary start is separate |
| Retired stop-effect commit | Terminal retirement retained; only stop effect done | Independent account effects continue through existing worker |

## Ownership and deployment

Harness recovery, observer, approval presentation, diagnostics, tests and runbook
belong to #128. Launcher picker labels are owned by nix-dotfiles, not this repo;
the downstream picker label and full-ID display change is implemented in
`nix-dotfiles/modules/cli/tmux/tmux-project-go/picker.go` with focused Go tests. Grill/NAS rebuilds, NAS
acknowledgements and individual live recovery are deployment-only acceptance.
No Nix evaluation/build or live mutation is authorized during implementation.

## Scheduling-state correction (2026-10-29)

Staging recovery exposed a false rejection when the relay changed from sleeping
(`S`) to running (`R`) during inspection with identical PID/start time and parent.
The observer now ignores ordinary scheduling-state differences, retaining all
identity, parent, and zombie-transition checks. This changes only read-only
observation before the audit boundary; no retry, consent, or commit policy changes.

Regression tests failed on the old comparison and pass with the fix: 13 Python
observer tests and 43 affected Node tests, no skips. No LSP errors or diff errors.
Canonical Nix/package checks remain deferred under the no-build constraint; the
operator rebuild and a fresh staging recovery approval are separate acceptance.

## Original implementation verification and review (2026-10-28)

- TypeScript test compilation passed with the existing local toolchain.
- Affected Node suites: **217 passed, 7 packaged integration skips**, zero failures.
  That historical run included 10 Python observer tests; the scheduling-state
  correction above expands the current suite to 13.
- Downstream nix-dotfiles picker: **15 top-level Go tests passed, zero skips**,
  including disposable private-tmux/fzf fixtures; gofmt and diff checks passed.
- LSP: no compilation errors. External Go files are outside the active workspace;
  Go tests provide their compiler check. The existing settings-schema URL returns
  404; one existing TypeScript async-style hint remains.
- Both review axes inspected the pinned harness snapshot. Standards: no findings.
  Spec: medium/current-issue finding that `adopted` promotion still represents
  unfinished lifecycle work. Fixed by rejecting every non-null promotion in manual
  preview and atomic commit; regression passed in the final affected run.
- Canonical `nix run .#verify`, package/module checks and production builds were
  **not run**, per the explicit no-Nix-evaluation/build constraint. Live Grill/NAS
  activation, acknowledgements and original-room recovery remain unverified.

Local evidence: `.pi/tmp/workers/2026-10-28T07-53-39-839Z-manual-recovery-final-76cfdfb1f328/`,
`.pi/tmp/workers/2026-10-28T07-53-39-839Z-picker-final-6b9abcd37e21/`,
and `.pi/tmp/reviews/2026-10-28T07-50-08-671Z-worktree-91515da27014-0ab708115bab/`.
These local artifacts are not deployment evidence.

Do not retire nix-dotfiles. Preserve its original conversation and resume its
current generation only after recovery. Other legacy conversations remain
untouched. Unreadable observations are disclosed uncertainty, never proof of
absence; approval asserts that the operator closed the old Pi and accepts that
inspection limitation. Detected conflicts always block.
