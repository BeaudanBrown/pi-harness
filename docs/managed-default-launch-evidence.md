# Default managed launch evidence (#116)

Status: preflight; implementation not started. #114 is complete. This issue owns
new eligible interactive launches and explicit resume, not adoption of already
running ordinary sessions. No push, deployment, activation, service restart,
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

## Acceptance-to-evidence plan

| Acceptance | Intended seam | Required evidence |
| --- | --- | --- |
| Fresh human interactive launch is managed | Normal configured wrapper to existing host-owned lifecycle; a new creation identity per fresh launch | Packaged launcher and fake-host/real-SDK mode tests; many conversations in one checkout |
| Explicit resume reuses live exact target or dormant saved binding | Read-only SDK session resolution before opening a writable Pi session; existing exact-window/open authority | CLI/session flag matrix, active/dormant and concurrent resume, no second writer |
| Retired history resumes only under a new identity | Existing irreversible retirement authority plus explicit history resume boundary | Old conversation never revived, old file/history retained, no backfill |
| Git and linked-worktree eligibility only inside configured roots | Trusted host launcher/workspace resolver, not caller path assertions | Canonical cwd, nested cwd, validated linked worktree, symlink/ambiguous/non-Git/out-of-root cases |
| Preserve resources and trusted dispatch; no recursion | Package/module wrapper and existing managed dispatcher | Literal argv/cwd/resource preservation, inherited private PATH/identity, nested/internal invocations |
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

Argument transport, saved-session resolution/guards, local-first lifecycle and
launcher wiring remain to be implemented and verified. Preflight findings are
not acceptance of #116. These plans do not authorize live account effects or
deployment.
