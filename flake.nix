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
    # pi-r owns a tested native parser/R runtime set; do not substitute the
    # harness Nixpkgs input because Tree-sitter CLI APIs differ across pins.
    pi-r.url = "github:BeaudanBrown/pi-r";
    pi-lsp-extension-src = {
      url = "github:samfoy/pi-lsp-extension/73251632ad116c973844cc28fb1210417295c6fe";
      flake = false;
    };
    mattpocock-skills-src = {
      url = "github:mattpocock/skills/391a2701dd948f94f56a39f7533f8eea9a859c87";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      nix-ai-tools,
      agentgraph,
      pi-r,
      pi-lsp-extension-src,
      mattpocock-skills-src,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (pkgs) lib;
        upstreamPiPackage = nix-ai-tools.packages.${system}.pi;
        piPackage = upstreamPiPackage.overrideAttrs (old: {
          patches = (old.patches or [ ]) ++ [ ./nix/patches/pi-prompt-expanded-hook.patch ];
          postInstall = (old.postInstall or "") + ''
            sdk_root="$out/lib/node_modules/@earendil-works/pi-coding-agent"
            mkdir -p "$sdk_root/node_modules/@earendil-works" "$sdk_root/node_modules/@types"
            cp -R dist package.json "$sdk_root/"
            cp -R node_modules/typebox "$sdk_root/node_modules/typebox"
            cp -R node_modules/@types/node "$sdk_root/node_modules/@types/node"
            for dependency in pi-agent-core pi-ai pi-tui; do
              cp -R "node_modules/@earendil-works/$dependency" "$sdk_root/node_modules/@earendil-works/$dependency"
            done
          '';
        });
        agentgraphPackage = agentgraph.packages.${system}.ag-unchecked;
        agentgraphPostgresPackage = agentgraph.packages.${system}.agentgraph-postgres;
        agentgraphPiResources = agentgraph.packages.${system}.agentgraph-pi-resources;
        piRPackage = pi-r.packages.${system}.pi-r;
        harnessSourceRevision = self.rev or self.dirtyRev or self.narHash or "unversioned";
        piRSourceRevision = pi-r.rev or pi-r.dirtyRev or pi-r.narHash or "unversioned";
        piLspExtension = pkgs.callPackage ./nix/pi-lsp-extension.nix {
          piLspExtensionSrc = pi-lsp-extension-src;
        };
        piHarnessResources = pkgs.callPackage ./nix/pi-harness-resources.nix {
          inherit piPackage;
        };
        managedSessionRelay = pkgs.callPackage ./nix/managed-session-relay.nix {
          inherit piPackage;
        };
        mattPocockSkillsResources = pkgs.callPackage ./nix/mattpocock-skills-resources.nix {
          mattPocockSkillsSrc = mattpocock-skills-src;
        };
        ticketPackage = pkgs.callPackage ./nix/ticket.nix { };
        playwrightAgentCli = pkgs.callPackage ./nix/playwright-agent-cli.nix { };
        piHarnessPackage = pkgs.callPackage ./nix/package.nix {
          inherit
            piPackage
            piHarnessResources
            mattPocockSkillsResources
            agentgraphPackage
            agentgraphPostgresPackage
            agentgraphPiResources
            piRPackage
            piLspExtension
            managedSessionRelay
            playwrightAgentCli
            ;
          harnessRevision = harnessSourceRevision;
          piRRevision = piRSourceRevision;
          fzf = pkgs.fzf;
          tmux = pkgs.tmux;
          d2 = pkgs.d2;
          graphviz = pkgs.graphviz;
          xdgUtils = pkgs.xdg-utils;
          jq = pkgs.jq;
        };
        managedSessionLauncher = pkgs.writeShellApplication {
          name = "tmux_project";
          runtimeInputs = [ pkgs.coreutils pkgs.direnv pkgs.findutils pkgs.gawk pkgs.jq pkgs.tmux ];
          text = ''
            set -euo pipefail
            [[ "''${1-}" == managed ]]
            operation="''${2-}"
            request=$(cat)
            : "''${PI_MANAGED_TEST_TMUX_SOCKET:?}"
            format='#{window_id}|#{pane_id}'
            case "$operation" in
              workspace-list)
                : "''${PI_MANAGED_TEST_WORKSPACE_ROOT:?}"
                find "$PI_MANAGED_TEST_WORKSPACE_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | \
                  jq -Rsc 'split("\n") | map(select(length > 0) | {rootKey:"projects",workspace:.}) | {workspaces:.}'
                ;;
              workspace-resolve|root-ensure)
                : "''${PI_MANAGED_TEST_WORKSPACE_ROOT:?}"
                root_key=$(jq -er '.rootKey' <<<"$request")
                workspace=$(jq -er '.workspace' <<<"$request")
                relative_cwd=$(jq -er '.relativeCwd' <<<"$request")
                [[ "$root_key" == projects && "$workspace" != */* && "$workspace" != .* && "$relative_cwd" != /* && "$relative_cwd" != *..* ]]
                workspace_path=$(realpath "$PI_MANAGED_TEST_WORKSPACE_ROOT/$workspace")
                cwd=$(realpath "$workspace_path/''${relative_cwd:-.}")
                [[ "$cwd" == "$workspace_path" || "$cwd" == "$workspace_path/"* ]]
                if [[ "$operation" == root-ensure ]]; then
                  if ! tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" has-session -t "=$workspace" 2>/dev/null; then
                    tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" new-session -d -s "$workspace" -n shell -c "$workspace_path"
                  fi
                  jq -cn --arg sessionName "$workspace" --arg workspacePath "$workspace_path" '{sessionName:$sessionName,workspacePath:$workspacePath}'
                else
                  jq -cn --arg rootKey "$root_key" --arg workspace "$workspace" --arg relativeCwd "$relative_cwd" \
                    --arg workspacePath "$workspace_path" --arg cwd "$cwd" '{rootKey:$rootKey,workspace:$workspace,relativeCwd:$relativeCwd,workspacePath:$workspacePath,cwd:$cwd}'
                fi
                ;;
              window-inspect)
                conversation_id=$(jq -er 'if (keys == ["conversationId"]) and (.conversationId | test("^conv_[a-f0-9]{32}$")) then .conversationId else error("invalid request") end' <<<"$request")
                matches=$(tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" list-windows -a -F "$format|#{session_name}|#{@managed_pi_conversation_id}" 2>/dev/null | awk -F '|' -v id="$conversation_id" '$4 == id { print $1 "|" $2 "|" $3 }' || true)
                [[ $(awk 'NF { count++ } END { print count + 0 }' <<<"$matches") -le 1 ]]
                existing=$(awk 'NF { print; exit }' <<<"$matches")
                if [[ -n "$existing" ]]; then
                  IFS='|' read -r window_id pane_id session_name <<<"$existing"
                  jq -cn --arg conversationId "$conversation_id" --arg sessionName "$session_name" --arg windowId "$window_id" --arg paneId "$pane_id" '{conversationId:$conversationId,exists:true,sessionName:$sessionName,windowId:$windowId,paneId:$paneId}'
                else
                  jq -cn --arg conversationId "$conversation_id" '{conversationId:$conversationId,exists:false}'
                fi
                ;;
              coordinator-ensure)
                conversation_id=$(jq -er 'if (keys == ["conversationId"]) and (.conversationId | test("^conv_[a-f0-9]{32}$")) then .conversationId else error("invalid request") end' <<<"$request")
                : "''${PI_MANAGED_TEST_COORDINATOR_PI:?}" "''${PI_MANAGED_TEST_PROVIDER:?}"
                command="$PI_MANAGED_TEST_COORDINATOR_PI --mode rpc --model coordinator-probe/fake --extension $PI_MANAGED_TEST_PROVIDER"
                ! tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" list-windows -a -F '#{@managed_pi_conversation_id}' 2>/dev/null | grep -Fx "$conversation_id" >/dev/null
                if tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" has-session -t '=default' 2>/dev/null; then
                  created=$(tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" new-window -d -P -F "$format" -t '=default:' -n coordinator -c "$PI_MANAGED_COORDINATOR_CWD" "$command")
                else
                  created=$(tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" new-session -d -P -F "$format" -s default -n coordinator -c "$PI_MANAGED_COORDINATOR_CWD" "$command")
                fi
                IFS='|' read -r window_id pane_id <<<"$created"
                tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" set-option -w -t "$window_id" @managed_pi_conversation_id "$conversation_id"
                jq -cn --arg conversationId "$conversation_id" --arg windowId "$window_id" --arg paneId "$pane_id" '{conversationId:$conversationId,sessionName:"default",windowId:$windowId,paneId:$paneId,role:"coordinator"}'
                ;;
              window-create)
                : "''${PI_MANAGED_TEST_WORKSPACE_ROOT:?}" "''${PI_MANAGED_TEST_PROVIDER:?}"
                conversation_id=$(jq -er '.conversationId | select(test("^conv_[a-f0-9]{32}$"))' <<<"$request")
                workspace=$(jq -er '.placement.workspace' <<<"$request")
                relative_cwd=$(jq -er '.placement.relativeCwd' <<<"$request")
                cwd=$(realpath "$PI_MANAGED_TEST_WORKSPACE_ROOT/$workspace/''${relative_cwd:-.}")
                existing=$(tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" list-windows -a -F "$format|#{@managed_pi_conversation_id}" | awk -F '|' -v id="$conversation_id" '$3 == id { print $1 "|" $2; exit }')
                [[ -z "$existing" ]]
                created=$(tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" new-window -d -P -F "$format" \
                    -e "PATH=$PATH" -e "HOME=$HOME" -e "DIRENV_CONFIG=''${DIRENV_CONFIG:-}" -e "PI_CODING_AGENT_DIR=''${PI_CODING_AGENT_DIR:-}" \
                    -e "PI_MANAGED_SESSION_LAUNCH_ROLE=$PI_MANAGED_SESSION_LAUNCH_ROLE" -e "PI_MANAGED_SESSIONS_SOCKET=$PI_MANAGED_SESSIONS_SOCKET" \
                    -e "PI_MANAGED_SESSION_CONVERSATION_ID=$PI_MANAGED_SESSION_CONVERSATION_ID" -e "PI_MANAGED_SESSION_CONCEPT=$PI_MANAGED_SESSION_CONCEPT" \
                    -e "PI_MANAGED_SESSION_BINDING_BOUNDARY_ENTRY_ID=$PI_MANAGED_SESSION_BINDING_BOUNDARY_ENTRY_ID" \
                    -e "PI_MANAGED_SESSION_ATTACHMENT_NONCE=$PI_MANAGED_SESSION_ATTACHMENT_NONCE" -e "PI_MANAGED_PROJECT_SESSION_FILE=$PI_MANAGED_PROJECT_SESSION_FILE" \
                    -e "PI_MANAGED_TEST_PROVIDER=$PI_MANAGED_TEST_PROVIDER" -e "PI_MANAGED_TEST_PROJECT_LOG=''${PI_MANAGED_TEST_PROJECT_LOG:-/dev/null}" \
                    -t "=$workspace:" -n "pi-''${conversation_id: -8}" -c "$cwd" \
                    "exec direnv exec '$cwd' '$PI_MANAGED_TEST_MANAGED_PI' --mode rpc --model coordinator-probe/fake --extension '$PI_MANAGED_TEST_PROVIDER' >>''${PI_MANAGED_TEST_PROJECT_LOG:-/dev/null} 2>&1")
                IFS='|' read -r window_id pane_id <<<"$created"
                tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" set-option -w -t "$window_id" @managed_pi_conversation_id "$conversation_id"
                jq -cn --arg conversationId "$conversation_id" --arg sessionName "$workspace" --arg windowId "$window_id" --arg paneId "$pane_id" \
                  --arg workspace "$workspace" --arg relativeCwd "$relative_cwd" '{conversationId:$conversationId,sessionName:$sessionName,windowId:$windowId,paneId:$paneId,rootKey:"projects",workspace:$workspace,relativeCwd:$relativeCwd,role:"conversation"}'
                ;;
              window-terminate|bridge-clear)
                conversation_id=$(jq -er '.conversationId | select(test("^conv_[a-f0-9]{32}$"))' <<<"$request")
                expected_window=$(jq -er '.windowId // ""' <<<"$request")
                expected_pane=$(jq -er '.paneId // ""' <<<"$request")
                matches=$(tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" list-windows -a -F '#{window_id}|#{pane_id}|#{@managed_pi_conversation_id}' | awk -F '|' -v id="$conversation_id" '$3 == id { print $1 "|" $2 }')
                [[ $(awk 'NF { count++ } END { print count + 0 }' <<<"$matches") -le 1 ]]
                IFS='|' read -r window_id pane_id <<<"$matches"
                if [[ -n "$window_id" && -n "$expected_window" ]]; then [[ "$window_id" == "$expected_window" && "$pane_id" == "$expected_pane" ]]; fi
                if [[ "$operation" == window-terminate ]]; then
                  [[ -n "$window_id" ]]; tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" kill-window -t "$window_id"; jq -cn '{terminated:true}'
                elif [[ -n "$window_id" ]]; then
                  tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" set-option -w -u -t "$window_id" @managed_pi_conversation_id; jq -cn '{cleared:true}'
                else jq -cn '{cleared:false}'; fi
                ;;
              *) exit 2 ;;
            esac
          '';
        };
        managedSessionModuleTest = lib.evalModules {
          specialArgs = { inherit pkgs; };
          modules = [
            {
              options = {
                assertions = lib.mkOption { type = lib.types.listOf lib.types.attrs; default = [ ]; };
                environment.systemPackages = lib.mkOption { type = lib.types.listOf lib.types.package; default = [ ]; };
                users.users = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
                systemd.user.services = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
              };
            }
            ./nix/module.nix
            {
              services.pi-harness = {
                enable = true;
                package = piHarnessPackage;
                managedSessions = {
                  enable = true;
                  user = "operator";
                  environmentFile = "/run/secrets/pi-managed-session.env";
                  homeserver = "https://matrix.example.com";
                  botUserId = "@pi-test:example.com";
                  operatorUserId = "@operator:example.com";
                  hostId = "test-host";
                  workspaceRoots.projects = "/home/operator/projects";
                  launcherPackage = managedSessionLauncher;
                };
              };
            }
          ];
        };
        managedSessionService = managedSessionModuleTest.config.systemd.user.services.pi-managed-session-relay;
        managedSessionPiWrapper = builtins.elemAt managedSessionModuleTest.config.environment.systemPackages 0;
        managedSessionStatusWrapper = builtins.elemAt managedSessionModuleTest.config.environment.systemPackages 1;
        managedSessionCoordinatorPi = builtins.elemAt managedSessionService.path 1;
        managedSessionModuleReport = pkgs.writeText "pi-harness-managed-session-module-test.json" (builtins.toJSON {
          assertions = map (item: item.assertion) managedSessionModuleTest.config.assertions;
          relayUserLingers = managedSessionModuleTest.config.users.users.operator.linger;
          serviceEnvironment = managedSessionService.environment;
          servicePathCount = builtins.length managedSessionService.path;
          execStart = managedSessionService.serviceConfig.ExecStart;
          hasGeneralEnvironmentFile = managedSessionService.serviceConfig ? EnvironmentFile;
          hasPrivateTmp = managedSessionService.serviceConfig ? PrivateTmp;
        });
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
                  --extension "$PWD/config/agent/extensions/github-issues/index.ts" \
                  --extension "$PWD/config/agent/extensions/diagram-tools/index.ts" \
                  --extension "$PWD/config/agent/extensions/worker-runner/index.ts" \
                  --extension "$PWD/config/agent/extensions/review-agents/index.ts" \
                  --extension "$PWD/config/agent/extensions/nix-runtime/index.ts" \
                  --extension "$PWD/config/agent/extensions/codex-fast/index.ts" \
                  --extension "$PWD/config/agent/extensions/tmux-cursor-focus/index.ts" \
                  --extension "$PWD/config/agent/extensions/sesh/index.ts" \
                  --extension "${agentgraphPiResources}/share/agentgraph-pi/extensions/agentgraph/index.ts" \
                  --extension "${piLspExtension}/share/pi-lsp-extension/src/index.ts" \
                  --skill "$PWD/config/agent/skills" \
                  --skill "${mattPocockSkillsResources}/share/pi-harness/mattpocock-skills" \
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
        evalTooling = pkgs.runCommand "pi-harness-eval-tooling" {
          nativeBuildInputs = [ pkgs.typescript ];
        } ''
          mkdir -p source/tests source/tests/fixtures "$out/lib" "$out/bin" "$out/share/pi-harness-eval-self-test"
          cp -r ${./eval} source/eval
          cp ${./tests/eval-contracts.test.ts} source/tests/eval-contracts.test.ts
          cp ${./tests/eval-cli.test.ts} source/tests/eval-cli.test.ts
          cp ${./tests/eval-grading.test.ts} source/tests/eval-grading.test.ts
          cp ${./tests/eval-launcher.test.ts} source/tests/eval-launcher.test.ts
          cp ${./tests/eval-rpc.test.ts} source/tests/eval-rpc.test.ts
          cp ${./tests/eval-trace-metrics.test.ts} source/tests/eval-trace-metrics.test.ts
          cp ${./tests/eval-workspace.test.ts} source/tests/eval-workspace.test.ts
          cp -r ${./tests/fixtures/eval-rpc} source/tests/fixtures/eval-rpc
          cp -r ${./tests/fixtures/eval-traces} source/tests/fixtures/eval-traces
          cat > tsconfig.json <<EOF
          {
            "compilerOptions": {
              "target": "ES2022",
              "module": "NodeNext",
              "moduleResolution": "NodeNext",
              "strict": true,
              "skipLibCheck": true,
              "types": ["node"],
              "typeRoots": ["${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@types"],
              "rootDir": "source",
              "outDir": "$out/lib"
            },
            "include": ["source/eval/**/*.ts", "source/tests/**/*.ts"]
          }
          EOF
          tsc --project tsconfig.json
          cp -r source/eval "$out/share/pi-harness-eval-self-test/eval"
          cp -r source/tests "$out/share/pi-harness-eval-self-test/tests"
          cat > "$out/bin/pi-eval" <<EOF
          #!${pkgs.runtimeShell}
          exec ${lib.getExe pkgs.nodejs} "$out/lib/eval/cli/main.js" "\$@"
          EOF
          chmod +x "$out/bin/pi-eval"
        '';
        evalApp = pkgs.writeShellApplication {
          name = "pi-eval";
          runtimeInputs = [ pkgs.git pkgs.nodejs ] ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.bubblewrap ];
          text = ''
            set -euo pipefail
            export PI_EVAL_LAUNCHER_IDENTITY=${piHarnessPackage}/share/pi-harness/eval/launcher-identity.json
            export PI_EVAL_EXPECTED_PI_VERSION=${lib.escapeShellArg piPackage.version}
            export PI_EVAL_EXPECTED_HARNESS_REVISION=${lib.escapeShellArg harnessSourceRevision}
            export PI_EVAL_EXPECTED_LAUNCHER_ID=pi-r-local
            export PI_EVAL_EXPECTED_LAUNCHER_PATH=${piHarnessPackage}/bin/pi-r-local
            export PI_EVAL_EXPECTED_PI_R_REVISION=${lib.escapeShellArg piRSourceRevision}
            export PI_EVAL_EXPECTED_PI_R_ROOT=${piRPackage.resourcePaths.root}
            export PI_EVAL_EXPECTED_PI_R_EXTENSION=${piRPackage.resourcePaths.extension}
            export PI_EVAL_EXPECTED_PI_R_SKILL=${piRPackage.resourcePaths.skill}
            exec ${evalTooling}/bin/pi-eval "$@"
          '';
        };
        evalSelfTestApp = pkgs.writeShellApplication {
          name = "pi-eval-self-test";
          runtimeInputs = [ pkgs.coreutils pkgs.git pkgs.nodejs ] ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.bubblewrap ];
          text = ''
            set -euo pipefail
            home=$(mktemp -d)
            trap 'rm -rf "$home"' EXIT
            work="$home/work"
            cp -R --no-preserve=mode ${evalTooling}/share/pi-harness-eval-self-test "$work"
            chmod -R u+w "$work"
            cd "$work"
            env -i \
              HOME="$home" \
              TMPDIR="''${TMPDIR:-/tmp}" \
              PATH="$PATH" \
              ${lib.optionalString pkgs.stdenv.isLinux "PI_EVAL_BWRAP=${lib.getExe pkgs.bubblewrap} \\"}
              ${lib.getExe pkgs.nodejs} --test --test-concurrency=1 \
                ${evalTooling}/lib/tests/eval-contracts.test.js \
                ${evalTooling}/lib/tests/eval-cli.test.js \
                ${evalTooling}/lib/tests/eval-grading.test.js \
                ${evalTooling}/lib/tests/eval-launcher.test.js \
                ${evalTooling}/lib/tests/eval-rpc.test.js \
                ${evalTooling}/lib/tests/eval-trace-metrics.test.js \
                ${evalTooling}/lib/tests/eval-workspace.test.js
          '';
        };
        migrateTkApp = pkgs.writeShellApplication {
          name = "pi-migrate-tk";
          runtimeInputs = [
            ticketPackage
            pkgs.gh
          ];
          text = ''
            set -euo pipefail
            if [ ! -d .tickets ]; then
              echo "pi-migrate-tk: no .tickets directory in the current project; run this from a tk-backed repository." >&2
              exit 1
            fi
            if ! gh auth status >/dev/null 2>&1; then
              echo "pi-migrate-tk: GitHub CLI authentication is required; run gh auth login first." >&2
              exit 1
            fi
            exec ${piHarnessPackage}/bin/pi "$@"
          '';
        };
        verifyApp = pkgs.writeShellApplication {
          name = "verify";
          runtimeInputs = [
            pkgs.check-jsonschema
            pkgs.coreutils
            pkgs.git
            pkgs.jq
            pkgs.nodejs
            pkgs.typescript
          ] ++ lib.optionals pkgs.stdenv.isLinux [
            pkgs.bubblewrap
          ];
          text = ''
            set -euo pipefail
            test -f config/agent/settings.json
            jq empty config/agent/settings.json
            test -f docs/architecture/decisions/0001-synthetic-evaluation-contracts.md
            test -f docs/architecture/decisions/0002-managed-session-contracts.md
            test -f config/agent/extensions/managed-sessions/contracts.ts
            test -f config/agent/extensions/managed-sessions/adapter/ordinary.ts
            test -f config/agent/extensions/managed-sessions/adapter/coordinator.ts
            test -f config/agent/extensions/managed-sessions/adapter/client.ts
            test -f config/agent/extensions/managed-sessions/adapter/state.ts
            if grep -R -E 'PI_MATRIX|MATRIX_ACCESS_TOKEN|https?://|node:child_process|tmux|send-keys' \
              config/agent/extensions/managed-sessions/adapter; then
              echo "managed-session adapter must have no Matrix, process, or tmux authority" >&2
              exit 1
            fi
            test -f config/agent/extensions/managed-sessions/relay/main.ts
            test -f config/agent/extensions/managed-sessions/relay/ipc-server.ts
            test -f config/agent/extensions/managed-sessions/relay/registry.ts
            test -f config/agent/extensions/managed-sessions/relay/matrix-client.ts
            test -f eval/contracts/path-policy.ts
            test -f eval/rpc/engine.ts
            test -f eval/rpc/README.md
            test -f eval/workspace/materialize.ts
            test -f eval/workspace/README.md
            test -f eval/trace/capture.ts
            test -f eval/trace/README.md
            test -f eval/grading/grade.ts
            test -f eval/grading/README.md
            if grep -R -F 'node:readline' eval/rpc; then
              echo "eval RPC engine must use strict LF framing, not Node readline" >&2
              exit 1
            fi
            test -f tests/fixtures/eval-rpc/fake-rpc.mjs
            schema_root=eval/contracts/schemas/v1
            fixture_root=../../fixtures
            (
              cd "$schema_root"
              for schema in *.schema.json; do
                check-jsonschema --check-metaschema "$schema"
              done
              check-jsonschema --schemafile pack.schema.json "$fixture_root/valid/pack.json"
              check-jsonschema --schemafile scenario.schema.json "$fixture_root/valid/scenarios/sensor-smoke.json"
              check-jsonschema --schemafile scenario.schema.json "$fixture_root/valid/scenarios/ui-policy-v1.json"
              check-jsonschema --schemafile synthetic-provenance.schema.json "$fixture_root/valid/provenance.json"
              check-jsonschema --schemafile metrics.schema.json "$fixture_root/valid/metrics.json"
              check-jsonschema --schemafile run-result.schema.json "$fixture_root/valid/run-result.json"
              check-jsonschema --schemafile comparison.schema.json "$fixture_root/valid/baselines/reviewed-summary.json"
              for fixture in pack-traversal pack-absolute pack-external-uri pack-nul-path pack-trailing-slash; do
                if check-jsonschema --schemafile pack.schema.json "$fixture_root/invalid/$fixture.json"; then
                  echo "invalid eval pack fixture passed validation: $fixture" >&2
                  exit 1
                fi
              done
              for fixture in pack-duplicate-suite-id pack-unknown-scenario; do
                check-jsonschema --schemafile pack.schema.json "$fixture_root/invalid/$fixture.json"
              done
              for fixture in scenario-generator-missing-outputs scenario-missing-provenance scenario-not-synthetic; do
                if check-jsonschema --schemafile scenario.schema.json "$fixture_root/invalid/$fixture.json"; then
                  echo "invalid synthetic scenario fixture passed validation: $fixture" >&2
                  exit 1
                fi
              done
              for fixture in provenance-extra-property provenance-missing-synthetic provenance-not-synthetic; do
                if check-jsonschema --schemafile synthetic-provenance.schema.json "$fixture_root/invalid/$fixture.json"; then
                  echo "invalid synthetic provenance fixture passed validation: $fixture" >&2
                  exit 1
                fi
              done
              for fixture in \
                assertion-file-missing-expected \
                assertion-final-text-missing-condition \
                assertion-git-missing-condition \
                assertion-oracle-missing-target \
                assertion-ui-missing-condition; do
                if check-jsonschema --schemafile assertion.schema.json "$fixture_root/invalid/$fixture.json"; then
                  echo "incomplete assertion fixture passed validation: $fixture" >&2
                  exit 1
                fi
              done
              (
                cd ../v2
                for schema in *.schema.json; do
                  check-jsonschema --check-metaschema "$schema"
                done
                check-jsonschema --schemafile scenario.schema.json "$fixture_root/valid/scenarios/sensor-smoke-v2.json"
                check-jsonschema --schemafile scenario.schema.json "$fixture_root/invalid/scenario-duplicate-ui-dialog.json"
                if check-jsonschema --schemafile scenario.schema.json "$fixture_root/invalid/scenario-unsupported-version.json"; then
                  echo "unsupported scenario version passed v2 validation" >&2
                  exit 1
                fi
                if check-jsonschema --schemafile ui-policy.schema.json "$fixture_root/invalid/ui-policy-response-mismatch.json"; then
                  echo "method-incompatible UI response fixture passed v2 validation" >&2
                  exit 1
                fi
              )
              (
                cd ../v3
                for schema in *.schema.json; do
                  check-jsonschema --check-metaschema "$schema"
                done
                check-jsonschema --schemafile scenario.schema.json "$fixture_root/valid/scenarios/sensor-smoke-v3.json"
              )
            )
            test -d config/agent/extensions
            test -f config/agent/extensions/web-search/index.ts
            test -f config/agent/extensions/github-issues/index.ts
            test -f config/agent/extensions/aloop/index.ts
            test -f config/agent/extensions/diagram-tools/index.ts
            test -f config/agent/extensions/worker-runner/index.ts
            test -f config/agent/extensions/review-agents/index.ts
            test -f config/agent/extensions/remote-session/index.ts
            test -f config/agent/extensions/remote-session/matrix-client.ts
            test -f config/agent/extensions/remote-session/state-store.ts
            test -f config/agent/extensions/nix-runtime/index.ts
            test -f config/agent/extensions/codex-fast/index.ts
            test -f config/agent/extensions/tmux-cursor-focus/index.ts
            test -f config/agent/extensions/sesh/index.ts
            test -d config/agent/skills
            test -f config/agent/skills/playwright-browser/SKILL.md
            test -d config/agent/prompts
            test -d config/agent/themes
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/web-search/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/github-issues/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/aloop/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/diagram-tools/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/worker-runner/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/review-agents/index.ts
            test ! -e ${piHarnessResources}/share/pi-harness/agent/extensions/remote-session
            if grep -F 'remoteSession =' nix/module.nix >/dev/null; then
              echo "legacy remoteSession NixOS option still exists" >&2
              exit 1
            fi
            test -f ${piHarnessResources.managedSessionExtensions.ordinary}
            test -f ${piHarnessResources.managedSessionExtensions.coordinator}
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/managed-sessions/adapter/client.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/managed-sessions/adapter/state.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/nix-runtime/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/codex-fast/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/tmux-cursor-focus/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/sesh/index.ts
            test -d ${piHarnessResources}/share/pi-harness/agent/extensions/node_modules/typebox
            test -d ${piHarnessResources}/share/pi-harness/agent/skills
            test -f ${piHarnessResources}/share/pi-harness/agent/skills/migrate-tk-to-github/SKILL.md
            test -f ${piHarnessResources}/share/pi-harness/agent/skills/playwright-browser/SKILL.md
            test -f ${piHarnessResources}/share/pi-harness/agent/skills/migrate-tk-to-github/references/inventory-schema.md
            grep -F 'disable-model-invocation: true' \
              ${piHarnessResources}/share/pi-harness/agent/skills/migrate-tk-to-github/SKILL.md >/dev/null
            mattpocock_skills_root=${mattPocockSkillsResources}/share/pi-harness/mattpocock-skills
            for skill_name in \
              ask-matt codebase-design code-review diagnosing-bugs domain-modeling \
              grill-with-docs implement prototype research resolving-merge-conflicts \
              setup-matt-pocock-skills tdd to-spec to-tickets triage wayfinder grilling handoff; do
              test -f "$mattpocock_skills_root/$skill_name/SKILL.md"
              grep -F "name: $skill_name" "$mattpocock_skills_root/$skill_name/SKILL.md" >/dev/null
            done
            grep -F 'review_agents' "$mattpocock_skills_root/code-review/SKILL.md" >/dev/null
            if grep -F "two \`Agent\` tool calls" "$mattpocock_skills_root/code-review/SKILL.md" >/dev/null; then
              echo "code-review skill still references the unavailable Agent tool" >&2
              exit 1
            fi
            for user_invoked_skill in \
              ask-matt grill-with-docs implement setup-matt-pocock-skills \
              to-spec to-tickets triage wayfinder handoff; do
              grep -F "disable-model-invocation: true" \
                "$mattpocock_skills_root/$user_invoked_skill/SKILL.md" >/dev/null
            done
            test -f "$mattpocock_skills_root/tdd/tests.md"
            test -f "$mattpocock_skills_root/setup-matt-pocock-skills/issue-tracker-github.md"
            jq -e '.enableSkillCommands == true' ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            test -d ${piHarnessResources}/share/pi-harness/agent/prompts
            test -d ${piHarnessResources}/share/pi-harness/agent/themes
            test -L ${piHarnessPackage}/share/pi-harness/agent
            test -f ${agentgraphPiResources}/share/agentgraph-pi/extensions/agentgraph/index.ts
            test -f ${agentgraphPiResources}/share/agentgraph-pi/skills/agentgraph-operator/SKILL.md
            test -f ${agentgraphPiResources}/share/agentgraph-pi/prompts/graph-change.md
            test -e ${piHarnessPackage}/bin/ag
            test -e ${piHarnessPackage}/bin/agentgraph-postgres
            test -x ${piHarnessPackage}/bin/pi-playwright
            test ! -e ${piHarnessPackage}/bin/pi-matrix-whoami
            test ! -e ${piHarnessPackage}/bin/pi-managed-session-relay
            test -x ${managedSessionRelay}/bin/pi-managed-session-relay
            test -x ${piHarnessPackage}/bin/pi-r-local
            launcher_identity=${piHarnessPackage}/share/pi-harness/eval/launcher-identity.json
            check-jsonschema --check-metaschema eval/launcher/schemas/v1/launcher-identity.schema.json
            check-jsonschema --check-metaschema eval/launcher/schemas/v1/runtime-provenance.schema.json
            check-jsonschema --schemafile eval/launcher/schemas/v1/launcher-identity.schema.json "$launcher_identity"
            jq -e '
              .schemaVersion == "1.0.0"
              and .launcher.id == "pi-r-local"
              and .launcher.path == "${piHarnessPackage}/bin/pi-r-local"
              and .launcher.defaultArgs == ["--mode", "rpc", "--no-session"]
              and .launcher.requiredResourceBindings == [
                "${piRPackage.resourcePaths.root}",
                "${piRPackage.resourcePaths.extension}",
                "${piRPackage.resourcePaths.skill}"
              ]
              and .piR.resourceRoot == "${piRPackage.resourcePaths.root}"
              and .piR.extensionPath == "${piRPackage.resourcePaths.extension}"
              and .piR.skillPath == "${piRPackage.resourcePaths.skill}"
            ' "$launcher_identity" >/dev/null
            launcher_attestation=$(mktemp)
            PI_EVAL_ATTESTATION_PATH="$launcher_attestation" \
              ${piHarnessPackage}/bin/pi-r-local --version >/dev/null
            jq -e '
              .launcherId == "pi-r-local"
              and .resourceRoot == "${piRPackage.resourcePaths.root}"
              and .extensionPath == "${piRPackage.resourcePaths.extension}"
              and .skillPath == "${piRPackage.resourcePaths.skill}"
            ' "$launcher_attestation" >/dev/null
            test -x ${piRPackage.resourcePaths.cli}
            test -x ${piRPackage.resourcePaths.rscript}
            test -x ${piRPackage.resourcePaths.parser}
            test -x ${piRPackage.resourcePaths.sandbox}
            test -f ${piRPackage.resourcePaths.extension}
            test -f ${piRPackage.resourcePaths.scoutExtension}
            test -f ${piRPackage.resourcePaths.skill}
            test -f ${piRPackage.resourcePaths.reference}
            test -f ${piRPackage.resourcePaths.formatter}
            test -x ${piRPackage.resourcePaths.parserGrammar}
            test -f ${piRPackage.resourcePaths.parserQuery}
            test -f ${piRPackage.resourcePaths.nixpkgsPin}
            test -f ${piRPackage.resourcePaths.dataInspector}
            test -f ${piRPackage.resourcePaths.valueSummary}
            test -n ${pkgs.lib.escapeShellArg piRPackage.resourcePaths.sandboxRuntimePath}
            grep -F 'PI_R_SANDBOX_PATH' ${piHarnessPackage}/bin/pi >/dev/null
            grep -F 'PI_R_SANDBOX_PATH' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F 'PI_R_DATA_INSPECTOR_SCRIPT' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F 'PI_R_VALUE_SUMMARY_SCRIPT' ${piHarnessPackage}/bin/pi >/dev/null
            grep -F 'PI_R_VALUE_SUMMARY_SCRIPT' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F 'PI_R_NIXPKGS_PIN_PATH' ${piHarnessPackage}/bin/pi >/dev/null
            grep -F 'PI_R_NIXPKGS_PIN_PATH' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F 'expandPromptTemplates: options?.expandPromptTemplates ?? false' \
              ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js >/dev/null
            grep -F 'expandPromptTemplates?: boolean' \
              ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts >/dev/null
            grep -F 'options?.onPromptExpanded?.(expandedText)' \
              ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js >/dev/null
            command_probe_dir=$(mktemp -d)
            cat > "$command_probe_dir/extension.ts" <<'EOF'
            import { writeFileSync } from "node:fs";
            import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
            export default function (pi: ExtensionAPI): void {
              pi.registerCommand("matrix-command-probe", {
                handler: async (args) => writeFileSync(process.env.PROBE_RESULT!, args),
              });
              pi.on("session_start", () => {
                pi.sendUserMessage("/matrix-command-probe expanded", { expandPromptTemplates: true });
              });
            }
            EOF
            PROBE_RESULT="$command_probe_dir/result" \
              printf '%s\n' '{"type":"get_state"}' | \
              PROBE_RESULT="$command_probe_dir/result" \
              timeout 10 ${piPackage}/bin/pi --mode rpc --no-session \
                --extension "$command_probe_dir/extension.ts" >/dev/null
            test "$(cat "$command_probe_dir/result")" = expanded
            rm -rf "$command_probe_dir"
            test -x ${managedSessionPiWrapper}/bin/pi
            test -x ${managedSessionStatusWrapper}/bin/pi-managed-session-status
            grep -F 'cursorConfigured' ${managedSessionStatusWrapper}/bin/pi-managed-session-status >/dev/null
            jq -e '(.assertions | all) and .relayUserLingers and .servicePathCount == 4 and (.hasGeneralEnvironmentFile | not) and (.hasPrivateTmp | not) and .serviceEnvironment.PI_MANAGED_SESSIONS_HOST_ID == "test-host"' \
              ${managedSessionModuleReport} >/dev/null
            managed_relay_launch=$(jq -r .execStart ${managedSessionModuleReport})
            grep -F 'credential file may contain only one PI_MATRIX_ACCESS_TOKEN assignment' "$managed_relay_launch" >/dev/null
            grep -F 'export PI_MATRIX_ACCESS_TOKEN=' "$managed_relay_launch" >/dev/null
            if grep -F 'echo' "$managed_relay_launch" | grep -F 'matrix_token' >/dev/null; then
              echo "managed relay launcher prints its Matrix token" >&2
              exit 1
            fi
            grep -F '${piHarnessResources.managedSessionExtensions.ordinary}' ${managedSessionPiWrapper}/bin/pi >/dev/null
            grep -F 'PI_MANAGED_SESSIONS_SOCKET' ${managedSessionPiWrapper}/bin/pi >/dev/null
            if grep -F '/run/secrets/pi-managed-session.env' ${managedSessionPiWrapper}/bin/pi >/dev/null; then
              echo "managed-session Matrix credential file leaked into the interactive Pi wrapper" >&2
              exit 1
            fi
            test -x ${playwrightAgentCli}/bin/playwright-cli-fallback
            ${playwrightAgentCli}/bin/playwright-cli-fallback --version | grep -Fx '0.1.17' >/dev/null
            test ! -e ${piHarnessPackage}/bin/tk
            test -x ${migrateTkApp}/bin/pi-migrate-tk
            grep -F 'no .tickets directory' ${migrateTkApp}/bin/pi-migrate-tk >/dev/null
            grep -F 'gh auth status' ${migrateTkApp}/bin/pi-migrate-tk >/dev/null
            grep -F -- "--extension \"${piRPackage.resourcePaths.extension}\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/web-search/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/github-issues/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/aloop/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/diagram-tools/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/worker-runner/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/review-agents/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            if grep -F 'extensions/remote-session/' ${piHarnessPackage}/bin/pi >/dev/null; then
              echo "legacy direct Matrix bridge must not load in packaged Pi" >&2
              exit 1
            fi
            if grep -F 'managed-sessions/adapter/' ${piHarnessPackage}/bin/pi >/dev/null; then
              echo "disabled default Pi wrapper must not load managed-session adapters" >&2
              exit 1
            fi
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/codex-fast/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/tmux-cursor-focus/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/sesh/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--skill \"${piHarnessResources}/share/pi-harness/agent/skills\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--skill \"${mattPocockSkillsResources}/share/pi-harness/mattpocock-skills\"" ${piHarnessPackage}/bin/pi >/dev/null
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
            grep -F '${ticketPackage}/bin' ${migrateTkApp}/bin/pi-migrate-tk >/dev/null
            test -f ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/index.ts
            grep -F '".nix": "nix"' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/shared/language-map.ts >/dev/null
            grep -F '"dockerfile": "dockerfile"' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/shared/language-map.ts >/dev/null
            grep -F '".hs": "haskell"' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/shared/language-map.ts >/dev/null
            grep -F 'nix: { command: "nil", args: [] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'haskell: { command: "haskell-language-server-wrapper", args: ["--lsp"] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'dockerfile: { command: "docker-langserver", args: ["--stdio"] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'bash: { command: "bash-language-server", args: ["start"] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'const runningStatuses = statuses.filter((s) => s.running);' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/tools/symbols.ts >/dev/null
            jq -e '.extensions | index("./extensions/github-issues/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/aloop/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/diagram-tools/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/worker-runner/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/review-agents/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/remote-session/index.ts") | not' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '[.extensions[] | select(contains("managed-sessions/adapter/"))] | length == 0' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/nix-runtime/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/codex-fast/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/tmux-cursor-focus/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/sesh/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null

            grep -F -- '--no-extensions' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F -- '--no-skills' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F -- '--no-context-files' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F -- '--extension "${piRPackage.resourcePaths.extension}"' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F -- '--skill "${piRPackage.resourcePaths.skill}"' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            if grep -F "${piHarnessResources}/share/pi-harness/agent/extensions/" ${piHarnessPackage}/bin/pi-r-local >/dev/null; then
              echo "pi-local must not load general harness extensions" >&2
              exit 1
            fi
            PI_HARNESS_NORMAL_PI=${piHarnessPackage}/bin/pi \
              PI_HARNESS_LOCAL_PI=${piHarnessPackage}/bin/pi-r-local \
              node --test ${./tests/pi-r-integration.test.mjs}

            ${typeSetup}
            tsc --noEmit --project tsconfig.json
            test_build_dir=$(mktemp -d)
            tsc --project tsconfig.test.json --outDir "$test_build_dir"
            ${evalSelfTestApp}/bin/pi-eval-self-test
            PI_HARNESS_JQ=${lib.getExe pkgs.jq} \
              PI_MANAGED_ADAPTER_TEST_PI=${piPackage}/bin/pi \
              PI_MANAGED_ADAPTER_ORDINARY_EXTENSION=${piHarnessResources.managedSessionExtensions.ordinary} \
              PI_MANAGED_ADAPTER_COORDINATOR_EXTENSION=${piHarnessResources.managedSessionExtensions.coordinator} \
              PI_MANAGED_SESSIONS_TEST_PEER_UID_HELPER=${managedSessionRelay}/libexec/pi-managed-session-peer-uid \
              PI_MANAGED_SESSIONS_TEST_RELAY_LOCK_HELPER=${managedSessionRelay}/libexec/pi-managed-session-relay-lock \
              PI_MANAGED_SESSIONS_TEST_TMUX=${pkgs.tmux}/bin/tmux \
              PI_MANAGED_TEST_LAUNCHER=${managedSessionLauncher}/bin/tmux_project \
              PI_MANAGED_TEST_COORDINATOR_PI=${managedSessionCoordinatorPi}/bin/pi \
              PI_MANAGED_TEST_MANAGED_PI=${managedSessionCoordinatorPi}/bin/pi \
              PI_MANAGED_TEST_DIRENV=${pkgs.direnv}/bin/direnv \
              node --test \
                "$test_build_dir/tests/github-issues.test.js" \
                "$test_build_dir/tests/aloop-worker.test.js" \
                "$test_build_dir/tests/aloop-supervisor.test.js" \
                "$test_build_dir/tests/managed-session-contracts.test.js" \
                "$test_build_dir/tests/managed-session-adapter.test.js" \
                "$test_build_dir/tests/managed-session-adapter-real-pi.test.js" \
                "$test_build_dir/tests/managed-session-coordinator.test.js" \
                "$test_build_dir/tests/managed-session-controls.test.js" \
                "$test_build_dir/tests/managed-session-lifecycle.test.js" \
                "$test_build_dir/tests/managed-session-relay-adapter.test.js" \
                "$test_build_dir/tests/managed-session-relay-registry.test.js" \
                "$test_build_dir/tests/managed-session-relay-ipc.test.js" \
                "$test_build_dir/tests/managed-session-relay-matrix.test.js" \
                "$test_build_dir/tests/managed-session-transcript-projector.test.js" \
                "$test_build_dir/tests/managed-session-transcript-renderer.test.js" \
                "$test_build_dir/tests/remote-session.test.js" \
                "$test_build_dir/tests/remote-session-state.test.js" \
                "$test_build_dir/tests/playwright-resolver.test.js" \
                "$test_build_dir/tests/review-agents.test.js" \
                "$test_build_dir/tests/worker-runner.test.js"
          '';
        };
        verifyLspLiveApp = pkgs.writeShellApplication {
          name = "verify-lsp-live";
          runtimeInputs = [
            pkgs.coreutils
            pkgs.nodejs
            pkgs.typescript
          ]
          ++ lspPackages;
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
        packages.managed-session-relay = managedSessionRelay;
        packages.mattpocock-skills-resources = mattPocockSkillsResources;
        packages.pi-lsp-extension = piLspExtension;
        packages.playwright-agent-cli = playwrightAgentCli;
        packages.migrate-tk = migrateTkApp;
        packages.pi = piPackage;
        packages.default = piHarnessPackage;

        checks.managed-session-test-launcher = managedSessionLauncher;
        checks.managed-session-test-coordinator-pi = managedSessionCoordinatorPi;

        apps.migrate-tk = flake-utils.lib.mkApp { drv = migrateTkApp; };
        apps.eval = flake-utils.lib.mkApp { drv = evalApp; };
        apps.eval-self-test = flake-utils.lib.mkApp { drv = evalSelfTestApp; };
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
            playwrightAgentCli
            pkgs.jq
            pkgs.tmux
            pkgs.d2
            pkgs.graphviz
            pkgs.xdg-utils
          ]
          ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.bubblewrap ]
          ++ lspPackages;

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
