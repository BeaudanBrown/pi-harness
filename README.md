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
- typed dry-run-first GitHub Issue tools under `config/agent/extensions/github-issues`
- a GitHub-native `/aloop #<epic>` supervisor with fresh sequential implementation workers
- an `architecture-diagrams` skill for live diagrams, deterministic generated evidence, and durable architecture docs
- a curated, pinned distribution of Matt Pocock's engineering skills
- a user-invoked `migrate-tk-to-github` migration inventory skill and dedicated migration launcher
- a migration-only `tk` launcher for approval-gated GitHub cutovers
- the AgentGraph pi resources imported from the AgentGraph flake input
- the separately packaged pi-r extension, runtime resources, and lean `pi-r-local` launcher adapter imported from the pi-r flake input
- empty skill, prompt, and theme directories for future additions

The packaged `pi-harness` binary wraps upstream `pi` and passes explicit local
resource paths from the Nix store with `--extension`, `--skill`,
`--prompt-template`, and `--theme`. It also loads the packaged pi-r extension in
its inactive state: ordinary sessions gain only `/r`, with no R tools, skill,
or prompt guidance until the user activates a workbench. It does not depend on
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
and the relay-only Matrix HTTPS client. Matrix credentials remain private
fields of that process and are never accepted by or emitted over IPC.

The executable requires `PI_MANAGED_SESSIONS_RUNTIME_DIR`,
`PI_MANAGED_SESSIONS_MANIFEST_DIR`, `PI_MANAGED_SESSIONS_HOST_ID`, and the
existing `PI_MATRIX_*` identity/credential variables. Packaging the executable does not enable it. The NixOS module's atomic
`managedSessions.enable` switch installs only the ordinary adapter into the
interactive Pi wrapper, starts one lingered systemd user relay for the selected
Unix user, and strictly parses the SOPS Matrix token file for the relay without
sourcing arbitrary environment assignments. The coordinator uses a separate raw-Pi profile and never inherits
`PI_MATRIX_*` credentials.

The resource package also exposes separate ordinary and coordinator adapter
entry points through `passthru.managedSessionExtensions`. They speak only the
private relay protocol, persist binding/delivery provenance in Pi session
history, and preserve Pi's normal prompt-template, skill, and extension-command
expansion. They are deliberately absent from default settings and the default
Pi wrapper; an enabled managed-session host must select exactly one profile.
The ordinary profile provides `/remote on <concept>`, `/remote status`, and
`/remote delete --confirm`; there is no `/remote off` operation and no ordinary
host-wide lifecycle tool surface. Initial binding requires the host-owned
`PI_MANAGED_SESSION_ROOT_KEY`, `PI_MANAGED_SESSION_WORKSPACE`, and optional
`PI_MANAGED_SESSION_RELATIVE_CWD` placement environment in addition to the
private socket and attachment nonce.

