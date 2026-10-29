# pi-harness

Thin shared configuration for the Pi coding agent.

This repository is intentionally small. It does not implement a general
workstream manager, tmux switcher, TUI, or arbitrary context attachment model.
It does provide the narrowly scoped managed-session host relay defined by ADR
0002: a deterministic Matrix/IPC registry for host-owned Pi conversations. Pi
still provides the interactive agent UI, session storage, branching,
compaction, tools, extensions, skills, prompt templates, and themes. Session
layout remains external and uses regular tmux through fixed host-owned actions.

## What This Flake Provides

- the upstream `pi` CLI from `llm-agents.nix`
- a Nix package named `pi-harness`
- a Nix resource package named `pi-harness-resources`
- a NixOS module named `nixosModules.pi-harness`
- a packaged `pi-managed-session-relay` host-runtime executable
- an opt-in [read-only bridge preflight](docs/bridge-chat-preflight.md) NixOS service
- a separately isolated [stateless `!pi` chat assistant](docs/bridge-chat-assistant.md), sharing Matrix infrastructure and the existing Pi login, with web-search-only SDK sessions; disabled by default and awaiting per-bridge live acceptance
- shared Pi resources under `config/agent/`
- a small web search extension under `config/agent/extensions/web-search`
- a Nix runtime guidance extension under `config/agent/extensions/nix-runtime`
- a Codex fast-mode extension under `config/agent/extensions/codex-fast`
- a tmux cursor focus extension under `config/agent/extensions/tmux-cursor-focus`
- a tmux/fzf session picker command under `config/agent/extensions/sesh`
- a delegated noisy-command runner under `config/agent/extensions/worker-runner`
- dedicated parallel code-review agents under `config/agent/extensions/review-agents`
- reusable architecture diagram tools under `config/agent/extensions/diagram-tools`
- a `playwright-browser` skill and `pi-playwright` resolver for project-first browser automation with an optional Nix-pinned fallback
- typed GitHub Issue tools with optional dry-run previews under `config/agent/extensions/github-issues`
- a GitHub-native `/aloop #<epic>` supervisor with fresh sequential implementation workers
- an `aloop-policy` skill for creating and reviewing project-owned verification policy
- an `architecture-diagrams` skill for live diagrams, deterministic generated evidence, and durable architecture docs
- a curated, pinned distribution of Matt Pocock's engineering skills
- a user-invoked `migrate-tk-to-github` migration inventory skill and dedicated migration launcher
- a migration-only `tk` launcher for approval-gated GitHub cutovers
- the AgentGraph pi resources imported from the AgentGraph flake input
- the separately packaged pi-r extension, runtime resources, and lean `pi-r-local` launcher adapter imported from the pi-r flake input
- empty skill, prompt, and theme directories for future additions

The packaged `pi-harness` binary wraps upstream `pi` and passes explicit local
resource paths from the Nix store with `--extension`, `--skill`,
`--prompt-template`, and `--theme`. Pi-R and AgentGraph resources are disabled
by default: ordinary sessions have neither experimental commands nor tools,
skills or prompts. Their packages remain available for deliberate opt-in. It does not depend on
mutable `pi install` state or on copying generated settings into `~/.pi/agent`.

Harness-owned resources are packaged separately as `pi-harness-resources` and
expose `passthru.piResources` for future Nix-packaged Pi extensions. Pi-r stays
separately owned and exposes stable paths for its CLI, main and scout extensions,
skill/reference, R runtime, formatter, Tree-sitter parser/query, and Bubblewrap
sandbox through `packages.pi-r.resourcePaths`. AgentGraph
resources are consumed from the AgentGraph flake input by path, not copied into
this repository's package output.

The harness defaults do not overwrite pre-set `AGENTGRAPH_CLI` or
`AGENTGRAPH_POSTGRES`. Development launchers such as AgentGraph's `pi-ag` can
keep web search, prompts/themes, models, and LSP from the global harness while
shadowing only the packaged AgentGraph runtime and resources for that process.

## Agent capability profiles

`config/agent/profiles.json` is the declarative source of truth for the seven
agent personas: `engineering-full`, `aloop-implementation`, `aloop-patch`,
`review-worker`, `diagnostic-worker`, `managed-coordinator`, and `pi-local`.
It declares extensions, skills, prompt and theme resources, context-file and
builtin-tool access, and either an exact tool allowlist or the ordinary
extension-default surface. The `managed-project` launch variant derives from
`engineering-full` and removes only local interaction, pi-r, and AgentGraph
capabilities.

Nix launchers consume the packaged registry rather than maintaining independent
extension lists. SDK review and diagnostic sessions resolve their prompts and
tool surfaces from the same registry. Narrow personas use explicit allowlists.
Both ordinary and managed project engineering sessions retain project
extension, skill, and prompt resources. Managed launchers disable ambient user
resource discovery, then explicitly add conventional resources from the trusted
project while filtering the declared local-interaction, Pi-R, and AgentGraph
extension names. The managed
coordinator instead disables every discovered resource, context file, and
built-in tool before loading its lifecycle-only profile.
Implementation and patch profiles admit project-owned worker extensions and tools
only through the registry's `aloop-opt-in` policy; `.aloop.json` supplies that
explicit opt-in when the worker launcher consumes the policy.

Capabilities tied to live state are not ambient. `remote_checkpoint` is active
only while a connected ordinary adapter has unfinished Matrix input, and aloop's
supervisor tools are active only from `/aloop` startup until that supervisor
turn settles. The managed coordinator exposes only its typed lifecycle tools.

## Lean local Pi with pi-r

The package also installs `pi-r-local`, a deliberately narrow wrapper around raw
Pi. A host-owned `pi-local` command can set its dedicated model/configuration and delegate to this adapter without colliding with the harness package. It disables discovered extensions, skills, and project context, starts with
only `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`, and explicitly
loads only the pi-r extension and pi-r skill. Provider/model flags and the
dedicated `PI_CODING_AGENT_DIR` remain the consuming host's responsibility:

