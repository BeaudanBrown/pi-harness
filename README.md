# pi-harness

Thin shared configuration for the Pi coding agent.

This repository is intentionally small. It does not implement a workstream
manager, tmux switcher, TUI, runtime registry, or context attachment model.
Pi already provides the interactive agent UI, session storage, branching,
compaction, tools, extensions, skills, prompt templates, and themes. Session
layout is handled outside Pi with regular tmux.

## What This Flake Provides

- the upstream `pi` CLI from `llm-agents.nix`
- a Nix package named `pi-harness`
- a Nix resource package named `pi-harness-resources`
- a NixOS module named `nixosModules.pi-harness`
- shared Pi resources under `config/agent/`
- a small web search extension under `config/agent/extensions/web-search`
- a Nix runtime guidance extension under `config/agent/extensions/nix-runtime`
- a Codex fast-mode extension under `config/agent/extensions/codex-fast`
- a tmux cursor focus extension under `config/agent/extensions/tmux-cursor-focus`
- a tmux/fzf session picker command under `config/agent/extensions/sesh`
- a delegated noisy-command runner under `config/agent/extensions/worker-runner`
- reusable architecture diagram tools under `config/agent/extensions/diagram-tools`
- an `architecture-diagrams` skill for live diagrams, deterministic generated evidence, and durable architecture docs
- the `tk` git-backed ticket CLI for agent task tracking
- supervised `/aplan` and `/aloop` commands under `config/agent/extensions/agent-loop`
- the AgentGraph pi resources imported from the AgentGraph flake input
- empty skill, prompt, and theme directories for future additions

The packaged `pi-harness` binary wraps upstream `pi` and passes explicit local
resource paths from the Nix store with `--extension`, `--skill`,
`--prompt-template`, and `--theme`. It does not depend on mutable `pi install`
state or on copying generated settings into `~/.pi/agent`.

Harness-owned resources are packaged separately as `pi-harness-resources` and
expose `passthru.piResources` for future Nix-packaged Pi extensions. AgentGraph
resources are consumed from the AgentGraph flake input by path, not copied into
this repository's package output.

The harness defaults do not overwrite pre-set `AGENTGRAPH_CLI` or
`AGENTGRAPH_POSTGRES`. Development launchers such as AgentGraph's `pi-ag` can
keep web search, agent-loop, tk, prompts/themes, models, and LSP from the global
harness while shadowing only the packaged AgentGraph runtime and resources for
that process.

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

Use it for tests, typechecks, builds, and integration checks where dumping raw output into the main context would be wasteful. The parent agent supplies the command and a plain-language task describing what the worker should extract or diagnose. The worker model defaults to `litellm/sub-gpt-5.3-codex-spark` when available and can be overridden with `PI_HARNESS_WORKER_MODEL=provider/model`; otherwise it falls back to the current session model.

`run_worker` is disabled in AgentGraph restricted mode because arbitrary command execution would bypass the graph-mode tool boundary.

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
research. It calls the OpenAI Responses API with `gpt-5-mini` by default and
can be pointed at a compatible proxy with environment variables:

```text
PI_WEB_SEARCH_BASE_URL
PI_WEB_SEARCH_MODEL
PI_WEB_SEARCH_API_KEY
PI_WEB_SEARCH_API_KEY_COMMAND
```

If no Pi-specific key is set, the extension falls back to `OPENAI_API_KEY`.

## Agent Planning And Loops

The packaged harness includes `tk`, the git-backed ticket CLI from
`wedow/ticket`. Tickets live as Markdown files under `.tickets/`, which keeps
large task graphs readable to agents and reviewable in git.

The included `agent-loop` extension registers `/aplan` and `/aloop`:

```text
/aplan "Add pitch support to the course manager"
/aplan create "Small well-understood cleanup"
/aloop 5 <epic-or-subtree-root-id> --verify "nix run .#verify"
/aloop status <epic-or-subtree-root-id>
```

`/aplan` starts a clarification and specification workflow inspired by
`/grill-with-docs`: it inspects docs and code, sharpens fuzzy language, asks
high-value questions, and then creates a `tk` epic plus child tickets when the
plan is ready. `/aloop` supervises fresh child Pi processes one at a time. Each
iteration selects a ready `tk` ticket from the requested subtree, implements only
that ticket, updates `tk`, verifies, commits exactly one worker commit containing
code plus `.tickets/` changes, closes a root epic once all descendants are
complete, and leaves the worktree clean before continuing. Epics are preferred
for planned multi-ticket work, but `/aloop` treats any ticket with children as a
subtree container and warns when a non-epic ticket is used that way.

If an iteration needs reboot or other out-of-process validation, the worker can
finish with `ALOOP_RESULT: needs_reboot`. The supervisor treats that as a
successful handoff, allows the selected ticket to remain open/in progress,
verifies that one worker commit and tk updates exist, verifies the worktree is
clean, and then stops the live loop for the external resume path.

Useful `/aloop` options are `--timeout 45m`, `--model provider/model`,
`--verify <cmd>`, and `--allow-dirty`. Iterations default to a 30 minute timeout;
on timeout the supervisor terminates the child process group and runs a best-effort
`bash ./bin/in-env dev-stop` when the repo provides that wrapper. The extension
refuses a dirty worktree by default and never pushes; the child prompt also
instructs workers never to push. Workers are instructed to squash or amend any
intermediate commits before returning so one iteration maps to one coherent
commit.

When `/ag on` is active in the supervising session, `/aloop` starts child Pi
processes in AgentGraph-compatible loop mode. Those children cannot use direct
`edit`, `write`, or `bash`; they use `agentgraph_*` tools for source changes,
`agent_loop_tk` for ticket updates, `agent_loop_git` for status/staging/commits,
and `agent_loop_verify` for the supervisor-provided `--verify` command.

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
