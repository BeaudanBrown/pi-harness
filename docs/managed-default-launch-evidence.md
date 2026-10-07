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

## Approved ordinary-history resume policy

The operator selected option 1: explicit managed resume of never-managed saved
history imports a snapshot into a new native session/conversation. The original
file and any ordinary writer remain untouched. This is independent context,
not in-place adoption, and no copied history is backfilled to Matrix. Existing
managed active/dormant bindings still reuse their original identity/window;
retired histories require proven retirement and fresh identity.

`launch/import-history.ts` now prepares such a seed through the public standalone
SDK `forkFrom`, using a private immutable snapshot rather than the original live
file. It rejects noncanonical/symlink/hardlinked/non-user/malformed/changing
sources and mismatched cwd before copying. A complete fresh projection boundary
is published exclusively with fsync; existing destinations are never replaced.
No assistant response, SDK private persistence method or live-manager mutation
is used. Copied metadata retains its old session scope; lifecycle verification
ignores only positively scoped foreign boundaries, not malformed/unknown ones.
This preparation helper is not host ownership/retirement authorization and is
not yet wired to the automatic launcher.

Crash boundaries: before publication, private staging has no registry/process
identity; handled errors remove it. After exclusive publication, the complete
seed survives for explicit owner admission/recovery, never overwrite/replay.
Process crashes may retain private staging for manual inspection; no automatic
cleanup/adoption of crash remnants is introduced. Source files are never written.

Initial actual SDK 0.84.4 and 0.85.0 checks passed (two each, zero skips), including
user-only history with no assistant, retired old-scope metadata, native reopen,
zero historical projection, unchanged source/destination retry refusal, and
alias/malformed refusal. Initial affected suite: 547 passed, zero skips. Artifacts:
`.pi/tmp/workers/2026-10-07T04-40-44-085Z-history-import-real-sdk-a44dbcf991b7/` and
`.pi/tmp/workers/2026-10-07T04-46-46-247Z-history-import-affected-ea8834ea0d12/`.
Final focused coverage: **three cases on each actual SDK, zero skips**, including
header-only history, injected SDK failure cleanup, immutable snapshot input and
concurrent exclusive publication:
`.pi/tmp/workers/2026-10-07T04-52-47-493Z-history-import-final-focused-9b76d88a72f4/`.
Final affected snapshot: **548 passed, zero skips**:
`.pi/tmp/workers/2026-10-07T04-53-14-972Z-history-import-complete-affected-0f9fe7fd7539/`.
This is not #116's final canonical gate or completed launcher acceptance.

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

## Pending-control integration plan

#116 also owns truthful local controls for its newly owned, roomless processes.
The shared host mutation owner must freeze registered identities, not require an
already-provisioned room. Stop/refresh keep exact ownership and coordinator
protection; pending terminal enrollment does not confer owned-process authority.

| Boundary | Evidence planned |
| --- | --- |
| Private control socket → mutation owner → lifecycle | Roomless open/resume/stop through real IPC and fake exact launcher; no Matrix calls |
| Stop after failed attachment | Verify original process exit before dormant state; retain proof/history; no automatic retry |
| Pending binding changes after frozen consent | Reject stale approval; do not execute under newly changed binding |
| Stop/refresh while launch is admitted | Existing per-workspace exclusion; no cancellation of in-flight launch |
| Roomless retirement | Commit tombstone before exact cleanup; retain unresolved provisioning blocker and history; never claim remote completion |
| Missing owned origin or coordinator target | Refuse process control before launcher effects |

Implemented: the shared mutation owner now freezes registered pending/bound
identities, including binding phase, and local stop/refresh/legacy delete admit
only bound projects or positively owned roomless seeds. Pending terminal
registrations remain ineligible for owned-process control. Existing kernel-proof,
launch exclusion, coordinator protection and irreversible retirement owners are
unchanged. Binding completion invalidates frozen consent rather than silently
expanding it. Retirement of unresolved provisioning remains visibly blocked even
when the exact local process was stopped; history is retained.

