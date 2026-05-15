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
- empty skill, prompt, and theme directories for future additions

The starting configuration loads the web search extension and no other
extensions.

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
            user = "beau";
          };
        }
      ];
    };
  };
}
```

When Home Manager is available in the NixOS module graph, the module links the
shared files into:

```text
~/.pi/agent/settings.json
~/.pi/agent/extensions
~/.pi/agent/skills
~/.pi/agent/prompts
~/.pi/agent/themes
```

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
