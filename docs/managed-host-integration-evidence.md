# #120 — GRILL/NAS source configuration handoff

Status: source changes, affected checks, paired review and final harness gate complete.
Owning implementation commit: `a210735` (after preflight `2563c4d`).
The issue remains open at an explicit package publication/lock-resolution boundary.
No external dotfiles Nix evaluation/build, push, activation, shared-tmux/service
restart, live Matrix/client traffic or secret access occurred.

## Scope and acceptance

Operator approved source-only #120 configuration/package/keybinding changes and
local commits in `/home/beau/documents/nix-dotfiles-managed-live-workspaces`.
The operator then supplied existing-token whoami results (no tokens): owner
`@beau:matrix.bepis.lol` / `PXZRSYBGDY`, NAS bot / `LKVMVRCIUY`, GRILL bot /
`PI_GRILL_RELAY`. These complete the missing public identity inputs.

| Acceptance | Source implementation | Evidence / remaining limit |
| --- | --- | --- |
| Harness and picker packages, roots/host IDs | Exact requested harness ec7dda83ab344283aab9c35e177cc6ba02f7cfe9; one existing picker derivation; configured roots/host names retained | Source assertions; publication and real lock resolution still blocked by authorization |
| NAS deterministic account work | Both relays address owner device; NAS exact host/bot/device allowlist uses existing dedicated token reference | Source assertions plus packaged account tests; no credential access or live acceptance |
| Normal/local-only/experimental separation | Explicit default-off Pi-R/AgentGraph; pi-local -> pi-r-local unchanged; upstream pi-local-only remains distinct | Source assertions and packaged launcher/resource tests |
| Central approval/read policy | Empty overrides preserve every model mutation's approval and read-free defaults | JSON/source checks plus packaged policy tests |
| Preserve existing ownership/services | Runtime retention explicit; shared-server guard, coordinator protection, narrow NNP override, assistant/file grants and requester keybinding unchanged | Scoped source diff, source checks, 65 direct Go race tests |
| Compatibility/migration/rollback | Owning specs/managed-live-workspaces.md records consumer/relay/adapter order, preserved state, explicit preview/confirmation and unsupported downgrade | Source cross-check against harness contracts; no activation or migration |

## Deliberate unresolved package boundary

The external flake requests the verified harness ec7dda8, but that revision is
local/unpublished and its existing lock still records 1604a971d5990e520399186de7dd90a7071dca65.
This is **not a resolved, buildable deployment configuration**. No hash was
invented and no external input graph was evaluated/fetched. Publication and lock
resolution need separate authorization, followed by real GRILL/NAS evaluation and
build permission. Cumulative review may require selecting a later reviewed harness
revision. Do not close the integration/deployment boundary merely because source
assertions pass. #121 cumulative/client acceptance also remains outstanding.

## Review disposition

Paired review inspected immutable external `2563c4d..a210735` at
`/tmp/pi-host-config-review-jUR1pT` alongside this harness evidence. The first
invocation returned no report and was retried unchanged for tool failure, not a
routine second review cycle. Successful report:
`.pi/tmp/reviews/2026-10-09T06-31-16-951Z-worktree-2029b59f4515-52b2a67f4dad/`.

- **Standards:** no standards violations; package/lock boundary reported as
  **high / justified deferral**. Accepted as an explicit authorization boundary,
  not silently fixed by publishing or inventing a hash. It remains unresolved.
- **Spec:** no findings; exact identities and preserved seams confirmed. The
  partial package readiness and staged acceptance limitations are explicit.

No current source remediation was requested. This individual-issue review is
not the mandatory cumulative epic review owned by #121.

## Side-effect and recovery boundaries

Source edits have no account/runtime effects. Future activation can consume account
work, so staged config is not permission to run it. Exact device identities bind
existing journals: changing logins requires explicit recovery. Preserve registry,
manifest, histories, hierarchy, account/retirement state, journals and receipts as
one backup boundary; never resurrect active state without newer tombstones.
Guarded relay replacement must not kill or adopt a foreign shared server. Loaded
busy adapters retain pinned runtimes; no automatic ordinary-session adoption or
forced refresh. Existing-room migration needs fresh scope and consent after
interruption. Legacy receipts are evidence, not destructive authority.

## Checks before review

- Seven source configuration checks passed using the owning Python checker.
- Six affected Nix files parsed as syntax only via `nix-instantiate --parse`.
  Parsing is not NixOS option evaluation or package realization.
- External direct Go race suite: 65 top-level tests, zero skips; only disposable
  tmux/PTY/fzf and private public-protocol fixtures.
- Initial ad-hoc Node run: 30 pass,12 skipped for absent SDK/launcher environment.
  Superseded by correctly configured **packaged harness** suites: managed566 and
  bridge87, zero skips. No skipped checks are counted as acceptance.
- Cached LSP diagnostics had no errors; external Go workspace warnings persist.
  No external Nix evaluator was started for diagnostics.

Artifacts under `.pi/tmp/workers/`:
- `2026-10-09T06-22-27-971Z-managed-host-config-source-focused-621bb96a642a/`
- `2026-10-09T06-22-52-635Z-managed-host-config-affected-dd4e8ae94728/`
- `2026-10-09T06-25-23-079Z-managed-host-config-packaged-affected-8c595ab5a669/`

Reproduce source checks with
`python3 modules/cli/pi-harness/check-managed-integration.py --harness-source <harness-checkout>`
from the owning repository. The exact real Nix package, generated service/policy
configuration and live Matrix/desktop/Element X behavior remain unverified under
the current source-only approval.

## Final gate and Git handoff

After review, seven source checks and six syntax parses passed again.
`nix run .#verify --option builders '' -L` passed all12 deterministic harness gates
(managed566, bridge87, package13+17, zero skips), and
`nix build .#default .#managed-session-relay --option builders '' --no-link -L`
passed for the **harness only**. Both worktrees passed `git diff --check`.
Artifact: `.pi/tmp/workers/2026-10-09T06-32-35-909Z-managed-host-config-final-canonical-a2467039c9d9/`.
Only final evidence/handoff prose changed after this gate.

The external implementation is locally committed as a210735; no code was pushed.
#120 stays open at the high/justified-deferral package publication/lock boundary.
Cumulative #121 review and separately authorized client acceptance are not claimed.
No running instance was changed.
