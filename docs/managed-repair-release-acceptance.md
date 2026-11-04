# Unified repair: cumulative acceptance and release boundary (#151)

## Scope and preflight

This issue verifies epic #146 cumulatively from published baseline
`327130d264794a2c1fcb0b9f4d22e78d2a88093e`. Children #147–150 are implemented;
#150 was approved closed at local commit `99e2600bfdf07aad4cdb3ecb76df6ccbca59b978`.
The operator's correction controls: repair requires **no queue-management choices**.
Preservation is automatic; optional future resumption/abandonment requires separate
consent. No test is evidence that a real conversation is currently healthy.

Current issue: real durable-owner composition tests, six-incident acceptance,
crash/uncertainty and compatibility evidence, cumulative Standards/Spec review,
canonical verification and actual production builds. Release, downstream pinning,
activation and per-target live effects remain separately approved. No new lifecycle
behavior or general session manager is authorized. All existing NAS retired flags
remain terminal, including flags originally caused by voluntary departure.

## Acceptance-to-evidence matrix

| Criterion / incident | Evidence |
| --- | --- |
| Sandbox unobserved launch | real registry/runtime owner, saved history and monotonic launch identity; no launcher invocation |
| Epic644 unobserved launch | independent second target/creation identity, same shared owner invariants |
| Protected coordinator legacy runtime | same durable orchestration/account path, explicit closure, unchanged identity; destructive policy still rejects deletion |
| Pi-harness output backlog | repair holds old output without replay; separately approved resumption uses original transaction/payload |
| Timeline inaccessible original | host account client + NAS SQLite store/worker + shared repair owner; exact original-room invite/join only when nonterminal |
| ihp-update inaccessible original | independent second room; NAS terminal variant produces zero invitation/join and no replacement |
| Permission/identity boundaries | real frontend schemas/policy and existing mutation approval tests; foreign/unknown/ban and missing NAS capability cases |
| Crash and uncertain effects | existing #148–150 fault-injection suites plus cross-owner transport/restart checks; no startup approval replay |
| Negative authority | archive/retirement rollback and NAS terminal tests across durable stores |
| Compatibility | old records readable; new actions strict; capabilities conditional; unknown NAS support blocks before effects; explicit rollout/rollback limits |
| Release readiness | cumulative two-axis review, canonical 12 gates, actual relay and bridge builds |

## Crash/uncertainty matrix

| Boundary | Durable evidence | Required recovery |
| --- | --- | --- |
| Preview/read-only NAS inspection | bounded pending probe and frozen proof | no positive effects; fresh preview after ack/expiry |
| Host repair admission | registry receipt + preserved item holds | uncertain commit poisons until reload; no automatic continuation |
| NAS admission | exact operation/departure and admission bit | invite forbidden without observed positive admission |
| Host invitation | pre-HTTP attempt receipt | lost reply reconciles actual event, never blind duplicate |
| NAS join | pre-HTTP attempt and actual member event | host confirms exact joined event before completion |
| Runtime reconciliation | trusted saved-session/process proof + receipt/high-water | no nonce/window clearing as exit proof, no launch replay |
| Preservation cutover | general hold release with per-item holds retained | arrivals before cutover stay preserved |
| Optional queue resumption | exact-scope audit and permission commit | restart may retry only this separately approved durable output |
| Terminal state / rollback | independent host fences and NAS retired state | no repair can resurrect the original identity |

## Deployment and live acceptance plan (not authorization)

1. Obtain separate publication and downstream-pin approval. Publish the reviewed
   cumulative commit and pin the exact revision; do not bundle unrelated dotfiles.
2. Obtain activation approval. The operator rebuilds NAS and Grill, not the agent.
   This release changes both host and NAS protocol/storage. Activate NAS support
   before using host repair; verify exact-room `original-room-repair-v1` evidence.
   Missing capability is a blocker, never permission for a legacy bypass.
