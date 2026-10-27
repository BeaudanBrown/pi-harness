# Cumulative review and isolated smoke-test staging (#121)

**Subsequent live result:** the operator provided dedicated test accounts and
explicitly authorized the test. Its initial room-v12 bootstrap failure was fixed;
the bounded native-launch/hierarchy/account smoke now passes after same-state
recovery. See [remediation evidence](managed-room-v12-evidence.md) and the
[initial live failure](managed-live-workspaces-live-smoke.md). The offline evidence
below is historical; broader client/deployment acceptance remains outstanding.

**Step-1 follow-up:** separately authorized real-model commentary/final,
approvals (including actual expiry), fork/tree/guards, stop/resume and retirement
acceptance now passes. Two live-discovered fixes and review remediations passed
the final canonical gate. See [behavior evidence](managed-live-behavior-evidence.md).
Desktop/Element X, publication/lock, activation and migration remain separate.

## Original offline-slice authorization

The operator approved proceeding through cumulative offline review, candidate
package verification and an isolated smoke test without rebuilding/activating a
host. No system switch, production/shared-tmux restart, production-account traffic,
existing-chat migration, push or destructive cleanup is authorized. Candidate
package builds are distinct from host/system builds. The external package-lock
boundary in #120 remains open; offline review can proceed without resolving it.

At this original staging checkpoint, only production identity metadata had been provided. It is **not** test
account provisioning or permission to reuse the production owner token. Before
any real Matrix smoke traffic, require dedicated disposable owner and bot logins,
a confirmed homeserver and private test-only credential provisioning. Do not
inspect SOPS/private secrets or improvise with existing credentials. Client
acceptance and old-room migration remain separate from this smoke test.

## Pinned cumulative scope

- Harness: `8b768ca..7580563`, covering the full epic implementation starting with
  #105/#104, not merely #120 documentation. Earlier queue-withdrawal foundation
  f9bab2b is outside this feature diff but retained in the base.
- Owning dotfiles: `c2a1ab8..6a7b294`, including exact process/window ownership,
  launch/focus, picker, staged host configuration and the candidate-build fix below.
  Immutable archive: `/tmp/pi-live-epic-review-kMJb2g`.
- Follow-up: harness `99f5941` fixes the sole actionable cumulative finding;
  both review axes cleared its production-wiring regression and implementation.
  Dotfiles then advanced the requested (still unpublished/unlocked) source pin to
  `99f59415a6564afe23a454244da7726b2b68a43f`; source checks and syntax parsing passed.
- Prior leaf reviews/evidence do not substitute for this cumulative review.
  #111's individual review was deliberately omitted and is not claimed otherwise.

## Acceptance-to-evidence matrix

| Area | Existing offline evidence | Still required |
| --- | --- | --- |
| Identity/contracts/experiment defaults | Contract/schema/package and resource tests; #104/#105 evidence; cumulative review complete | No remaining offline review gate |
| Host/project/checkout/conversation hierarchy | Provenance, reservation, reconciliation and SDK enrollment tests; hierarchy evidence | Disposable real-room topology and later old-room acceptance |
| Host APIs and per-call consent | CLI/IPC/Matrix/model frontends, policy, expiry/denial/cancellation, native tool attestation suites | Real-client interaction and explicit approval UX |
| Retirement and cleanup | Exact process/window, tombstones, no-resurrection and ownership-fenced cleanup tests | Disposable live retirement only, no existing-room cleanup |
| Window-first open / coordinator | Concurrent launch, retained failure/retry, terminal/client fencing, real disposable tmux package tests | Full isolated relay-to-Pi composition smoke |
| Commentary/final/attention projection | SDK persistence, frozen dispositions, catch-up and recovery alert tests | Real Matrix payloads; phone/OS push delivery cannot be guaranteed |
| NAS account automation | Dedicated worker, authenticated scope, preserved notification rules, durable receipts tests | Dedicated test owner/bot credentials and real Matrix acceptance |
| Generations/navigation/status | Split/fork/tree/switch, single-writer, hierarchy/status/title tests | Interactive desktop/Element X acceptance |
| Automatic launch / local-only | Packaged SDK/PTY/native parser and local-only tests | Exact candidate dispatcher/profile wiring in isolated smoke |
| Hierarchy migration | Interrupted legacy/current journals, scope freezes, preserved rules/tombstones | Separately confirmed production preview/migration, never implied by smoke |
| Unified progressive picker | 66 Go race tests; full Nix candidate checks; installed-wrapper private-tmux/fzf smoke | Live relay composition; packaged latency caveat below |
| GRILL/NAS configuration | Source checks and syntax parses; unchanged service seams | Resolved external lock and permitted actual host evaluation; no host build/switch here |
| Overall | Cumulative paired review and remediation complete; final canonical 12 gates and production packages passed | Real Matrix smoke, client acceptance and deployment/lock boundaries |

