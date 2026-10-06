# Default managed launch evidence (#116)

Status: partial implementation; launch helpers and owned roomless registration
are tested, but launchers do not yet auto-enroll. #114 is complete. This issue owns new eligible
interactive launches and explicit resume, not adoption of already running
ordinary sessions. No push, deployment, activation, service restart,
live-account traffic or nix-dotfiles Nix evaluation/build is authorized.

## Ownership

- #116: SDK-backed launch/mode/session selection, trusted Git/root eligibility,
  managed fresh/resume integration, explicit `pi-local-only`, recursion/internal
  worker exclusion, and package/module regression evidence.
- #117: confirmed migration of existing Matrix hierarchy.
- #118/#119: dotfiles conversation picker and its discovery/latency behavior.
- #120: actual machine roots/identities/account configuration and alias rollout.
- #121: cumulative review and separately authorized live desktop/Element X checks.

`pi-local-only` means **no Matrix connection**, not the restricted local-model/R
worker profile. It must preserve normal engineering resources with experiments
still default-off. Dedicated `pi-r-local` stays separate.

## Approved scope: basic invocation, not general startup forwarding

The operator confirmed bare `pi` is their normal usage and approved avoiding
unnecessary forwarding complexity. Read-only source inspection of both
nix-dotfiles checkouts found bare Pi in the managed tmux launcher, a separate
base-package `LLM` scratch launcher, and `pi-local` through dedicated `pi-r-local`.
Preserve those separate paths; no dotfiles evaluation/build was run.

Automatic managed admission supports bare Pi and explicit saved-session
selection only. Startup prompts, resource/input-file overrides, model/title or
other startup overrides are refused before managed effects with `pi-local-only`
guidance, never silently dropped. Configured/project-discovered engineering
resources remain intact. This does not authorize a new general argv payload,
startup-prompt journal, or exception to host path authority. Selection is not
ownership proof, and cannot create a requested arbitrary managed session ID.

## Acceptance-to-evidence plan

| Acceptance | Intended seam | Required evidence |
| --- | --- | --- |
| Fresh human interactive launch is managed | Normal configured wrapper to existing host-owned lifecycle; a new creation identity per fresh launch | Packaged launcher and fake-host/real-SDK mode tests; many conversations in one checkout |
| Explicit resume reuses live exact target or dormant saved binding | Read-only SDK session resolution before opening a writable Pi session; existing exact-window/open authority | CLI/session flag matrix, active/dormant and concurrent resume, no second writer |
| Retired history resumes only under a new identity | Existing irreversible retirement authority plus explicit history resume boundary | Old conversation never revived, old file/history retained, no backfill |
| Git and linked-worktree eligibility only inside configured roots | Trusted host launcher/workspace resolver, not caller path assertions | Canonical cwd, nested cwd, validated linked worktree, symlink/ambiguous/non-Git/out-of-root cases |
| Preserve resources and trusted dispatch; no recursion | Package/module wrapper and existing managed dispatcher | Bare/resume admission, unsupported-override refusal, cwd/configured-resource preservation, inherited private PATH/identity, nested/internal invocations |
| Exclude SDK/review/diagnostic/eval/headless/experiments | Public Pi argument parsing and explicit internal dispatch/mode boundaries | Both packaged SDK and current SDK flag probes, workers/evals/RPC and deliberate managed RPC tests |
| Matrix/NAS outage keeps local relay-owned work running | Existing roomless local enrollment/provisioning retry, reused by launch owner | Local process/session survives failed setup; pending status and eventual catch-up without duplicate room/window |
| Local relay outage refuses eligible managed launch | Frontend reports failure with explicit local-only alternative | No silent fallback/new unmanaged writer; ineligible ordinary local invocation remains usable |
| Local-only creates/transmits no Matrix resources/messages | Separate entrypoint and pre-open/in-app saved-binding guards without Matrix connection | No host/Matrix mutation, bound resume refused, unbound history/fork usable |
| Existing sessions and experimental defaults unchanged | No background adoption, shared tmux changes or package activation | Promotion remains explicit; Pi-R/AgentGraph defaults and dedicated evaluation contracts pass |

## Crash/retry plan

