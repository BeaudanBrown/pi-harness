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
- the AgentGraph pi resources imported from the AgentGraph flake input
- empty skill, prompt, and theme directories for future additions

The packaged configuration loads web search plus the AgentGraph mode extension.
The working-tree development wrapper loads the AgentGraph resources directly
from the flake input so the extension source stays in the AgentGraph repo.

The packaged `pi-harness` binary is intentionally just the upstream `pi` CLI.
Installed/system usage loads this repository's shared resources through Pi's
normal configuration files, which the NixOS module links into `~/.pi/agent`.
This keeps package execution and Pi's own auto-discovery from loading the same
extension twice.

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
and `agentgraph_*` tools remain available. The extension also starts a shared
local PostgreSQL server with per-project databases via `agentgraph-postgres`.

The reusable extension, prompts, PostgreSQL helper, and AgentGraph operator skill
are maintained in the AgentGraph repo, not duplicated here.

AgentGraph LLM execution happens inside `ag agent run-cycle`, so provider
secrets must be available as runtime environment variables to the `ag` process.
The NixOS module can install a wrapper that sources a SOPS-managed env file
before launching Pi:

```nix
services.pi-harness.agentgraph.environmentFile =
  config.sops.templates."agentgraph-litellm.env".path;
```

When set, this installs `pi-agentgraph` by default. Launching `pi-agentgraph`
lets the AgentGraph extension's `agentgraph_run_cycle` tool inherit variables
such as `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and
`AG_LITELLM_DEFAULT_MODEL` without storing secrets in the Nix store.

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

## Verification

```bash
nix run .#verify
```