## Persistence/external-effect boundaries

| Boundary | Durable authority / recovery requirement | Smoke isolation |
| --- | --- | --- |
| Enrollment/admission | Save immutable identity before effects; uncertainty is not replay permission | Fresh checkout and private manifest/session roots |
| Matrix room accepted before receipt | Recover same attested reservation/alias; never guess/adopt foreign room | Dedicated bot/owner; record every test room ID |
| Tool approval | Exact live call and frozen scope; expiry/cancellation cannot revive | Test conversations only, no production authority |
| Launch/focus/stop | Exact process birth and stable target/client; preserve unproven/failed panes | Private tmux socket, owned process handles only |
| Inbox/projection | Persist before cursor, stable transaction IDs, no fabricated SDK entries | Empty test inbox and history; no copied production transcripts |
| Account join/rules/leave | Journal fixed account/device/room scope; preserve manual settings | Never use the supplied production owner/device for smoke |
| Generation transitions | One writer and scoped prepared/committed/cancelled history boundary | Independent test histories; no shared HOME/session paths |
| Retirement | Tombstone before retryable exact cleanup; no resurrection | No bulk cleanup; retain uncertain test-room inventory for operator |
| Migration | Freeze scope; new links before grouping commit before old-link removal | Old-room migration not authorized by this test |
| Exit/restart | Kill only owned test processes; accepted durable work is not UI cancellation | Never systemctl/restart shared server; retain evidence on failure |

## Smoke prerequisites and non-goals

Use explicit private HOME/XDG/agent/session/state paths and a separate tmux socket.
Do not inherit production Matrix/model credentials, managed authority, profile
settings, SSH agent or global Pi resources. The bot must be non-admin and the test
owner a different account from the real owner (another device on the same owner
account does not isolate joins or push rules). Token files must be private and
never appear in argv/logs/Git. Validate whoami against explicit expected test MXIDs
and device IDs before creating rooms. Test messages must contain no private repo
content. Stop on identity mismatch; do not retry through production transports.

Candidate binaries should be invoked from immutable store paths, not installed
profiles. Build the picker from its package expression with a public, selected
nixpkgs input where possible, avoiding the fleet's private secret input. Such a
standalone package build is not full NixOS configuration evaluation. Record actual
resolved dependency versions and keep the unresolved fleet lock caveat visible.

No VM, local homeserver deployment or production-account provisioning is implicitly
approved as a workaround for missing test identities.

## Candidate build and local smoke results

The first real candidate Nix package build failed; direct Go tests had missed a
service-environment condition. Without UTF-8 locale or a TMUX environment hint,
tmux rewrites tab-separated fields and Unicode to underscores. A production
transport regression reproduced `ascii_exact__` instead of the expected fields.
Explicit `-u` now preserves machine encoding in the common transport and combined
inventory command. Tests also use actual interpreter paths for generated scripts:
Nix's sandbox lacks /usr/bin/env, and patchShebangs cannot rewrite Go string literals.
No test was disabled or skipped to obtain a successful build.

Full candidate package build/check: **66 top-level tests, zero skips**, including
real terminal/tmux/fzf cases. Output:
`/nix/store/vhdwssijypi581g24vgm94m2fsfjd2k3-tmux_project-0.1.0`.
Final candidate artifact:
`.pi/tmp/workers/2026-10-10T06-22-56-273Z-managed-smoke-controlled-shell-candidate-5d0488e6b53c/`.
This imports the actual owning package expression with the harness's public
nixpkgs; it neither imports the fleet/private secret graph nor builds a host.

The installed Nix wrapper passed the actual private-server popup fixture,
including identity/query retention, duplicate removal, cache refresh and early
cancellation. Its final measured keypress→UI was roughly **174–224ms**, slower
than direct-binary timings. Targets remain unmet in packaged scenarios; do not
claim 35ms packaged latency from direct Go fixtures. Cold/warm/error distributions
are retained in the final candidate log (OS cache uncontrolled). This smoke uses a
private fake public-host socket; **real relay/account/Matrix acceptance has not run**.

