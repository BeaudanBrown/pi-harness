{
  description = "Thin Pi configuration harness for NixOS hosts";

  nixConfig = {
    extra-substituters = [ "https://cache.numtide.com" ];
    extra-trusted-public-keys = [
      "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g="
    ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix-ai-tools = {
      url = "github:numtide/llm-agents.nix";
      inputs.bun2nix.url = "https://codeload.github.com/nix-community/bun2nix/tar.gz/2499dedd70744dba1815875b854818a3019e9e4c";
    };
    agentgraph = {
      url = "git+ssh://git@github.com/BeaudanBrown/agentgraph.git";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    pi-lsp-extension-src = {
      url = "github:samfoy/pi-lsp-extension/73251632ad116c973844cc28fb1210417295c6fe";
      flake = false;
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      nix-ai-tools,
      agentgraph,
      pi-lsp-extension-src,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (pkgs) lib;
        piPackage = nix-ai-tools.packages.${system}.pi;
        agentgraphPackage = agentgraph.packages.${system}.ag-unchecked;
        agentgraphPostgresPackage = agentgraph.packages.${system}.agentgraph-postgres;
        agentgraphPiResources = agentgraph.packages.${system}.agentgraph-pi-resources;
        piLspExtension = pkgs.callPackage ./nix/pi-lsp-extension.nix {
          piLspExtensionSrc = pi-lsp-extension-src;
        };
        ticketPackage = pkgs.callPackage ./nix/ticket.nix { };
        piHarnessPackage = pkgs.callPackage ./nix/package.nix {
          inherit piPackage agentgraphPackage agentgraphPostgresPackage agentgraphPiResources piLspExtension ticketPackage;
        };
        lspPackages = with pkgs; [
          nodejs
          nil
          nixd
          typescript-language-server
          typescript
          pyright
          ruff
          rust-analyzer
          ocamlPackages.ocaml-lsp
          gopls
          clang-tools
          lua-language-server
          marksman
          taplo
          yaml-language-server
          vscode-langservers-extracted
          bash-language-server
          dockerfile-language-server
          terraform-ls
          tailwindcss-language-server
        ];
        piDevWrapper = pkgs.writeShellApplication {
          name = "pi";
          text = ''
            case "''${1-}" in
              install|remove|uninstall|update|list|config)
                exec ${lib.getExe piPackage} "$@"
                ;;
              *)
                exec ${lib.getExe piPackage} \
                  --extension "$PWD/config/agent/extensions/web-search/index.ts" \
                  --extension "$PWD/config/agent/extensions/agent-loop/index.ts" \
                  --extension "${agentgraphPiResources}/share/agentgraph-pi/extensions/agentgraph/index.ts" \
                  --extension "${piLspExtension}/share/pi-lsp-extension/src/index.ts" \
                  --skill "$PWD/config/agent/skills" \
                  --skill "${agentgraphPiResources}/share/agentgraph-pi/skills" \
                  --prompt-template "$PWD/config/agent/prompts" \
                  --prompt-template "${agentgraphPiResources}/share/agentgraph-pi/prompts" \
                  --theme "$PWD/config/agent/themes" \
                  "$@"
                ;;
            esac
          '';
        };
        verifyApp = pkgs.writeShellApplication {
          name = "verify";
          runtimeInputs = [
            pkgs.coreutils
            pkgs.jq
            pkgs.nodejs
            pkgs.typescript
          ];
          text = ''
            set -euo pipefail
            test -f config/agent/settings.json
            jq empty config/agent/settings.json
            test -d config/agent/extensions
            test -f config/agent/extensions/web-search/index.ts
            test -f config/agent/extensions/agent-loop/index.ts
            test -d config/agent/skills
            test -d config/agent/prompts
            test -d config/agent/themes
            test -f ${piHarnessPackage}/share/pi-harness/agent/extensions/agentgraph/index.ts
            test -f ${piHarnessPackage}/share/pi-harness/agent/skills/agentgraph-operator/SKILL.md
            test -f ${piHarnessPackage}/share/pi-harness/agent/prompts/graph-change.md
            test -e ${piHarnessPackage}/bin/ag
            test -e ${piHarnessPackage}/bin/agentgraph-postgres
            test -e ${piHarnessPackage}/bin/tk
            grep -F "export AG_DEV_ROOT=\"\''${AG_DEV_ROOT:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export AGENTGRAPH_CLI=\"\''${AGENTGRAPH_CLI:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export AGENTGRAPH_POSTGRES=\"\''${AGENTGRAPH_POSTGRES:-" ${piHarnessPackage}/bin/pi >/dev/null
            ${piHarnessPackage}/bin/tk help >/dev/null
            test -f ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/index.ts
            jq -e '.extensions | index("./extensions/agentgraph/index.ts")' \
              ${piHarnessPackage}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/agent-loop/index.ts")' \
              ${piHarnessPackage}/share/pi-harness/agent/settings.json >/dev/null

            types_root=.pi-types/node_modules
            mkdir -p "$types_root/@earendil-works" "$types_root/@types"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent "$types_root/@earendil-works/pi-coding-agent"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core "$types_root/@earendil-works/pi-agent-core"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai "$types_root/@earendil-works/pi-ai"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui "$types_root/@earendil-works/pi-tui"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@types/node "$types_root/@types/node"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox "$types_root/typebox"
            tsc --noEmit --project tsconfig.json
            test_build_dir=$(mktemp -d)
            tsc --project tsconfig.test.json --outDir "$test_build_dir"
            node --test "$test_build_dir/tests/agent-loop-progress.test.js"
          '';
        };
      in
      {
        packages.pi-harness = piHarnessPackage;
        packages.pi-lsp-extension = piLspExtension;
        packages.tk = ticketPackage;
        packages.pi = piPackage;
        packages.default = piHarnessPackage;

        apps.verify = flake-utils.lib.mkApp { drv = verifyApp; };
        apps.default = flake-utils.lib.mkApp {
          drv = piHarnessPackage;
          exePath = "/bin/pi";
        };
        apps.pi = flake-utils.lib.mkApp {
          drv = piHarnessPackage;
          exePath = "/bin/pi";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            # piDevWrapper
            agentgraphPackage
            agentgraphPostgresPackage
            ticketPackage
            pkgs.jq
            pkgs.tmux
          ] ++ lspPackages;

          shellHook = ''
            types_root=.pi-types/node_modules
            mkdir -p "$types_root/@earendil-works" "$types_root/@types"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent "$types_root/@earendil-works/pi-coding-agent"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core "$types_root/@earendil-works/pi-agent-core"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai "$types_root/@earendil-works/pi-ai"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui "$types_root/@earendil-works/pi-tui"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@types/node "$types_root/@types/node"
            ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox "$types_root/typebox"
          '';
        };
      }
    )
    // {
      nixosModules.default = import ./nix/module.nix;
      nixosModules.pi-harness = import ./nix/module.nix;
    };
}