```bash
PI_CODING_AGENT_DIR="$HOME/.pi/local-agent" \
  pi-r-local --model local-llm/qwen --thinking low
```

When pi-r activates, it replaces either launcher's original tools with the
phase-specific constrained surface. Session shutdown restores the exact tool
surface captured from that launcher. The dependency scout starts raw Pi from
the same inherited configuration directory, so a local launcher uses its local
provider/model without forwarding conversation or workspace context.

## Synthetic evaluation launcher identity

The package emits
`share/pi-harness/eval/launcher-identity.json`. This Nix-generated manifest
binds the `pi-r-local` RPC launcher to the selected Pi version, harness input
revision, pi-r input revision (or immutable NAR hash for a path override), and
exact pi-r resource/extension/skill store
paths. The evaluation launcher in `eval/launcher/launch.ts` checks that manifest,
the evaluated Git revision and clean state, the launcher's machine-readable
startup attestation of effective pi-r paths, and RPC `get_state` model identity
before any scenario prompt. It inherits configured provider/model environment
variables but persists only environment key names; credential-like command-line
arguments are rejected, and all persisted argument values are redacted. Live
concurrency defaults to one.

To evaluate a current pi-r checkout instead of the lock-file input, use an
absolute path override (a clean Git checkout gives the most useful revision):

```bash
nix build .#default \
  --override-input pi-r "path:$(realpath ../pi-r)"
jq .piR result/share/pi-harness/eval/launcher-identity.json
```

The resulting manifest must name the override's store resources, rather than
the deployed or lock-file pi-r package. The live CLI consumes this same identity
seam; this build command neither starts a model nor probes an endpoint.

## Synthetic evaluation CLI

`nix run .#eval -- list|run|suite|report` exposes the synthetic evaluation
stack. Live `run` and `suite` commands require the literal `--live-model` flag,
default to one sequential run, preserve all partial artifacts, and assume the
configured endpoint already exists. `nix run .#eval-self-test` runs only the
synthetic fake-RPC laboratory with an empty credential environment; canonical
verification invokes the same self-test. See [`eval/cli/README.md`](eval/cli/README.md)
for commands, outputs, and exit codes.

## NixOS Usage

In a consuming flake such as `nix-dotfiles`:

```nix
{
  inputs.pi-harness.url = "github:BeaudanBrown/pi-harness";

  outputs = { inputs, ... }: {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      modules = [
        inputs.pi-harness.nixosModules.pi-harness
        {
          services.pi-harness = {
            enable = true;
            package = inputs.pi-harness.packages.${pkgs.system}.default;
          };
        }
      ];
    };
  };
}
```

The module installs the packaged `pi` binary. The binary injects the shared
resource paths directly, while Pi's normal user config directory remains mutable
for auth, sessions, user settings, and user-installed extras.

Set `services.pi-harness.sessionDirectory` only when a host should use one
exact flat Pi session directory. The installed `pi` wrapper exports
`PI_CODING_AGENT_SESSION_DIR` immediately before starting Pi, so a NixOS switch
takes effect without requiring the desktop user to log out and back in. This
option does not configure the parent of Pi's native per-project session tree;
use a filesystem mount when that complete tree must live elsewhere.

## Managed-session relay foundation

The separate `managed-session-relay` package exposes
`pi-managed-session-relay`. The default harness package intentionally does not
expose it while managed sessions are disabled. The relay owns a private bounded NDJSON Unix socket,
strict adapter attachment authorization, atomically replaced host-local
registry state, synchronized logical manifest access, restart reconciliation,
a bounded private content-addressed image spool, and the relay-only Matrix HTTPS and authenticated media client. Matrix credentials remain private
fields of that process and are never accepted by or emitted over IPC.

The executable requires `PI_MANAGED_SESSIONS_RUNTIME_DIR`,
`PI_MANAGED_SESSIONS_STATE_DIR`, `PI_MANAGED_SESSIONS_MANIFEST_DIR`,
`PI_MANAGED_SESSIONS_HOST_ID`, and the
existing `PI_MATRIX_*` identity/credential variables. Packaging the executable does not enable it. The NixOS module's atomic
`managedSessions.enable` switch installs the managed-aware interactive Pi wrapper
and offline native-history guard, starts one lingered systemd user relay for the selected
Unix user, and strictly parses the SOPS Matrix token file for the relay without
sourcing arbitrary environment assignments. `managedSessions.stateDirectory`
defaults to `%h/.local/state/pi-managed-sessions/relay`: registry, activity and
media state survive reboot there; only the socket and sync-health observation
live under `XDG_RUNTIME_DIR`. First startup atomically copies existing legacy
runtime state under the host lock without merging or deleting the old store.
The coordinator uses a separate raw-Pi profile and never inherits
`PI_MATRIX_*` credentials.

On enabled hosts, bare interactive `pi` in a host-validated Git checkout or linked
worktree creates a relay-owned conversation and opens its exact tmux window.
Explicit resume reuses an existing owned binding; ordinary saved history is copied
to a fresh native identity without changing the original or projecting old history.
Retired history requires positive host retirement proof. Non-Git/out-of-root
launches remain local; workers, headless jobs and dedicated experiments do not
auto-enroll. Eligible startup overrides are refused rather than discarded.
Use `pi-local-only` for normal engineering resources without managed/Matrix
transport, or for startup overrides; it refuses bound-history resume. This is
separate from the existing `pi-local`/`pi-r-local` model profile. Matrix setup may
remain pending while local work runs; an unavailable local relay instead refuses
admission with explicit local-only guidance. Linux, tmux 3.6+, and the matching
launcher UI capabilities are required. See [default-launch evidence](docs/managed-default-launch-evidence.md)
for ownership, recovery and verification boundaries. Installing these sources is
not authorization to activate or migrate a live host.