| Boundary | Required authority and recovery evidence |
| --- | --- |
| Classification/session selection | Read-only until explicit eligible launch/resume selection; cancellation creates nothing |
| Fresh identity/session persistence | Stable launch attempt identity and durable owned native session before dispatch; never externally seed a live unflushed SDK manager |
| Local registration before Matrix setup | Relay-owned pending binding survives restart; existing provisioning journals retain uncertainty, no duplicate room |
| Exact window reservation/create | Reuse #110 single-launch identity, kernel process ownership, retained failed pane and manual retry rules |
| Caller disconnect after admission | Accepted attempt may finish; never blindly replay unknown mutation; inspect and retry explicitly |
| Resume/retirement race | Revalidate active identity/tombstone before launch, no stale saved-session writer or resurrection |
| Trusted dispatcher enters Pi | Ambient auto-enrollment cannot recursively re-enter; inherited PATH/worker environment cannot reuse a writer identity |
| Local-only saved-session switch | Inspect binding before SDK opens/copies a writable target; refuse active bound history without contacting Matrix |

## Initial source observations (not final design decisions)

- `nix/module.nix` currently installs the managed ordinary extension in the normal
  wrapper, but does not automatically enroll. Its separate managed dispatcher
  already owns explicit project/coordinator launch resources and falls back from
  inherited private PATH when no trusted role is present.
- `nix/package.nix` has ordinary and dedicated R/evaluation launchers, but no
  `pi-local-only` entrypoint. Keep the dedicated R attestation contract unchanged.
- Public SDK exports include `parseArgs`, `parseSessionEntries`, `SessionManager`
  and `SessionSelectorComponent`. Verify actual argument/session semantics on
  0.84.4 and 0.85.0 before choosing launcher plumbing; do not approximate them by
  shell argument injection or open a bound session just to inspect it.
- Trusted workspace identification/resolution already validates configured roots
  and linked Git identities. Explicit non-Git workspace support exists elsewhere;
  automatic eligibility must not silently expand that authority or remove it.
- Existing terminal enrollment can register a local pending binding and finish
  Matrix setup independently. Generic conversation start currently provisions
  Matrix before launching; blindly routing defaults through that path would not
  meet the outage requirement. Investigate reuse of local registration and exact
  launch primitives, not a second session manager.
- #114 deliberately rejected SDK persistence patching/native successor handoff.
  That decision still applies: pre-launch persistence must precede construction
  of the live SDK manager; no fabricated assistant response or private-field hack.

## SDK preflight evidence

Disposable public-API probe passed on both actual SDK **0.84.4** and **0.85.0**:
`.pi/tmp/workers/2026-10-06T03-11-17-878Z-default-launch-sdk-preflight-clean-resources-e9730a46e53d/`.
Eleven parser cases per version, read-only listing/filtering, and an assistant-free
standalone `SessionManager.forkFrom` check; no model/network call or real history
was used. Clear inherited `PI_PACKAGE_DIR` in version-comparison probes: it otherwise
misreports the older imported code as the parent process's SDK resource version.

Important actual semantics:

- `-r` / `--resume` selects through a picker; a following positional token is a
  prompt, **not** its session selector. `--session VALUE` is the explicit selector.
- `--fork VALUE` takes a source selector. `--session-id VALUE` is distinct; the CLI
  can resume an exact existing ID or create a new session with it, subject to its
  option-conflict checks. Do not conflate it with a fresh-only request.
- `--session=VALUE` is an extension/unknown flag in these parsers, not a session
  selector. `-- --print` is literal prompt text. Preserve parser distinctions.
- Native main treats `--mode text` with both terminals as interactive, whereas
  RPC/JSON, print and missing terminals are non-interactive. Mode eligibility
  needs actual resolved semantics, not a raw `--mode` substring check.
- Public session listing with a custom directory filters current-project results
  by cwd; `listAll(customDirectory)` includes other cwd values. Explicit file
  open uses saved header cwd; fork uses the requested target cwd. Resolve ownership
  and resources before constructing any writable SDK manager.
- Public standalone `forkFrom` writes a new file before returning even without an
  assistant entry, keeps the original untouched and preserves copied metadata's
  old session IDs. This is a possible **pre-launch history-copy** seam for #116,
  not native room-preserving `/fork` and not reversal of the #114 decision. Any
  use still needs fresh authority, atomic publication and no historical backfill.

## Partial implementation: invocation mode

`launch/mode.ts` classifies the public parser result without opening sessions or
contacting the relay. It excludes command/diagnostic, worker, headless, ephemeral
and experimental invocations, and keeps explicit local-only and intentional
managed dispatch separate. This helper is **not yet wired to launchers** and is
not an authentication boundary or a saved-session ownership guard.

