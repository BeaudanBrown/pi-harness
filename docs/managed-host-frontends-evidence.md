# Unified host frontends (#113)

## Scope and acceptance plan

The dispatcher, per-tool approval runtime, exact lifecycle owners and NAS account
ports are implemented foundations. This issue exposes them without introducing
another authority or compatibility bypass. No push, deployment, activation,
service restart or personal-account traffic is authorized.

| Acceptance | Implementation seam | Planned evidence |
|---|---|---|
| One compact provider-compatible model tool | Flat `managed_host` schema; strict operation validation; native live run/tool identity | Schema/provider checks and real-Pi fake-relay tests |
| All model mutations individually approved | Existing authenticated adapter host request and approval dispatcher | Approval routing, denied/coordinator/self-close cases |
| Human terminal/Matrix/CLI controls | Shared parsing and policy-governed human mutation owner | Confirmed/destructive vs direct launch/stop; forged participants |
| Room-local start/close and existing controls | Prompt/control classification and durable intake | No prompt on start; exact confirmed retirement; retained controls |
| Frozen bulk scopes | Existing preview and exact owner revalidation | Active targets, one confirmation, changed-set refusal |
| Neutral protected coordinator | Narrow tool allowlist and explicit membership recovery | Exact profile resources and forbidden stop/delete |
| Legacy retirement aliases and capability checks | Route aliases through the same dispatcher; document removed tool names | No legacy lifecycle mutation bypass; status wrapper regressions |

Continuity, title/status enhancements, automatic launch enrollment, legacy
migration and picker/deployment/live acceptance remain #114–#121. Existing
same-Unix-user shell authority is not a sandbox.

## Crash and concurrency plan

| Boundary | Required recovery |
|---|---|
| Model call before/after consent | Existing live-tool attestation; no completed-action replay |
| Human Matrix command intake/cursor | Persist attempt boundary before effects; no mutation replay after uncertainty |
| Human preview before apply | Exact saved scope and current authority rechecked by existing owners |
| Self-stop/retirement before response | Terminal ownership wins; never relaunch to deliver a result |
| Client timeout/disconnect | Report uncertainty; never silently retry mutation |
| Local slash command | Fixed same-user socket; no model-provided actor or presentation route |

## Implemented frontends and migration

Both managed project and neutral coordinator adapters register `managed_host`,
with a flat provider schema and strict backend operation validation. Native Pi
run/tool identity is attached outside model parameters. `remote_session_delete`
is retained only as an alias to the same independently approved canonical
retirement. Other `remote_workspace_*`, `remote_project_*`, `remote_worktree_*`
and `remote_session_*` lifecycle tool names are replaced by `managed_host`.
Older lifecycle mutation wire paths stay refused, not silently translated around
approval. Adapters require negotiated `host-control-v1` and `approval-v1`;
coordinate relay/adapter upgrades rather than bypassing capability errors.

The coordinator loads only its narrow host tools and `managed-host` skill; it
has no engineering tools or project resource discovery. Local-LLM managed project
policy retains these typed controls without enabling worker/model delegation.
The existing inventory/open owners expose the protected coordinator; picker UI
and originating-client handoff remain #118/#119.

Direct human CLI and `/host` calls use the same dispatcher policy and frozen
mutation owner as approved models. Examples:

- `/host conversation list`
- `/host conversation open conv_<exact-32-hex-id>`
- `/host conversation delete conv_<exact-32-hex-id> --confirmed`
- `/host coordinator membership restore --confirmed`
- `pi-managed-session conversation delete conv_<exact-32-hex-id> --confirmed`

CLI `delete`/`close <id> --confirm` aliases also use canonical retirement. The
existing status wrapper is unchanged. Commands parse quotes and escapes as
arguments, not a shell; they never execute arbitrary strings.

In Matrix, use `!host` followed by the same command grammar, `!start` (ready
resume without a prompt), `!stop`, or `!close --confirm`. Only the configured
operator can invoke these host commands. Other participants retain ordinary
conversation/runtime-control participation, not host authority. Matrix `/host`
is intercepted as Matrix authority; the adapter additionally refuses a delivered
`/host` from an older relay instead of dispatching it as a local operator command.
Existing model/thinking/compaction/reset and abort/steer controls remain. There is
no `!notify`.

A private, bounded journal consumes human Matrix event IDs before effects. It
stores neither model action receipts nor results and never automatically retries
an uncertain mutation. After a lost reply, inspect state and send a fresh explicit
command if appropriate. The 8,192-entry journal fails closed at capacity and
requires explicit recovery; do not delete it to make old commands replayable.
Slow effects do not hold its intake lane; shutdown drains admitted work before
closing mutation owners. Retirement stops further events/wakes in that room.

## Verification in progress

First broader affected packaged checks passed **459 managed-session tests, zero
skips**, plus unit, source and module contracts:
`.pi/tmp/workers/2026-10-05T06-04-44-434Z-host-frontends-affected-recheck-d947a82f97f1/`.
These include real Pi SDK/fake-relay tool execution for both roles and the
retirement alias, real Unix IPC approval/self-retirement coverage, Matrix slash
origin isolation, exact provider schema/allowlists and durable command replay
refusal. Earlier ad-hoc checks lacking SDK environment skipped two tests; those
are not the final packaged evidence. NAS builder SSH was unavailable; local Nix
fallback succeeded. Additional focused and final checks/review remain pending.
No live Matrix, phone, launcher deployment or service activation is claimed.

Final pre-review checks passed **462 managed-session tests, zero skips**, plus
unit/source/module contracts:
`.pi/tmp/workers/2026-10-05T06-26-47-922Z-host-frontends-reviewed-input-checks-0b0ff4998d10/`.
The focused real SDK run passed **9 tests, zero skips**, including actual Unix
socket `/host` command invocation without starting a model turn:
`.pi/tmp/workers/2026-10-05T06-19-51-636Z-host-command-native-final-565e405a4665/`.
Matrix previews exceeding the display bound now show neither partial targets nor
an apply token; callers must request a smaller preview or use the local CLI.

## Review disposition

Exhaustive issue audit at `8c3d101`:
`.pi/tmp/reviews/2026-10-05T06-29-20-976Z-audit-8c3d101b0279-3a55a4d71be7/`.

- **Standards:** one low/current-issue finding. Malformed operator commands now
  consume their event IDs before any error/help reply; a lost reply cannot cause
  another effect after restart.
- **Spec:** two medium/current-issue findings. Coordinator cleanup/deletion
  previews are now free reads returning explicit blockers and the protected
  target, while all destructive apply paths reject the blocked scope without
  executing a nonprotected subset. Known worker/model-delegation tools are now
  rejected even in explicit local-model configuration (including programmatic
  configuration), not merely excluded from defaults.

All three findings were accepted and remediated in one batch. Focused checks
passed **28 tests, zero skips**:
`.pi/tmp/workers/2026-10-05T06-36-55-179Z-host-frontends-review-remediation-bab9777d2a67/`.
These are bounded corrections to the reviewed design, not a new review boundary.
Final canonical verification remains pending.