Focused evidence: **32 passed, zero skips**, including actual private host-control
IPC through policy/dispatcher/mutation owner/lifecycle with a fake exact launcher,
roomless stop/resume/delete, stale consent, failed-attachment exit verification,
missing-origin refusal and dormant refresh/history preservation:
`.pi/tmp/workers/2026-10-06T10-42-48-609Z-roomless-controls-focused-dbf092e098e2/`.
Affected suite: **544 passed, zero skips**:
`.pi/tmp/workers/2026-10-06T10-43-28-358Z-roomless-controls-affected-06464a6b9930/`.

These checks do not authorize deployment, live retirement, migration or account
traffic. Launcher entrypoints and local-only guards remain separate unfinished
acceptance within #116. This is not the final issue review or canonical gate.

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

## Partial implementation: read-only saved selection and guarded reuse

`resolveBasicSessionSelection` uses the public SDK `list`/`listAll` without opening
a writable manager. It follows native local-before-global matching and explicit
path precedence, returns picker candidates without selecting implicitly, and
uses newest-first SDK order for continue. Unlike native prefix-first guessing,
ambiguous matches are refused. `--session-id` must identify existing local history,
not impose a caller-chosen identity on a new managed conversation. Invalid IDs
are checked against actual public SDK in-memory construction in tests. Lists over
4096 candidates require explicit file selection. No host admission follows from
this helper alone.

Nine focused helpers pass on **each actual SDK 0.84.4 and 0.85.0, zero skips**:
`.pi/tmp/workers/2026-10-06T07-37-43-659Z-default-launch-resume-resolution-sdk-300314b92b82/`.
Fixtures verify local/global/path selection, picker/continue, ambiguous prefixes,
missing exact IDs, and unchanged saved bytes.

The public host read model now supplies an optional host-scoped opaque
`sessionKey` for active native identity. Raw native session IDs stay private. The
`saved-session-open-v1` capability allows `conversation.open` to carry an expected
generation through the existing mutation owner. It is checked before effects and
after exact-window observation, preventing a reset race from silently opening a
successor. The key uses SHA-256 domain `pi-managed-sessions:saved-session:live-v1`
with a NUL separator and UTF-8 byte-length framing of host/session IDs, truncated
to 32 hex characters with `session_` prefix. It is not an authorization token.

The first broad run caught raw native-ID disclosure in the unchanged production
IPC privacy assertion (538/539). Production output was corrected to the opaque
key; the privacy assertion was not weakened. Latest affected managed suite:
**539 passed, zero skips**:
`.pi/tmp/workers/2026-10-06T07-49-11-156Z-saved-resume-private-identity-affected-6d1e8fb04c64/`.

## Partial implementation: consume trusted dispatch before subprocesses

The module's managed project/coordinator wrappers now unset
`PI_MANAGED_SESSION_LAUNCH_ROLE` immediately before entering the SDK. It is a
one-shot dispatch selector, not inheritable authority for a nested Pi to reopen
its parent's fixed session. The parent adapter still receives its binding data;
nested invocations through the inherited private launcher enter the existing
ordinary fallback, which clears stale managed identity and profile fields.

Two actual packaged SDK subprocess probes cover both parent roles and verify the
child receives engineering-full, no managed identity, and no forced `--session`
argument. Package contracts passed: 11 engineering runtime and 17 headless tests,
zero skips:
`.pi/tmp/workers/2026-10-06T09-05-12-669Z-nested-dispatch-package-contracts-8875e26740e3/`.
Affected module contracts and all **539 managed tests passed, zero skips**:
`.pi/tmp/workers/2026-10-06T09-22-50-576Z-nested-dispatch-affected-ab17a591e30b/`.
This proves the packaged child-dispatch boundary, not completion of automatic
launch or all direct SDK worker paths. No issue review/final canonical gate yet.

## Public creation and compound pending results

The private-IPC regression now begins with public `conversation.create`, not a
preseeded registration, and exercises create/open/stop/resume/retire through the
policy/dispatcher/mutation owner/lifecycle stack with unavailable Matrix setup.
A further integration gap was corrected: bundled worktree/conversation creation
had successfully started roomless work, then incorrectly required a bound
manifest to construct its result. It now reports local success without inventing
a room link; already-bound and explicit-summary fork results retain their links.