Enabled hosts also install `pi-managed-session`, backed by a separate private
`$XDG_RUNTIME_DIR/pi-managed-sessions/control.sock`:

```sh
pi-managed-session host status --json
pi-managed-session conversation list --json
pi-managed-session workspace list --json
pi-managed-session --help
```

Use exact conversation IDs from inventory, never titles or abbreviated IDs.
Inventory is bounded and paginated; `--request-id ID` supports explicit retries.
`--json` emits one versioned result, with diagnostics on stderr and distinct
[documented exit categories](docs/managed-live-workspaces-contract.md).
Metadata includes roomless local work and explicit unresolved legacy identities,
without reading saved Pi transcripts or waking sessions. It is last-known display
metadata, not proof of filesystem authority or Matrix/account/phone readiness.
Workspace/worktree discovery is cached for 30 seconds; conversation metadata is
projected directly from the relay's in-memory registration/attachment state.

The new API supports reads and policy-authorized local-human open/resume.
Open returns the exact marked window without waiting for Pi attachment; resume
waits for bounded attachment readiness. Both join one persisted launch, including
the protected coordinator's original session. Failed panes remain for manual
inspection/closure; no automatic replacement or client switching occurs. Model
mutation approval and other mutation frontends remain staged work and return
typed errors rather than invoking legacy bypasses. `managedSessions.actionPolicyOverrides` is a validated Nix-only
startup policy; model mutation approval and coordinator protection cannot be
removed. Changes require a guarded relay rollout, not a runtime policy editor.
For direct relay development, `PI_MANAGED_HOST_ACTION_POLICY` explicitly selects
the policy file and enables this surface; without it no control socket is created.
The status compatibility wrapper retains its legacy health report during guarded
rollout and consults host status when the new endpoint is present.

The resource package also exposes separate ordinary and coordinator adapter
entry points through `passthru.managedSessionExtensions`. They speak only the
private relay protocol, persist binding/delivery provenance in Pi session
history, and preserve Pi's normal prompt-template, skill, and extension-command
expansion. They are deliberately absent from default settings and the default
Pi wrapper; an enabled managed-session host must select exactly one profile.
The ordinary profile provides `/remote on <concept>` and `/remote status`.
Legacy `/remote delete` is disabled until approved retirement controls are
available; it never unbinds a live process. Leaving an individual conversation's
Matrix room as the configured operator triggers canonical retirement. There is
no `/remote off` operation. Project and coordinator conversations share the typed
`managed_host` tool; every model mutation requires independent per-call consent. `/remote on` locally enrolls a persisted, idle
ordinary Pi session: the relay verifies its canonical placement and durable Pi
identity without waiting for Matrix authentication or provisioning. The same Pi
continues running while a private pending registration survives relay restarts.
Background hierarchy completion never triggers a process handoff; the adapter
shows pending binding separately from local attachment. Pre-binding history is
not projected, and post-binding outage catch-up is silent. A stored room binding
is not proof of account membership or phone delivery. Legacy clients retain the
explicit promotion protocol; managed relaunches receive their private socket and
one-time attachment nonce from the host-owned launcher.

After binding, adapters classify persisted Pi branch entries and offer only
terminal-origin text turns, completed assistant commentary, and final answers. Matrix-origin users are
mapped to their existing Matrix events rather than echoed; their relay-verified
sender MXIDs are persisted and included in ordinary model-visible attribution; leading-slash commands retain native Pi dispatch. The relay records
each offer before sending deterministic, sanitized Markdown chunks with stable
Matrix transaction IDs; reconnect and restart retry the same transactions.
Thinking, tool activity, compaction/internal entries, pre-binding history, and
oversized or excessive backfills are excluded or fail closed with diagnostics.

An enabled host requires explicit Matrix identity, host identity, named
workspace roots, a strict host launcher package, and a credential file that
contains only `PI_MATRIX_ACCESS_TOKEN`:

```nix
services.pi-harness.managedSessions = {
  enable = true;
  user = "operator";
  environmentFile = config.sops.templates."pi-managed-session.env".path;
  homeserver = "https://matrix.example.com";
  botUserId = "@pi-host:example.com";
  operatorUserId = "@operator:example.com";
  ignoredSenderUserIds = [ "@signalbot:example.com" "@facebookbot:example.com" ];
  hostId = "workstation";
  workspaceRoots.projects = "/home/operator/documents/projects";
  launcherPackage = pkgs.tmux_project;
};
```

The relay atomically creates the private neutral coordinator workspace and Pi
session before creating the host Space and coordinator room. Authorized room
text is persisted before the trusted `tmux_project managed
coordinator-ensure` hook recreates `default/coordinator`. The coordinator
session, room and host Space IDs survive restart. Startup never replaces an
inaccessible identity or repairs existing Space links. Fresh bootstrap uses
atomic ownership metadata and durable provisioning phases; uncertain creation
without a recoverable alias stays pending for explicit reconciliation.