TypeScript build and three focused tests passed on **each** SDK version with zero
skips: `.pi/tmp/workers/2026-10-06T03-18-19-322Z-default-launch-mode-sdk-focused-965c1bd38505/`.
Project LSP and staged diff checks were clean. This partial step has not run an
issue review or final canonical gate.

## Partial implementation: trusted automatic workspace classification

`workspace-identify-auto` in the existing packaged launcher is read-only and
reuses its existing trusted `workspace-resolve` validation. It admits only Git
checkouts that are real immediate children of a configured root, including
registered linked worktrees with the correct gitdir backlink. A nested checkout
is never mistaken for its parent. Nested named roots are disambiguated by the
actual checkout parent; duplicate matching root authorities fail closed. Missing
unrelated roots do not disable valid local checkouts. Non-Git/out-of-root results
are explicitly ineligible; a failed eligible-checkout proof is an error, not a
silent standalone fallback. Existing explicit non-Git operations are unchanged.

TypeScript and packaged shell validation passed. Four focused launch tests and
the existing project-create/trust confinement regression passed (five selected,
zero skips): `.pi/tmp/workers/2026-10-06T03-46-52-080Z-default-launch-workspace-affected-a4d6e3e73b56/`.
Fixtures covered literal cwd punctuation/spaces, linked and forged gitdir
pointers, nested checkouts, overlapping/duplicate roots, and unchanged explicit
non-Git behavior. The first check invocation selected a nonexistent flake package
attribute; corrected runs use `checks.x86_64-linux.managed-session-test-launcher`.
These are harness-packaged primitive tests, not a deployed external launcher or
end-to-end automatic launch. No launcher invokes automatic enrollment yet.

## Partial implementation: saved-history inspection

`launch/history.ts` inspects through the public parser without constructing a
writable manager. Malformed lines/headers cannot conceal authority. Current-ID
binding, pending-boundary, tree and unbound markers are conservatively treated as
managed evidence; an offline unbound marker alone cannot prove host release.
Genuine new-ID copies retain foreign-ID metadata without acquiring its authority.
This is **not yet a complete ownership guard**: callers must also validate owned
paths/identities and host state before any writable resume.

POSIX relative, absolute, tilde and file-URL path normalization agrees with the
public `SessionManager.open` API on disposable existing fixtures, whose bytes stay
unchanged. Production inspection does not open a writable manager. All six focused
tests passed on each SDK version, zero skips, with TypeScript/package checks:
`.pi/tmp/workers/2026-10-06T04-08-24-157Z-default-launch-history-sdk-focused-3c7f95089b49/`.

Further public seams observed, not yet integrated: `main(args)` can retain native
CLI execution after pre-open selection; `migrateSessionEntries` permits native
in-memory format migration before publishing a fresh owned file. No private SDK
field or persistence patch is needed. Argument rewriting must remain parser-backed
and preserve literal values and resources, including `--` and extension flags.

## Superseded prototype: parser-backed argument encoding

Before the operator narrowed scope, `launch/arguments.ts` exhaustively maps the pinned public argument type to a
canonical argument vector. It preserves literal values, repeated resource order,
file arguments, prompt text after `--`, and extension flag values; it does not
promise identical spelling/order of equivalent flags. Selection fields are
omitted for separate authoritative resolution; only the owner may supply the
fixed destination session. This encoder is not admission, storage, transport or
retry authority.

Managed encoding refuses command-line API keys without echoing their values,
noninteractive/metadata flags and parser diagnostics. It also refuses unknown
flags that collide with core options (for example `--session=...` or a missing
`--export` value): a bare re-emission could otherwise consume the owner's next
option. Local-only/native invocation policy remains separate. An empty export
value is classified like actual native main (not as an export operation), though
managed encoding still rejects that option.

All eight focused checks passed on each SDK version, zero skips, with TypeScript
and packaged helper validation:
`.pi/tmp/workers/2026-10-06T04-30-32-849Z-default-launch-argument-history-final-focused-7ed85aa40fd1/`.
The same pass tightened offline inspection: unknown binding schemas/versions
cannot prove a foreign scope. No issue review or final canonical gate yet.

## Partial implementation: basic argument admission

The generic encoder has been removed, not wired into a transport. Its replacement
`assertBasicManagedInvocation` accepts only bare invocation and resume-selection
fields from the public SDK parser. It rejects prompts, file inputs, unknown or
future options, credential/resource overrides, malformed selectors, conflicting
session-ID selection, and a custom directory for fresh owned storage. It never
echoes argument values, mutates the parser result, or forwards a startup argv.
Apply it to user arguments only, after candidate classification and before managed
effects; injected harness resources are not user overrides.

