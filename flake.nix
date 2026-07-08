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
        piHarnessResources = pkgs.callPackage ./nix/pi-harness-resources.nix {
          inherit piPackage;
        };
        ticketPackage = pkgs.callPackage ./nix/ticket.nix { };
        piHarnessPackage = pkgs.callPackage ./nix/package.nix {
          inherit
            piPackage
            piHarnessResources
            agentgraphPackage
            agentgraphPostgresPackage
            agentgraphPiResources
            piLspExtension
            ticketPackage
            ;
          fzf = pkgs.fzf;
          tmux = pkgs.tmux;
          d2 = pkgs.d2;
          graphviz = pkgs.graphviz;
          xdgUtils = pkgs.xdg-utils;
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
          jdt-language-server
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
                  --extension "$PWD/config/agent/extensions/diagram-tools/index.ts" \
                  --extension "$PWD/config/agent/extensions/worker-runner/index.ts" \
                  --extension "$PWD/config/agent/extensions/nix-runtime/index.ts" \
                  --extension "$PWD/config/agent/extensions/codex-fast/index.ts" \
                  --extension "$PWD/config/agent/extensions/tmux-cursor-focus/index.ts" \
                  --extension "$PWD/config/agent/extensions/sesh/index.ts" \
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
        typeSetup = ''
          types_root=.pi-types/node_modules
          mkdir -p "$types_root/@earendil-works" "$types_root/@types"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent "$types_root/@earendil-works/pi-coding-agent"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core "$types_root/@earendil-works/pi-agent-core"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai "$types_root/@earendil-works/pi-ai"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui "$types_root/@earendil-works/pi-tui"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@types/node "$types_root/@types/node"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox "$types_root/typebox"
        '';
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
            test -f config/agent/extensions/diagram-tools/index.ts
            test -f config/agent/extensions/worker-runner/index.ts
            test -f config/agent/extensions/nix-runtime/index.ts
            test -f config/agent/extensions/codex-fast/index.ts
            test -f config/agent/extensions/tmux-cursor-focus/index.ts
            test -f config/agent/extensions/sesh/index.ts
            test -d config/agent/skills
            test -d config/agent/prompts
            test -d config/agent/themes
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/web-search/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/agent-loop/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/diagram-tools/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/worker-runner/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/nix-runtime/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/codex-fast/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/tmux-cursor-focus/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/sesh/index.ts
            test -d ${piHarnessResources}/share/pi-harness/agent/extensions/node_modules/typebox
            test -d ${piHarnessResources}/share/pi-harness/agent/skills
            test -d ${piHarnessResources}/share/pi-harness/agent/prompts
            test -d ${piHarnessResources}/share/pi-harness/agent/themes
            test -L ${piHarnessPackage}/share/pi-harness/agent
            test -f ${agentgraphPiResources}/share/agentgraph-pi/extensions/agentgraph/index.ts
            test -f ${agentgraphPiResources}/share/agentgraph-pi/skills/agentgraph-operator/SKILL.md
            test -f ${agentgraphPiResources}/share/agentgraph-pi/prompts/graph-change.md
            test -e ${piHarnessPackage}/bin/ag
            test -e ${piHarnessPackage}/bin/agentgraph-postgres
            test -e ${piHarnessPackage}/bin/tk
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/web-search/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/diagram-tools/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/worker-runner/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/codex-fast/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/tmux-cursor-focus/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/sesh/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--skill \"${piHarnessResources}/share/pi-harness/agent/skills\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"\$agentgraph_extensions_dir/agentgraph/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--prompt-template \"\$agentgraph_prompts_dir\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "install|remove|uninstall|update|list|config)" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export AGENTGRAPH_CLI=\"\''${AGENTGRAPH_CLI:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export AGENTGRAPH_POSTGRES=\"\''${AGENTGRAPH_POSTGRES:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export PI_HARNESS_FZF=\"\''${PI_HARNESS_FZF:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export PI_HARNESS_TMUX=\"\''${PI_HARNESS_TMUX:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export PI_HARNESS_D2=\"\''${PI_HARNESS_D2:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export PI_HARNESS_DOT=\"\''${PI_HARNESS_DOT:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export PI_HARNESS_IMAGE_VIEWER=\"\''${PI_HARNESS_IMAGE_VIEWER:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "PI_HARNESS_AGENTGRAPH_ROOT" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "PI_HARNESS_AGENTGRAPH_SKILLS_DIR" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export AGENTGRAPH_PI_RESOURCES=\"\$agentgraph_root\"" ${piHarnessPackage}/bin/pi >/dev/null
            ${piHarnessPackage}/bin/tk help >/dev/null
            test -f ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/index.ts
            grep -F '".nix": "nix"' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/shared/language-map.ts >/dev/null
            grep -F '"dockerfile": "dockerfile"' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/shared/language-map.ts >/dev/null
            grep -F '".hs": "haskell"' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/shared/language-map.ts >/dev/null
            grep -F 'nix: { command: "nil", args: [] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'haskell: { command: "haskell-language-server-wrapper", args: ["--lsp"] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'dockerfile: { command: "docker-langserver", args: ["--stdio"] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'bash: { command: "bash-language-server", args: ["start"] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'const runningStatuses = statuses.filter((s) => s.running);' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/tools/symbols.ts >/dev/null
            jq -e '.extensions | index("./extensions/agent-loop/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/diagram-tools/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/worker-runner/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/nix-runtime/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/codex-fast/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/tmux-cursor-focus/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/sesh/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null

            ${typeSetup}
            tsc --noEmit --project tsconfig.json
            test_build_dir=$(mktemp -d)
            tsc --project tsconfig.test.json --outDir "$test_build_dir"
            node --test "$test_build_dir/tests/agent-loop-progress.test.js"
          '';
        };
        verifyLspLiveApp = pkgs.writeShellApplication {
          name = "verify-lsp-live";
          runtimeInputs = [
            pkgs.coreutils
            pkgs.nodejs
            pkgs.typescript
          ] ++ lspPackages;
          text = ''
            set -euo pipefail
            for command_name in \
              typescript-language-server rust-analyzer ocamllsp nil pyright-langserver \
              gopls jdtls clangd lua-language-server bash-language-server \
              vscode-json-language-server vscode-html-language-server vscode-css-language-server \
              yaml-language-server docker-langserver taplo marksman terraform-ls; do
              command -v "$command_name" >/dev/null
            done
            ${typeSetup}
            test_build_dir=$(mktemp -d)
            tsc --project tsconfig.test.json --outDir "$test_build_dir"
            PI_LSP_EXTENSION=${piLspExtension}/share/pi-lsp-extension \
              PI_LSP_EXTENSION_SOURCE=${piLspExtension}/share/pi-lsp-extension/src \
              node --test "$test_build_dir/tests/lsp-live.test.js"
          '';
        };
      in
      {
        packages.pi-harness = piHarnessPackage;
        packages.pi-harness-resources = piHarnessResources;
        packages.pi-lsp-extension = piLspExtension;
        packages.tk = ticketPackage;
        packages.pi = piPackage;
        packages.default = piHarnessPackage;

        apps.verify = flake-utils.lib.mkApp { drv = verifyApp; };
        apps.verify-lsp-live = flake-utils.lib.mkApp { drv = verifyLspLiveApp; };
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
            pkgs.d2
            pkgs.graphviz
            pkgs.xdg-utils
          ] ++ lspPackages;

          shellHook = ''
            ${typeSetup}
          '';
        };
      }
    )
    // {
      nixosModules.default = import ./nix/module.nix;
      nixosModules.pi-harness = import ./nix/module.nix;
    };
}