The worktree regression uses the real durable intent/seed/registration/launch
pipeline with fake trusted Git/tmux primitives, not real external Git mutation.
Focused exact-lifecycle checks: **26 passed, zero skips**:
`.pi/tmp/workers/2026-10-07T01-27-17-094Z-roomless-creation-integration-67a83f2c8fff/`.
Affected suite: **545 passed, zero skips**:
`.pi/tmp/workers/2026-10-07T01-28-13-811Z-roomless-creation-affected-20e91337947f/`.

## External requesting-client target primitive

Local nix-dotfiles commit `d2d35db` adds `managed window-focus-exact` in the owning
Go launcher. The caller supplies the host open result's conversation/launch and
stable session/window/pane identities plus a previously captured client name/PID.
It verifies exact kernel-owned window metadata, then guards both target identity
and attached client PID in the same tmux server queue as the explicit client
switch. Missing/stale identities or a late disconnect refuse without fallback.
It creates/stops/replaces nothing. Legacy live rows now use stable window/pane IDs
rather than indices, and managed selection no longer cleans up the default
session. No picker inventory frontend or default Pi wrapper is wired by this.

Direct Go + disposable tmux 3.6a verification: **43 top-level tests passed, zero
skips**, including eight focus/dispatch/no-cleanup cases, two real control-mode
clients in different sessions, window renumbering, injected late replacement and
client disconnect, strict JSON dispatch and inherited-target rejection:
`.pi/tmp/workers/2026-10-07T01-20-20-097Z-exact-focus-client-queue-guard-d3d187b40fd2/`.
A numeric `switch-client -c PID` experiment failed against actual tmux; the final
implementation uses its required client name and separately guards PID via the
client-loop format. This passing run supersedes that experiment. Native shared
session selection semantics remain; no per-client session manager was introduced.
External LSP lacked an active build, so direct Go compilation/tests are the
compiler evidence. External hooks were explicitly bypassed to avoid forbidden
Nix evaluation; no dotfiles Nix evaluation/build, activation, shared server
restart or live-account traffic occurred.

## Authorized requester capture and outside-tmux attachment

The operator explicitly authorized necessary source changes and disposable
Go/tmux tests in the owning nix-dotfiles worktree, retaining the existing
no-evaluation/build, push, deployment and live-traffic restrictions.
Local external commit `78e5115` adds:

- Read-only `managed client-capture`, using the invocation's original server PID
  and pane, plus an optional exact client hint. Ambiguous shared-pane viewers,
  foreign servers, detached clients and malformed/oversized inventories refuse
  without selecting a recent client or creating a server.
- UI-only `managed window-attach-exact` for invocation outside tmux. It shares
  focus's exact kernel/window guard and performs the guarded attach in the same
  server queue. This occupies the caller's terminal until detach, not a new Pi
  writer or success receipt. Stale target refusal has nonzero status; terminal
  stdout is required and command output is bounded. Unsupported platforms refuse.

Actual disposable Linux PTY tests supply JSON on stdin and a controlling terminal
on stdout, observe the exact window/pane, detach explicitly, and inject a changed
launch between inspection and attach. Nonterminal refusal preserves redirected
output files. An initial `/dev/tty` implementation failed actual tmux; the final
implementation passes the real stdout terminal device instead. No temporary
receipt files, server mutations for capture, lifecycle creation or fallback
client selection were added.

Final direct Go suite: **48 top-level tests passed, zero skips**:
`.pi/tmp/workers/2026-10-07T06-29-37-577Z-native-attach-stdin-wire-eb4b39cc7737/`.
External LSP reported no active workspace build; direct Go compilation provides
compiler evidence. External pre-commit hooks were bypassed to avoid forbidden
Nix evaluation. No shared server was restarted. These primitives still need
frontend wiring and do not constitute #116/#118 completion or live acceptance.

Full saved-file/retirement ownership integration, requesting-client frontend wiring,
local-only guards and launcher wiring remain to be implemented and verified. Typed pending-control presentation also needs checking
against the final integrated path; bound-only controls have not been generalized. General startup transport is out of
scope under the approved simplification. Preflight findings are
not acceptance of #116. These plans do not authorize live account effects or
deployment.
