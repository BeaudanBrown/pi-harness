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
- a NixOS module named `nixosModules.pi-harness`
- shared Pi config under `config/agent/`
- a small web search extension under `config/agent/extensions/web-search`
- a Nix runtime guidance extension under `config/agent/extensions/nix-runtime`
- the `tk` git-backed ticket CLI for agent task tracking
- supervised `/aplan` and `/aloop` commands under `config/agent/extensions/agent-loop`
- the AgentGraph pi resources imported from the AgentGraph flake input
- empty skill, prompt, and theme directories for future additions

The packaged configuration loads web search plus the AgentGraph mode extension.
The working-tree development wrapper loads the AgentGraph resources directly
from the flake input so the extension source stays in the AgentGraph repo.

The packaged `pi-harness` binary is intentionally just the upstream `pi` CLI
with harness defaults for AgentGraph helpers. Installed/system usage loads this
repository's shared resources through Pi's normal configuration files, which the
NixOS module links into `~/.pi/agent`. This keeps package execution and Pi's own
auto-discovery from loading the same extension twice.

The harness defaults do not overwrite pre-set `AG_DEV_ROOT`, `AGENTGRAPH_CLI`,
or `AGENTGRAPH_POSTGRES`. Development launchers such as AgentGraph's `pi-ag`
can therefore keep web search, agent-loop, tk, prompts/themes, models, and LSP
from the global harness while shadowing only the packaged AgentGraph runtime and
resources for that process.

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

The module installs the packaged `pi` binary. In this setup, Home Manager can
link the packaged shared resources into Pi's normal config directory:

```text
~/.pi/agent/settings.json
~/.pi/agent/extensions
~/.pi/agent/skills
~/.pi/agent/prompts
~/.pi/agent/themes
```

## AgentGraph Mode

The AgentGraph extension is sourced from the `agentgraph` flake input and wired
into the packaged Pi config. It exposes `/ag on`, `/ag off`, `/ag status`,
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
`agentgraph` flake input to pick up tool-surface changes.

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
that ticket, updates `tk`, verifies, commits code plus `.tickets/` changes,
closes a root epic once all descendants are complete, and leaves the worktree
clean before continuing. Epics are preferred for planned multi-ticket work, but
`/aloop` treats any ticket with children as a subtree container and warns when a
non-epic ticket is used that way.

Useful `/aloop` options are `--timeout 45m`, `--model provider/model`,
`--verify <cmd>`, and `--allow-dirty`. Iterations default to a 30 minute timeout;
on timeout the supervisor terminates the child process group and runs a best-effort
`bash ./bin/in-env dev-stop` when the repo provides that wrapper. The extension
refuses a dirty worktree by default and never pushes; the child prompt also
instructs workers never to push.

When `/ag on` is active in the supervising session, `/aloop` starts child Pi
processes in AgentGraph-compatible loop mode. Those children cannot use direct
`edit`, `write`, or `bash`; they use `agentgraph_*` tools for source changes,
`agent_loop_tk` for ticket updates, `agent_loop_git` for status/staging/commits,
and `agent_loop_verify` for the supervisor-provided `--verify` command.

## Local Workflow

For extension and prompt iteration in this repository, enter the development
shell:

```bash
nix develop
pi
```

Inside `nix develop`, `pi` is a wrapper around the upstream CLI that points at
the working-tree `config/agent` resources. This lets edits to extensions,
skills, prompts, and themes take effect without rebuilding the package.

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