Earlier full-build/smoke artifacts `...05-55-41...` / `...05-57-30...` produced
`kw69i1nrnxabs8g9qnwkc7ahxl71n204` and roughly 205–314ms timings, now superseded.
A subsequent clean-environment attempt failed:
`.pi/tmp/workers/2026-10-10T06-20-11-190Z-managed-smoke-installed-picker-cleanenv-74519f21cb42/`.
With no SHELL, tmux used the host login-shell fallback; the UI appeared but not in
the expected private temporary namespace. The fixture now explicitly resolves a
POSIX shell and constructs an environment allowlist with private HOME/XDG paths.
It does not inherit Matrix/model credentials, agent settings, shell startup hooks,
SSH agent or managed roots. Starting the final installed smoke with **PATH only**
then passed all existing assertions, without removing any assertion or test.
External commits: `95e811f` (isolation fixture) and `132c3d9` (reviewed source pin).


## Cumulative review, remediation and final offline evidence

Both agents inspected the full harness scope and the pinned owning dotfiles
archive. Report:
`.pi/tmp/reviews/2026-10-10T06-00-14-581Z-worktree-d42975e31e03-00a6be01f062/`.
Standards found no actionable source violation. Its high deployment-only finding
is the explicit unresolved publication/lock boundary, retained rather than hidden.

Spec found one **high / current-epic** defect: production `main.ts` dropped
`conversation.open.expectedGenerationId` when connecting dispatcher to lifecycle.
The lifecycle's own checks were correct, but direct tests had bypassed that seam.
The production control-socket regression now observes the real method arguments
and calls the real lifecycle, rather than replacing its implementation. It failed
with an undefined fence before the fix, then passed. The callback now uses the
shared inferred action type and forwards the fence; resume is unchanged.

- Red: `.pi/tmp/workers/2026-10-10T06-04-53-260Z-cumulative-open-fence-regression-red-51adbc3ae1f8/`.
- Green/affected: `.pi/tmp/workers/2026-10-10T06-09-05-730Z-cumulative-open-fence-remediation-affected-cfcf496b852a/`.
- Both remediation reviewers: **no findings**,
  `.pi/tmp/reviews/2026-10-10T06-11-58-952Z-worktree-c0cc781825b9-533c756d9275/`.

Initial post-review gate (before the fixture isolation follow-up):
`.pi/tmp/workers/2026-10-10T06-14-23-193Z-managed-staging-final-offline-gate-9fea9fd06207/`.
Passed 66 direct Go race tests (zero skips), 46 fixtures against the production
TypeBox parser, seven integration source assertions, six syntax-only Nix parses,
all 12 canonical harness gates, and default/relay production package builds.
Packaged managed tests: 566; bridge: 87; package contracts: 13+17, zero skips.
Twelve SDK-dependent skips in an earlier ad-hoc focused Node invocation were
superseded by the full packaged zero-skip run. TypeScript LSP was clean; external
Go LSP only reported no active workspace build, so actual compiler/race/package
checks, not that warning, provide Go verification. The external fixture isolation
change followed this gate; the complete candidate build/smoke was repeated as
recorded above. Final offline verification is recorded below.

Final follow-up review of `6a7b294..132c3d9`:
`.pi/tmp/reviews/2026-10-10T06-25-27-007Z-worktree-f81cfc2aed18-9e9da3435443/`.
Standards found no isolation/assertion weakness and retained the high deployment-
only unresolved-lock deferral. Spec found one **medium / current-issue evidence**
error: this document still described the earlier smoke and incorrectly claimed
only prose changed after the initial gate. Accepted and corrected above with the
actual fixture change, failed attempt, final package/log/timings and separate
verification boundaries. It is not treated as a source-code defect or ignored.

### Final verification after the isolation follow-up

Passed again after all source/test changes and both follow-up reviews:
`.pi/tmp/workers/2026-10-10T06-27-38-103Z-managed-staging-final-post-isolation-gate-703ae4139d45/`.
All 66 Go race tests (zero skips), 46 production schema fixtures, seven source
checks, six syntax-only Nix parses, all 12 harness canonical gates and default/
relay packages passed. Managed 566, bridge 87 and package 13+17 tests passed
without skips. Only this final evidence/handoff prose was added afterward.

## Remaining boundary

Offline cumulative review, candidate build and installed-picker smoke are done.
No real-account smoke, desktop/Element X acceptance, fleet evaluation/build,
publication/lock refresh, activation or existing-room migration is claimed.
#120 and #121 remain open. The operator subsequently supplied dedicated test
identities and private credential paths. Room-v12 remediation and the bounded
same-state recovery/retest now pass; see the evidence linked above. Remaining
work is broader client acceptance and separately authorized integration/rollout,
not credential provisioning or repetition of the original failed bootstrap.
Never fall back to production identities or inspect the private secrets repository.