The neutral coordinator and managed project profiles expose compact `managed_host`
controls and the `managed-host` skill. Use `operation: "help"` for the flat typed
schema. Direct operators use `/host`, `!host`, or `pi-managed-session` with the same
noun/action grammar; room-local `!start` launches without a prompt and
`!close --confirm` permanently retires the conversation. Destructive/apply actions
retain confirmation. Matrix `/host` is routed as Matrix authority, never executed
as a local slash command. The coordinator stays protected from stop/delete and
has no engineering tools. See [frontend evidence and migration](docs/managed-host-frontends-evidence.md). Project creation
accepts only a configured root, safe absent immediate-child name, and creation
label. The trusted launcher creates no
scaffold or remote: it initializes local Git on `main`, records a durable retry
identity, and preserves partial repositories for explicit retry. Stable private
Matrix aliases and durable provisioning phases prevent uncertain retries from
duplicating project Spaces or rooms. Starting a
project conversation accepts only a named root, immediate-child workspace, safe
relative cwd, and creation label. Labels may duplicate; identities do not depend on them. A harness-owned authority wrapper enriches the configured tmux launcher’s canonical workspace result and resolves Git common-directory
identity so a main checkout and its linked worktrees share one deterministic private
project Space on that host. New conversations live beneath a distinct checkout
Space (shared by conversations in that checkout); relative cwd does not create a
new checkout identity. Non-Git workspaces use a stable immediate-child fallback.
Host-scoped aliases require exact bot-authored ownership proof before adoption.
Local hierarchy reservations remain pending during provisioning failures; completed
hierarchy provisioning alone does not establish operator-account or phone readiness. Existing Space bindings and
checkpointed provisioning IDs are preserved; see [shared-workspace recovery](docs/managed-matrix-sessions.md#shared-workspaces-across-hosts). Existing compatibility rooms remain untouched on startup, which reports only an aggregate pending count. Host controls can explicitly preview/apply existing-room migration into checkout Spaces and repair saved hierarchy links without replacing rooms, sessions or processes. Migration reuses #68's durable phases, preserves notification policies and requires fresh consent after interruption. Exact empty-Space cleanup is separately confirmed through NAS leave/forget, never a kick fallback; unmarked legacy Spaces remain retained. Cleanup refuses referenced, non-empty, inaccessible or foreign Spaces. See [migration operations and evidence](docs/managed-hierarchy-migration-evidence.md). The relay resolves placement
through the fixed launcher, durably creates the Pi session and binding boundary
before Matrix rooms, and launches the ordinary adapter through the trusted
`direnv exec`/Pi dispatch. No objective or orientation is lifecycle metadata:
the first Matrix text is the first task. New-project results include a bounded
Element X-compatible room link. Managed Pi uses run-scoped project approval and
never persists trust for unrelated interactive launches. Project room text routes directly
without host addressing; dormant input resumes the same persisted session.
Stop terminates only the exact managed window and leaves the conversation dormant.
Legacy windows without exact ownership require explicit, two-step
`conversation migrate <id> --confirmed` recovery: capture exit evidence before
manual window closure, then verify exit before clearing stale metadata. It does
not restart tmux, adopt a live legacy process, or replace saved history. See
[legacy window migration](docs/managed-legacy-window-migration.md).
Already-closed legacy windows instead support individually previewed and confirmed
[manual recovery](docs/managed-manual-recovery.md): operator attestation is recorded
separately from verified exit, with incomplete inspection disclosed and detected
conflicts blocking. The same preview identifies retired targets explicitly and
resolves only their process-cleanup obligation, never resurrecting them.
Confirmed deletion permanently retires the identity, stops only proven owned
processes, and retries exact room/Space cleanup. Saved Pi/Matrix histories,
workspaces and project files are preserved; this is not unbind-only deletion. The relay pins managed tmux operations to `XDG_RUNTIME_DIR`, matching the existing interactive `tmux_project` server. Marked live conversation windows appear as additional candidates in that same launcher and switch the requesting client to the existing Pi process; selection never creates or resumes work, and dormant conversations remain lifecycle-only. A confirmation-gated host operation previews and removes only marked windows from the obsolete `/tmp` tmux socket during the one-time deployment cutover.

To split work from a Matrix project conversation, ask its agent to use
`managed_host` operation `worktree.conversation.fork` with a concise summary,
explicit committed base ref and new branch/title. Independent approval freezes
the summary and Git/source identities. This creates a new worktree and room,
posts the summary as visible initial context, and leaves the new Pi idle until
another message. Source files/conversation stay untouched; uncommitted changes,
raw session history and pending execution are not copied. Direct operators can
also use `pi-managed-session worktree conversation fork` with the same explicit
fields. This is not native room-preserving `/fork`. See
[split-fork evidence](docs/managed-split-fork-evidence.md).

Managed room controls retain Pi's established control semantics while using
host-owned room routing: ordinary text is an idle prompt or steering input for the active run; typed help, status, authenticated scoped model selection, thinking selection, measured compaction, stop, abort, and steer operations never become model prompts. Status combines a typed live adapter snapshot with relay-authoritative conversation, generation, saved/requested model and thinking, queue, checkpoint, connection, redacted launch-failure, and reconciliation state; it explicitly flags a runtime/requested-model mismatch without exposing paths, credentials, prompts, arguments, output, or reasoning. Only live agent activity starts Matrix typing; control handling and slash-command dispatch do not. Durable per-room inboxes and frozen notice delivery isolate rate-limit failures from other rooms and generation completion; see [Matrix reliability](docs/managed-matrix-reliability.md). State-changing controls reject busy runs, model catalogues narrow through bounded polls, and `!new --confirm` creates a fresh generation while preserving the room and prior Pi session files. Valid replies to bot events use their unquoted fallback text. Dormant steer/abort never wake Pi and receive one stable notice; an abort
queued during wake cancels that wake input. The `remote_checkpoint` tool emits
one durable structured question, blocker, or issue-completion boundary to Matrix
and records the rendered checkpoint visibly in Pi's persisted chat history,
then hard-aborts the run until a new currently joined participant reply. Declared question options become
single-select polls with durable opaque answer mappings and deterministic room-mention notification requests; the first valid vote or
an ordinary text fallback atomically retires the poll and resumes exactly once.
Authorized unencrypted Element X JPEG, PNG, and WebP events pass original downloaded bytes to the model without harness inbound size caps, declared-size comparisons, dimension checks, or normalization. Matrix, model and available machine resources impose their own limits. Authenticated downloads, durable spooling and digest-verified bounded IPC chunks remain; outbound artifact restrictions are unchanged. Captions and images enter Pi as one ordered user turn; captionless images use a neutral prompt. Models without image input support reject the whole delivery with a Matrix notice and cleanup, without a silent model switch or caption-only fallback. A connected ordinary adapter also activates `remote_artifact_export`, which validates one workspace-relative regular file before streaming digest-verified bounded chunks to the relay. The relay durably reserves and uploads bounded images, audio, or generic files and sends one stable Matrix media event without exposing contents or host paths in activity. Accepted input and media, persisted
unfinished work, checkpoint/final projection, launch failure, explicit
cancellation, generation transition, and restart recovery all reuse stable identities so retries do
not lose or duplicate participant turns. Generation changes durably create the new session and binding boundary before activation, invalidate the old attachment, carry forward selected model/thinking and placement metadata, and leave historical generations terminal-only.

## Managed Matrix operations

Existing host-owned rooms can explicitly preview/apply an
[operator-admin migration](docs/managed-operator-admin.md) using
`conversation admin preview --conversation-ids <exact-ids>` (optionally
`--include-spaces`) followed by a separately confirmed apply. It grants only the
configured operator normal admin power, preserving other users and room history.
It does not remove participants or restart Pi. Matrix has no conditional state
writes: avoid concurrent permission changes and inspect uncertain outcomes rather
than replaying them. Future provisioning's automatic admin grant remains a separate
planned slice; existing room creation still uses the current invitation policy.

The legacy per-Pi `remote-session` bridge and `services.pi-harness.remoteSession`
option are not loaded or exposed. Legacy rooms, bindings, and sidecar state are
not imported. Enabled hosts use only the relay-owned managed-session path above.
Compatible updates keep tmux and Pi processes alive while a guarded user-unit
rollout replaces the relay. Hosts must provide `managedSessions.updateGuard`;
a missing or failed guard leaves the old relay running and reports a blocked
rollout. See [restart-safe updates](docs/managed-session-updates.md) for the
initial ownership migration, runtime retention and compatibility policy.
[Input recovery and runtime updates](docs/managed-input-runtime-updates.md)
define durable stop/reset cancellation, held ambiguous historical input, and
automatic idle-only refresh of changed managed project launchers.

See [`docs/managed-matrix-sessions.md`](docs/managed-matrix-sessions.md) for the
operator runbook, health checks, token rotation, restart recovery, controls,
transcript policy, troubleshooting, and deferred scope.

## AgentGraph Mode

The AgentGraph extension is sourced from the `agentgraph` flake input and is
**disabled by default**, as is Pi-R in ordinary engineering sessions. On NixOS,
explicitly set `services.pi-harness.experiments.agentgraph.enable = true` or
`services.pi-harness.experiments.piR.enable = true`. The module's settings win
over inherited environment switches. Disabled AgentGraph does not source its
optional credential environment file.

For the standalone package, opt in with `PI_HARNESS_ENABLE_AGENTGRAPH=1` or
`PI_HARNESS_ENABLE_PI_R=1`; only `0` and `1` are valid. Development resource-path
overrides alone never enable either experiment. Managed sessions and workers
remain experiment-free even when ordinary launches opt in. Dedicated
`pi-r-local` remains unchanged; it is not the local-only engineering launcher.
These switches govern harness-provided resources, not a sandbox preventing a
user from explicitly loading their own extension through Pi discovery or `-e`.

When enabled, AgentGraph exposes `/ag on`, `/ag off`, `/ag status`,
`/ag init`, and `/ag db`.

`/ag on` switches the current Pi session into graph mode: direct `edit`,
`write`, and unrestricted `bash` tools are disabled, while read-only inspection
and `agentgraph_*` tools remain available. The AgentGraph tool set includes a
restricted `agentgraph_cli` tool for project-scoped `ag` argv calls and
dedicated helpers such as `agentgraph_node_export` / `agentgraph_node_update`
for dry-run-first node edits. The extension also starts a shared local
PostgreSQL server with per-project databases via `agentgraph-postgres`.

The reusable extension, prompts, PostgreSQL helper, and AgentGraph operator skill
are maintained in the AgentGraph repo, not duplicated here; update the
`agentgraph` flake input to pick up tool-surface changes. For live AgentGraph
extension iteration, a launcher can set these environment variables before
executing the normal `pi` wrapper:

```bash
export PI_HARNESS_ENABLE_AGENTGRAPH=1
export AG_DEV_ROOT="$PWD"
export AGENTGRAPH_CLI="agentgraph-dev-ag"
export AGENTGRAPH_POSTGRES="agentgraph-dev-postgres"
export PI_HARNESS_AGENTGRAPH_ROOT="$PWD/pi/agentgraph"
export PI_HARNESS_AGENTGRAPH_SKILLS_DIR="$PWD/skills"
exec pi "$@"
```

The wrapper then loads the AgentGraph extension and prompts from the checkout
while preserving the rest of the Nix-managed harness resources.

AgentGraph LLM execution happens inside `ag agent run-cycle`, so provider
secrets must be available as runtime environment variables to the `ag` process.
The NixOS module can make the standard `pi` command source a SOPS-managed env
file before launching Pi:

```nix
services.pi-harness.agentgraph.environmentFile =
  config.sops.templates."agentgraph-litellm.env".path;
```

When set, `pi` inherits variables such as `LITELLM_BASE_URL`,
`LITELLM_API_KEY`, and `AG_LITELLM_DEFAULT_MODEL`. No separate
`pi-agentgraph` command is installed.

## Playwright Browser Fallback

The `playwright-browser` skill teaches agents to use the stateful Playwright Agent CLI for browser exploration, accessibility snapshots, console/network inspection, screenshots, and test-generation skeletons. The stable interface is:

```bash
pi-playwright doctor
pi-playwright -s=my-task open https://example.com
pi-playwright -s=my-task snapshot
```

`pi-playwright` prefers a project adapter declared in `.pi/playwright-cli.json`:

```json
{
  "version": 1,
  "command": ["bash", "./bin/in-env", "pwcli"]
}
```

It next checks `node_modules/.bin/playwright-cli`, then uses the harness fallback when enabled. Projects own Playwright/Test versions, application fixtures, authentication, and committed E2E tests. The fallback is an isolated, Nix-pinned `@playwright/cli` plus Chromium intended for disposable exploration in projects without browser tooling.

Enable the fallback on selected hosts:

```nix
services.pi-harness.playwright.enable = true;
```

The fallback starts no process until invoked, disables unrestricted file access and browser downloads, and writes default artifacts under the user's XDG cache. It does not add MCP support or replace project E2E tests.

## Nix Runtime Guidance

The included `nix-runtime` extension appends lightweight system-prompt guidance
that tells agents to use project Nix entrypoints first and ephemeral commands
such as `nix develop -c`, `nix shell nixpkgs#pkg -c`, and `nix run` when a
required command is missing. It does not add a new execution tool; normal Pi
sessions still use the built-in `bash` tool, and AgentGraph mode keeps its
restricted tool surface.

Engineering launchers also append a shared Nix-owned runtime baseline after the
project PATH: shell, Git/GitHub tools, core file/text utilities, ripgrep, flock,
and Nix. Aloop checks required executable availability before consuming a worker
launch and records only bounded private executable-resolution evidence. Python,
compilers, and project dependencies still belong to the repository environment.
The lean local and coordinator launchers do not explicitly inject this baseline.

## Tmux Cursor Focus

The included `tmux-cursor-focus` extension hides Pi's software-rendered editor
cursor when the current tmux pane loses focus, then restores it when focus
returns. It is based on the approach used by the community
`pi-tmux-cursor-focus` extension but is vendored as a small harness-owned
extension so the packaged Pi wrapper does not depend on mutable `pi install`
state or an unpinned npm package.

It only activates when `TMUX_PANE` is set. It uses tmux `pane-focus-in` and
`pane-focus-out` hooks for the current pane, so tmux focus events must be
enabled:

```tmux
set -g focus-events on
```

The `nix-dotfiles` tmux module already sets Home Manager's `focusEvents = true`,
which generates the required tmux setting.

## Sesh Session Picker

The included `sesh` extension registers `/sesh`, a current-project Pi session
picker that runs real `fzf` in a tmux popup. It searches session label plus the
first and recent message text, displays a concise session list, and shows a
right-hand preview built from Pi's session-list metadata. Press Enter to switch
to the selected session; press Esc to cancel.

`/sesh` intentionally fails with a warning outside tmux because `fzf` owns a
terminal UI and is run through `tmux display-popup` rather than embedded in Pi's
TUI renderer. It clears user `FZF_DEFAULT_OPTS` for the popup so personal fzf
settings such as `--height` do not shrink the picker inside the tmux popup.

## Codex Fast Mode

The included `codex-fast` extension is based on `calesennett/pi-codex-fast`.
When enabled, it adds `service_tier=priority` to OpenAI and OpenAI Codex
provider requests. It is inactive for other providers.

Use `/codex-fast` inside Pi to toggle it, or start Pi with `pi --fast` to enable
it for the initial session. The setting is recorded only in that Pi session's
history, so resuming the session restores it while new and unrelated sessions
start with fast mode disabled. Global and project settings do not enable it.

## Delegated Worker Runner

The included `worker-runner` extension registers `run_worker`, a tool for noisy checks and commands. It runs a command in the current repository, writes the full log under `.pi/tmp/workers/`, and asks a bounded read-only Pi SDK worker to return a concise summary for the parent agent.

Use it for tests, typechecks, builds, and integration checks where dumping raw output into the main context would be wasteful. The parent agent supplies an argv command and a plain-language task describing what the worker should extract or diagnose. The command runs in a dedicated process group so timeout or cancellation terminates descendants. Its full log and machine-readable `result.json` are durable before diagnostic summarization starts; balanced head/tail excerpts retain startup and failure context, and a deterministic fallback preserves authoritative status if the diagnostic model fails. The worker defaults to `openai-codex/gpt-5.3-codex-spark` and falls back to the current session model only when Spark is unavailable.

Use `/worker-model` to keep the fast Spark/Luna toggle, or use `/worker-model spark`, `/worker-model luna`, and `/worker-model status`. `/worker-model select` opens a fuzzy selector over registered, authenticated Pi models; `/worker-model provider/model` provides the same capability for RPC, Matrix, or other non-interactive sessions. The selection persists in `pi-worker-runner.json` in Pi's agent directory, so it applies to future sessions without rewriting Pi's shared settings. Existing global `pi-worker-runner` settings are read until the first save; legacy mode-only selections still load. Luna and explicitly selected custom models are never silently replaced with Spark or the parent model. `PI_HARNESS_WORKER_MODEL=provider/model` remains the highest-priority environment override and is shown as active by `/worker-model status`.

Do not use `run_worker` for subjective code review. The dedicated `review_agents` tool uses a review-specific model, prompt, and shared pinned diff.

`run_worker` is disabled in AgentGraph restricted mode because arbitrary command execution would bypass the graph-mode tool boundary.

## Code Review Agents

The `review-agents` extension registers `review_agents` for the curated two-axis `code-review` skill. Diff mode captures one committed merge-base diff and commit list. Worktree mode uses a private temporary Git index to capture staged, unstaged, untracked, and binary content as one immutable synthetic commit without modifying source files; later source changes cannot alter that review. Audit mode pins the current HEAD when there is intentionally no diff. All modes store bounded reports under `.pi/tmp/reviews/` and run the requested axes concurrently in isolated read-only Pi SDK sessions.

Review sessions use `openai-codex/gpt-5.6-terra` with low thinking. Set `PI_HARNESS_REVIEW_MODEL=provider/model` to override the model explicitly; unlike the diagnostic worker, review agents fail clearly when their configured model is unavailable or lacks authentication rather than silently falling back to a lower-quality model.

The review sessions expose only `read`, `grep`, `find`, and `ls`. `review_agents` is disabled in AgentGraph restricted mode because its model calls would sit outside graph provenance.

## Architecture Diagram Tools

The included `diagram-tools` extension registers reusable tools for agentic
architecture documentation:

- `diagram_inventory` lists diagram-as-code files in the current repository.
- `diagram_render` validates or renders Mermaid, D2, Graphviz DOT, PlantUML,
  and Structurizr diagram sources using local CLI tools.
- `diagram_show` opens rendered SVG/PNG/JPEG/GIF/WebP/PDF artifacts in a
  detached local viewer when visual review is useful or explicitly requested.
- `architecture_discover` lists project metadata, commands, queries, and
  parameters from `.pi/architecture.json` in one call.
- `architecture_command` runs a named project-defined architecture command.
- `architecture_query` runs a named architecture query with structured JSON
  arguments, returning summary, artifact paths, and provenance.

Diagram and architecture commands share the worker runner's timeout/cancellation
cleanup. Results use bounded JSON previews with full logs/results under
`.pi/tmp/architecture-tools/`; query JSON is parsed before display truncation.
Rendering reports only existing artifacts. Structurizr exports a directory of
PlantUML, Mermaid, or DOT sources, rather than an image. Inventory excludes
`.pi/tmp/` unless `includeGenerated: true` is requested.

The packaged wrapper exposes D2, Graphviz, and a default diagram viewer through
`PI_HARNESS_D2`, `PI_HARNESS_DOT`, and `PI_HARNESS_IMAGE_VIEWER`. Other
renderers can be provided by the project environment or through
`PI_HARNESS_MERMAID_CLI`, `PI_HARNESS_PLANTUML`, and `PI_HARNESS_STRUCTURIZR`.
The NixOS module also provides
`services.pi-harness.diagrams.enable` to append diagram CLIs such as Graphviz
and D2 to Pi's fallback runtime path.

Projects can opt into deterministic architecture generation with
`.pi/architecture.json`:

```json
{
  "metadata": {
    "description": "Project-owned architecture evidence generated from source.",
    "capabilities": ["facts", "diagrams", "focused-queries"],
    "factModel": "versioned entities/relationships with provenance"
  },
  "commands": {
    "facts": {
      "description": "Generate deterministic architecture facts.",
      "command": ["bash", "./scripts/architecture/generate-facts.sh"]
    }
  },
  "queries": {
    "component": {
      "description": "Generate a focused component diagram.",
      "intent": "Explain one component from observed project facts, not from hard-coded architecture assumptions.",
      "capabilities": ["diagram", "provenance"],
      "command": ["bash", "./scripts/architecture/query.sh"],
      "parameters": {
        "kind": { "type": "string", "enum": ["service", "module", "table"] },
        "target": { "type": "string", "required": true },
        "depth": { "type": "number", "default": 1 },
        "direction": { "type": "string", "enum": ["upstream", "downstream", "both"], "default": "both" }
      }
    }
  }
}
```

`architecture_query` validates declared parameters, applies defaults, passes a
JSON payload on stdin, sets `PI_ARCHITECTURE_QUERY_NAME`,
`PI_ARCHITECTURE_QUERY_ARGS_JSON`, and
`PI_ARCHITECTURE_QUERY_PAYLOAD_JSON`, and expects the project command to write a
JSON object to stdout:

```json
{
  "summary": "Generated focused diagram.",
  "warnings": ["No high-confidence runtime edges were found."],
  "metrics": { "nodes": 12, "edges": 18 },
  "tables": [
    {
      "title": "referenced files",
      "rows": [{ "path": "src/component.ts", "relationship": "source" }]
    }
  ],
  "sections": [
    { "title": "Notes", "content": "Diagrams are views over generated facts, not source of truth." }
  ],
  "artifacts": [
    { "path": ".pi/tmp/architecture-query/component.svg", "kind": "diagram", "language": "svg" }
  ],
  "provenance": { "sources": ["src/component.ts"], "confidence": "high" }
}
```

Use the bundled `architecture-diagrams` skill when creating durable architecture
docs, adding live diagrams to an answer, or teaching a project to expose its own
deterministic architecture commands and focused queries.

Keep pi-harness generic: it owns command/query discovery, argument validation,
structured result display, artifact safety, and common diagram rendering. Project
repositories own source scanners, semantic classifiers, fact model evolution, and
query implementations. Prefer intent-based query names and capability metadata so
projects can change implementation details without changing the harness contract.

## Web Search

The included `web_search` extension registers a Pi tool for current web
research. It uses Pi's ChatGPT Plus/Pro (Codex) OAuth login and Codex's native
web-search backend, rather than an OpenAI API key. Log in through `/login` and
select ChatGPT Plus/Pro (Codex). The delegated search model defaults to
`gpt-5.6-luna`; set `PI_CODEX_WEB_SEARCH_MODEL` to override it. Search result
text is capped at 48,000 UTF-8 bytes, including a truncation notice, before it
enters the calling model's context. This policy is shared by all callers; it does
not cap query/domain inputs or HTTP response bytes.

The Codex backend is not a public OpenAI API. Pi keeps the OAuth credential
refreshed, but an upstream backend or model-entitlement change can require a
new `/login` or model override.

## Engineering Workflow

GitHub Issues is the durable source of truth for planned work. Use the GitHub UI
for the queue, parent/sub-issue hierarchy, native blockers, labels, comments,
and handoffs. Treat labels and assignments as advisory metadata; record
verification and a concise handoff before closing an issue.

For multi-issue epics, the packaged `/aloop #<epic>` command supervises fresh,
sequential implementation workers from a clean worktree while keeping GitHub
and Git authoritative. See [GitHub-native aloop](docs/github-aloop.md) for setup,
worker and supervisor responsibilities, separate implementation/settlement budgets,
read-only `/aloop-recovery`, the terminal-outcome-backed `pi-aloop` RPC driver,
verification, interruption recovery, and attempt artifacts. The
[worktree compatibility trial](docs/aloop-worktree-trial.md) records why automatic
workspace isolation remains disabled.

The primary workflow is the curated Matt Pocock skill chain:

```text
setup-matt-pocock-skills → grill-with-docs → to-spec → to-tickets → implement → code-review
```

Pi exposes skills as `/skill:<name>`, for example:

```text
/skill:setup-matt-pocock-skills
/skill:grill-with-docs
/skill:to-spec
/skill:to-tickets
/skill:implement
/skill:code-review
```

Run setup once per repository to write `docs/agents/issue-tracker.md`, domain
layout guidance, and triage-label mapping. Configure GitHub there and do not
create new `tk` tickets. `to-spec` creates a parent specification issue and
`to-tickets` creates dependency-aware, vertical-slice child issues. Work one
open, unblocked leaf in a fresh context when practical; `ready-for-agent` is an
optional prioritization hint.

Use `/skill:tdd` for bounded test-first work, `/skill:diagnosing-bugs` for hard
bugs, `/skill:triage` for incoming requests, `/skill:wayfinder` for uncertain
large efforts, and `/skill:handoff` before session transitions.

Issue implementation follows the shared [review-boundary workflow](docs/agents/implementation-workflow.md): deliberate relationship/domain/ADR preflight, acceptance-to-evidence and scope ownership, focused checks, discretionary review at an individual issue boundary, mandatory exhaustive pinned Standards/Spec review at the end of an epic, batched remediation, then one canonical verification gate and applicable production builds. Crash-boundary analysis applies only to persistent state, retries, concurrency, or external side effects.

The `github_issue_inspect`, `github_issue_mutate`, `github_issue_plan`,
`github_issue_relationship`, and `github_issue_graph` tools provide a typed
boundary for current-repository issue work. Mutations may be applied directly
when already authorized; dry-run previews remain available when they help
resolve uncertainty. The tools resolve GitHub REST database IDs internally;
callers use ordinary issue numbers.

### tk migration

`tk` remains available only while older projects migrate. From a tk-backed
project, run:

```bash
nix run github:BeaudanBrown/pi-harness#migrate-tk
```

Only this launcher enables `github_issue_migration`; ordinary engineering sessions
do not advertise migration instructions or tools. Then invoke `/skill:migrate-tk-to-github`. Its inventory phase reviews every
source ticket with code, Git, and GitHub evidence and asks about stale or
ambiguous work. It never creates issues or removes `.tickets/` before later
approved publication and reconciliation phases.

## Legacy tk Support

Ordinary Pi sessions load the GitHub-native `/aloop` command, but do not load
`tk` or `/aplan`. `tk` is supplied only by `pi-migrate-tk` while a project
completes the explicit, approval-gated GitHub migration described above.

## Local Workflow

For extension and prompt iteration in this repository, edit `config/agent` and
run the deterministic verification gate:

```bash
nix run .#verify
```

The gate is also exported through `nix flake check`, with independently cached
schema, type, unit, package, module, managed-session, Pi-R, and evaluation
checks. See [`docs/verification.md`](docs/verification.md) for focused commands,
test classification, and maintenance guidance.

The installed `pi` wrapper points at immutable Nix store paths. Rebuild or update
the flake input to pick up packaged resource changes. For fast iteration on an
external resource package, use an environment-shadow launcher like AgentGraph's
`pi-ag` so only that package's resource root is replaced by a checkout path.

Use external tmux sessions directly:

```bash
tmux new -s pi-my-task
cd /path/to/project
pi
/name "my-task"
```

Use Pi's built-in session commands for conversation state:

- `pi -c` to continue the latest session
- `pi -r` to browse previous sessions
- `/new` to start a new session
- `/resume` to switch sessions
- `/tree` to navigate branches
- `/fork` to fork from a point in the conversation
- `/compact` to compact long context

## LSP Notes

- `docs/lsp-agent-operating-model.md` explains how agents should use Pi's LSP
  tools: start Pi from the project environment, prefer semantic tools when the
  server advertises the needed capability, inspect `/lsp status` for
  root/command/capability/diagnostic context, and fall back to `rg`, file reads,
  or tree-sitter when semantic setup is unavailable.
- Project-local language servers shadow harness fallbacks because the NixOS
  wrapper appends fallback LSP packages after the caller's existing `PATH`.
  The same ordering is preserved for managed project launches and inherited by
  full aloop implementation workers. Coordinator, review, and diagnostic
  profiles have no LSP extension or process-execution tool surface; `pi-local`
  additionally strips inherited fallback entries from `PATH`. Dependencies,
  SDKs, generated files, and project configs remain owned by the repository
  being edited; the harness reports those failures rather than installing
  packages or inventing language-specific setup.
- `docs/lsp-current-behavior.md` records the packaged Pi LSP behavior, fixed
  reliability boundaries, known remaining failure modes, and the boundary
  between harness fixes and project-owned language-server configuration.
- LSP patch changes should pass both the fast gate and live LSP gate. The live
  gate starts fake and real fallback servers to cover document sync, startup
  guidance, fallback mappings, TypeScript, and Nix smoke behavior.

## Verification

```bash
nix run .#verify       # deterministic aggregate; also run by nix flake check
nix run .#verify-lsp-live  # additional real-language-server coverage
```

See [`docs/verification.md`](docs/verification.md) for the check contracts and
focused development workflow.