Eight focused helper checks passed on **each** actual SDK 0.84.4 and 0.85.0, zero
skips, with the packaged workspace helper:
`.pi/tmp/workers/2026-10-06T05-09-29-130Z-default-launch-basic-policy-complete-sdk-f410cb25ee5f/`.
An earlier run omitted the launcher environment and skipped one test on each SDK;
the complete rerun above supersedes it. These remain helper tests, not default
launch integration or live acceptance.

## Partial implementation: owned roomless launch admission

The existing registry now has `registerOwnedLocalConversation`, separate from
terminal-source enrollment. Its private `ownedLocalLaunch: true` origin is durable
and required before a roomless exact launch can reserve an identity. Absence is
not evidence of ownership; terminal promotion cannot be relabelled, and a
promotion must reach adopted state before an owned launch. Contradictory
terminal/coordinator origins fail persistence validation. This is an
operation-specific origin marker, not a model receipt or replay mechanism.

Tests prove one admitted concurrent launch, capable-only attachment while
roomless, duplicate-attachment refusal, reconnect through the existing restart
reconciliation, later Matrix completion preserving attachment/launch identity,
and missing/contradictory-origin refusal. The first broad run was 529/530: the new
fixture omitted `beginRestartReconciliation`; production attachment checks were
not weakened to fix it. Corrected focused registry/enrollment checks: 19 passed,
zero skips, `.pi/tmp/workers/2026-10-06T04-52-03-242Z-default-launch-owned-origin-focused-e7020511677b/`.

**Affected managed suite: 531 passed, zero skips**, including packaged relay and
existing promotion/coordinator/exact-window paths:
`.pi/tmp/workers/2026-10-06T04-53-50-763Z-default-launch-owned-origin-affected-102c67d32f26/`.
This is not the final canonical gate or a complete automatic-launch path. No #116
subjective review has run yet. Private-state compatibility/rollback must preserve
or refuse the new origin marker, never silently discard it.

## Partial implementation: roomless exact open/resume

Existing `HostLifecycle.openConversation` and `resumeConversation` now accept a
registered roomless owned seed, without waiting for Matrix or touching its client.
They reuse the existing exact-window reservation, window-first result and shared
readiness observer. Bound-only lifecycle operations remain bound-only. Early
admission refuses missing owned-origin authority before resolving workspace or
accessing history; a missing seeded file is a recovery error, never recreated.

Four new lifecycle tests cover concurrent open/resume with one launch, independent
later binding preserving window/history, missing seed/origin refusal, and lost
creation acknowledgement across restart without a second create. The Matrix test
client has no provisioning methods: these tests exercise no Matrix call. This is
not live Matrix/NAS outage acceptance or a fresh automatic-start entrypoint.

Focused enrollment/exact lifecycle: 28 passed before the additional early-origin
case. Latest full affected managed suite: **535 passed, zero skips**:
`.pi/tmp/workers/2026-10-06T05-43-31-036Z-roomless-launch-origin-affected-7fea2292bb6a/`.
No final canonical gate or #116 subjective review yet.

## Partial implementation: fresh local-first lifecycle

Ordinary `conversation.start` with configured live hierarchy now durably seeds,
reserves hierarchy identity locally, registers owned roomless authority, and
launches before any Matrix provisioning. It uses the existing independent local
enrollment reconciler, not a new retry owner or argv journal. Retries find both
pending and bound registrations; retirement is checked before new seeding.
Explicit fork context and pre-provisioned compound creation retain their existing
bound paths, as do legacy configurations without live hierarchy.

A new fixture with unavailable coordinator bootstrap and no Matrix provisioning
methods proves concurrent/repeated fresh requests create one local process, and
failed remote completion leaves it active with unchanged history. Full packaged
affected suite: **536 passed, zero skips**:
`.pi/tmp/workers/2026-10-06T05-48-21-280Z-fresh-local-first-affected-6cf765227ed2/`.
An ad-hoc run of the broader lifecycle file omitted its packaged environment,
skipped five probes and failed a launcher probe; that is not acceptance evidence.
The properly packaged full suite above passed that probe without changing it.

Saved-session selection/full ownership guards and launcher wiring remain to be
implemented and verified. Typed pending-control presentation also needs checking
against the final integrated path; bound-only controls have not been generalized. General startup transport is out of
scope under the approved simplification. Preflight findings are
not acceptance of #116. These plans do not authorize live account effects or
deployment.