After binding, adapters classify persisted Pi branch entries and offer only
terminal-origin text turns and final assistant answers. Matrix-origin users are
mapped to their existing operator events rather than echoed. The relay records
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
  hostId = "workstation";
  workspaceRoots.projects = "/home/operator/documents/projects";
  launcherPackage = pkgs.tmux_project;
};
```

The relay atomically creates the private neutral coordinator workspace and Pi
session before creating the host Space and coordinator room. Authorized room
text is persisted before the trusted `tmux_project managed
coordinator-ensure` hook recreates `default/coordinator`. The coordinator
session and binding survive restart; an inaccessible coordinator room is
replaced against that same session and host Space.

The coordinator-only profile exposes typed workspace and conversation
list/status/start/resume/stop/delete tools. Starting a project conversation
accepts only a named root, immediate-child workspace, safe relative cwd,
optional project Space name, and immutable concept. The relay resolves placement
through the fixed launcher, durably creates the Pi session and binding boundary
before Matrix rooms, and launches the ordinary adapter through the trusted
`direnv exec`/Pi dispatch. No objective or orientation is lifecycle metadata:
the first Matrix text is the first task. Project room text routes directly
without host addressing; dormant input resumes the same persisted session.
Stop terminates only the exact managed window, while confirmed bridge deletion
leaves the Pi session, process/window, workspace, and project files intact.

Managed room controls retain Pi's established control semantics while using
host-owned room routing: ordinary text is an idle prompt or busy follow-up; typed help, status, authenticated scoped model selection, thinking selection, measured compaction, stop, abort, and steer operations never become model prompts. State-changing controls reject busy runs, model catalogues narrow through bounded polls, and `!new` fails safely until generation transition support is available. Valid replies to bot events use their unquoted fallback text. Dormant steer/abort never wake Pi and receive one stable notice; an abort
queued during wake cancels that wake input. The `remote_checkpoint` tool emits
one durable structured question, blocker, or issue-completion boundary, then
hard-aborts the run until a new operator reply. Accepted input, persisted
unfinished work, checkpoint/final projection, launch failure, explicit
cancellation, and restart recovery all reuse stable identities so retries do
not lose or duplicate operator turns.

## Managed Matrix operations

The legacy per-Pi `remote-session` bridge and `services.pi-harness.remoteSession`
option are not loaded or exposed. Legacy rooms, bindings, and sidecar state are
not imported. Enabled hosts use only the relay-owned managed-session path above.
See [`docs/managed-matrix-sessions.md`](docs/managed-matrix-sessions.md) for the
operator runbook, health checks, token rotation, restart recovery, controls,
transcript policy, troubleshooting, and deferred scope.

## AgentGraph Mode

The AgentGraph extension is sourced from the `agentgraph` flake input and wired
into the packaged Pi wrapper. It exposes `/ag on`, `/ag off`, `/ag status`,
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
it for that session. The persisted setting is stored under `pi-codex-fast` in
Pi's normal settings files.

## Delegated Worker Runner

The included `worker-runner` extension registers `run_worker`, a tool for noisy checks and commands. It runs a command in the current repository, writes the full log under `.pi/tmp/workers/`, and asks a bounded read-only Pi SDK worker to return a concise summary for the parent agent.

Use it for tests, typechecks, builds, and integration checks where dumping raw output into the main context would be wasteful. The parent agent supplies the command and a plain-language task describing what the worker should extract or diagnose. The worker defaults to `openai-codex/gpt-5.3-codex-spark` and falls back to the current session model only when Spark is unavailable.

Use `/worker-model` to keep the fast Spark/Luna toggle, or use `/worker-model spark`, `/worker-model luna`, and `/worker-model status`. `/worker-model select` opens a fuzzy selector over registered, authenticated Pi models; `/worker-model provider/model` provides the same capability for RPC, Matrix, or other non-interactive sessions. The selection persists in Pi's global settings under `pi-worker-runner`, so it applies to future Pi sessions. Legacy mode-only settings migrate automatically. Luna and explicitly selected custom models are never silently replaced with Spark or the parent model. `PI_HARNESS_WORKER_MODEL=provider/model` remains the highest-priority environment override and is shown as active by `/worker-model status`.

Do not use `run_worker` for subjective code review. The dedicated `review_agents` tool uses a review-specific model, prompt, and shared pinned diff.

`run_worker` is disabled in AgentGraph restricted mode because arbitrary command execution would bypass the graph-mode tool boundary.

## Code Review Agents

The `review-agents` extension registers `review_agents` for the curated two-axis `code-review` skill. It captures one merge-base diff and commit list, stores them under `.pi/tmp/reviews/`, and runs the Standards and Spec tasks concurrently in isolated read-only Pi SDK sessions.

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
- `architecture_commands` lists project-defined deterministic architecture
  commands from `.pi/architecture.json`.
- `architecture_command` runs a named project-defined architecture command.
- `architecture_queries` lists project-defined parameterized architecture
  queries from `.pi/architecture.json`.
- `architecture_query` runs a named architecture query with structured JSON
  arguments, returning summary, artifact paths, and provenance.

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
`gpt-5.4-mini`; set `PI_CODEX_WEB_SEARCH_MODEL` to override it.

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
worker and supervisor responsibilities, retry boundaries, verification
discovery, interruption recovery, and attempt artifacts.

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

The `github_issue_inspect`, `github_issue_mutate`, `github_issue_plan`,
`github_issue_relationship`, and `github_issue_graph` tools provide a typed,
dry-run-first boundary for current-repository issue work. They resolve GitHub
REST database IDs internally; callers use ordinary issue numbers.

### tk migration

`tk` remains available only while older projects migrate. From a tk-backed
project, run:

```bash
nix run github:BeaudanBrown/pi-harness#migrate-tk
```

Then invoke `/skill:migrate-tk-to-github`. Its inventory phase reviews every
source ticket with code, Git, and GitHub evidence and asks about stale or
ambiguous work. It never creates issues or removes `.tickets/` before later
approved publication and reconciliation phases.

## Legacy tk Support

Ordinary Pi sessions load the GitHub-native `/aloop` command, but do not load
`tk` or `/aplan`. `tk` is supplied only by `pi-migrate-tk` while a project
completes the explicit, approval-gated GitHub migration described above.

## Local Workflow

For extension and prompt iteration in this repository, edit `config/agent` and
run the fast verification gate:

```bash
nix run .#verify
```

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
  Dependencies, SDKs, generated files, and project configs remain owned by the
  repository being edited; the harness reports those failures rather than
  installing packages or inventing language-specific setup.
- `docs/lsp-current-behavior.md` records the packaged Pi LSP behavior, fixed
  reliability boundaries, known remaining failure modes, and the boundary
  between harness fixes and project-owned language-server configuration.
- LSP patch changes should pass both the fast gate and live LSP gate. The live
  gate starts fake and real fallback servers to cover document sync, startup
  guidance, fallback mappings, TypeScript, and Nix smoke behavior.

## Verification

```bash
nix run .#verify
nix run .#verify-lsp-live
```