3. Refresh managed adapters/tool schemas before using the new operations. Old
   adapters do not gain operations merely because the relay advertises them.
   Baseline `327130d` uses a strict `LIVE_WORKSPACE_CAPABILITIES` enum: its
   `host.status` decoder can reject newly advertised repair capabilities. Do not
   use a failed old status decode as proof of relay failure or retry a mutation.
   The existing typed refresh/native operator path remains the upgrade path;
   no raw registry/CLI bypass by the model. Confirm the new tool schema and host
   capabilities after refresh. This is a coordinated upgrade, not a promise that
   old frontend decoders understand new capabilities.
4. Preserve private state backups with appropriate access controls. Old binaries
   are not promised to read newly written repair/queue fields or account intents.
   Registry rollback is not supported undo/replay authorization. Do not roll NAS
   back across admitted membership repair: old code cannot honor the new protocol.
   Use a compatible corrective deployment, not manual clearing of terminal flags.
5. Read fresh per-target runtime, process and original-room evidence. Do not reuse
   the historical incident identities' old session/generation observations as
   current facts. NAS-retired originals are non-restorable; no replacement rooms.
6. Request independent typed-tool approval for each repair. Obtain any genuinely
   required closure/inspection assertions explicitly. Repair neither stops nor
   opens Pi. Observe receipt phase, original membership and queue preservation.
7. If running Pi is desired, obtain separate normal open/resume consent and verify
   attachment/current runtime. Only if the operator wants old preserved work
   attempted or abandoned, request the separate queue action. There is no required
   queue-management choice in the repair flow.
8. Record each live outcome separately: runtime, access, preserved backlog,
   uncertainty/external obligations. Never infer fleet readiness from unit tests.

## Compatibility evidence and limits

- The existing persistence tests read pre-repair registry/account records with
  optional new fields absent. This is forward reading, not a downgrade guarantee.
- Strict repair schemas reject queue-choice fields and arbitrary targets; shared
  tool, Matrix-command and CLI grammar plus durable model-approval round-trip are
  exercised in `managed-session-repair-acceptance.test.ts`.
- Missing/older NAS support produces only an inspection obligation; real host and
  NAS owners perform no invitation/join or runtime mutation in that case.
- Published baseline capability enum is pinned in
  `327130d:config/agent/extensions/managed-sessions/live-workspace-contracts.ts`.
  New capability names are intentionally absent there. Coordinated frontend
  refresh is a deployment obligation, not claimed backward response compatibility.
- Current manifests are structurally unchanged and original history is compared
  byte-for-byte after all six scenarios. Real host account journal and NAS SQLite store/worker are
  composed; only Matrix and process observation ports are fake. No real launcher
  exists in the orchestration test path.

## Results

Focused cumulative affected checks passed **174 tests**, zero failures/skips,
including **11 new cross-owner acceptance tests**. Evidence:
`.pi/tmp/workers/2026-11-04T06-25-16-338Z-repair-epic-affected-evidence-9559f9369f16/command.log`.
The initial fixture incorrectly put coordinator-only `hostSpace` on project
manifests; strict parsing rejected it, the fixture was corrected, and all cases
then passed without production changes.

Mandatory cumulative Standards/Spec review covered the full epic from the
published baseline, not only the newest tests. Both axes reported no verified
findings. Pinned evidence:
`.pi/tmp/reviews/2026-11-04T06-29-14-948Z-worktree-a9ddaeb203b6-de4a882f3b2d/`.
No remediation or expansion of production behavior was required by #151.

Final `nix run --option builders '' .#verify` passed all **12 canonical gates**;
**806 managed / 135 unit / 98 bridge tests**, zero failures/skips. The same
invocation then successfully built actual `.#managed-session-relay` and
`.#bridge-chat` packages with `nix build --option builders '' --no-link`.
Only the optional remote builder was disabled. Evidence:
`.pi/tmp/workers/2026-11-04T06-35-59-989Z-repair-epic-final-release-gates-b67115d42ea2/command.log`;
per-suite totals are in the corresponding Nix derivation logs. LSP reports no
errors/warnings (only the existing async-conversion hint in `host-lifecycle.ts`).
Only this evidence prose changed after the final gate.

No publication, activation, real-room repair, process signal or live acceptance
has been performed. The implementation is release-ready, not fleet-accepted.
