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
- empty extension, skill, prompt, and theme directories for future additions

The starting configuration loads no extensions.

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

## Local Workflow

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
