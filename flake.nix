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
        managedSessionLauncherBase = pkgs.writeShellApplication {
          name = "tmux_project";
          runtimeInputs = [ pkgs.coreutils pkgs.direnv pkgs.findutils pkgs.gawk pkgs.git pkgs.jq pkgs.tmux ];
          text = ''
            set -euo pipefail
            [[ "''${1-}" == managed ]]
            operation="''${2-}"
            request=$(cat)
            : "''${PI_MANAGED_TEST_TMUX_SOCKET:?}"
            format='#{window_id}|#{pane_id}'
            derive_project_key() {
              local domain="$1" first="$2" second="$3"
              { printf 'pi-managed-sessions:%s:v1\0' "$domain"
                for part in "$first" "$second"; do printf '%s:' "$(printf '%s' "$part" | wc -c)"; printf '%s' "$part"; done
              } | sha256sum | cut -c1-32
            }
            resolve_project_identity() {
              checkout_display="$workspace"
              local marker="$workspace_path/.git" common_raw common main_raw main output
              if [[ -e "$marker" || -L "$marker" ]]; then
                [[ ! -L "$marker" && ( -d "$marker" || -f "$marker" ) && $(stat -c %u "$marker") == $(id -u) ]]
                [[ $(git -C "$workspace_path" rev-parse --is-inside-work-tree 2>/dev/null) == true ]]
                [[ $(realpath -e "$(git -C "$workspace_path" rev-parse --show-toplevel 2>/dev/null)") == "$workspace_path" ]]
                common_raw=$(git -C "$workspace_path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
                [[ -n "$common_raw" && ''${#common_raw} -le 4096 && "$common_raw" != *$'\n'* ]]
                common=$(realpath -e "$common_raw")
                [[ -d "$common" && ! -L "$common" && $(stat -c %u "$common") == $(id -u) ]]
                output=$(git --git-dir="$common" worktree list --porcelain 2>/dev/null)
                [[ -n "$output" && ''${#output} -le 65536 ]]
                main_raw=$(awk '/^worktree / { print substr($0, 10); exit }' <<<"$output")
                [[ -n "$main_raw" && "$main_raw" != *$'\n'* ]]
                main=$(realpath -e "$main_raw")
                [[ -d "$main" && ! -L "$main" && $(stat -c %u "$main") == $(id -u) && $(dirname "$main") == "$configured_root" ]]
                [[ $(realpath -e "$main/.git") == "$common" && -d "$main/.git" && ! -L "$main/.git" && $(stat -c %u "$main/.git") == $(id -u) ]]
                project_key="project_$(derive_project_key project-git "$root_key" "$common")"
                project_display=$(basename "$main")
              else
                if git -C "$workspace_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then return 1; fi
                project_key="project_$(derive_project_key project-workspace "$root_key" "$workspace")"
                project_display="$workspace"
              fi
              [[ "$project_key" =~ ^project_[a-f0-9]{32}$ ]]
              jq -en --arg project "$project_display" --arg checkout "$checkout_display" '
                [$project,$checkout] | all(type == "string" and length >= 1 and length <= 128 and (test("[\u0000-\u001f\u007f/]") | not))' >/dev/null
            }
            case "$operation" in
              workspace-list)
                : "''${PI_MANAGED_TEST_WORKSPACE_ROOT:?}"
                find "$PI_MANAGED_TEST_WORKSPACE_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | \
                  jq -Rsc 'split("\n") | map(select(length > 0) | {rootKey:"projects",workspace:.}) | {workspaces:.}'
                ;;
              project-create)
                : "''${PI_MANAGED_TEST_WORKSPACE_ROOT:?}"
                root_key=$(jq -er 'if (keys == ["creationKey","resumeExisting","rootKey","workspace"]) and (.rootKey == "projects") and (.creationKey | test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")) and (.workspace | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")) and (.resumeExisting | type == "boolean") then .rootKey else error("invalid request") end' <<<"$request")
                creation_key=$(jq -er '.creationKey' <<<"$request")
                workspace=$(jq -er '.workspace' <<<"$request")
                resume_existing=$(jq -r '.resumeExisting' <<<"$request")
                configured_root=$(realpath "$PI_MANAGED_TEST_WORKSPACE_ROOT")
                [[ -d "$configured_root" && ! -L "$PI_MANAGED_TEST_WORKSPACE_ROOT" ]]
                workspace_path="$configured_root/$workspace"
                staging="$configured_root/.pi-managed-create-$(printf '%s' "$creation_key" | sha256sum | cut -c1-32)"
                marker="$staging/.pi-managed-project-creation"
                if [[ -e "$workspace_path" || -L "$workspace_path" ]]; then
                  [[ "$resume_existing" == true && -d "$workspace_path" && ! -L "$workspace_path" && $(stat -c %u "$workspace_path") == $(id -u) ]]
                  [[ -d "$workspace_path/.git" && ! -L "$workspace_path/.git" && $(stat -c %u "$workspace_path/.git") == $(id -u) ]]
                  [[ $(git -C "$workspace_path" config --local --get pi-managed.creationKey 2>/dev/null || true) == "$creation_key" ]]
                else
                  if [[ ! -e "$staging" && ! -L "$staging" ]]; then
                    mkdir --mode=700 "$staging"
                    printf '%s\n' "$creation_key" > "$marker"; chmod 600 "$marker"
                  else
                    [[ "$resume_existing" == true && -d "$staging" && ! -L "$staging" && $(stat -c %u "$staging") == $(id -u) ]]
                    if [[ -f "$marker" && ! -L "$marker" && $(stat -c %u "$marker") == $(id -u) && $(cat "$marker") == "$creation_key" ]]; then :
                    elif [[ -d "$staging/.git" && ! -L "$staging/.git" && $(stat -c %u "$staging/.git") == $(id -u) && $(git -C "$staging" config --local --get pi-managed.creationKey 2>/dev/null || true) == "$creation_key" ]]; then :
                    elif [[ -z $(find "$staging" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
                      printf '%s\n' "$creation_key" > "$marker"; chmod 600 "$marker"
                    else exit 1; fi
                  fi
                  [[ ! -e "$staging/.git" || ( -d "$staging/.git" && ! -L "$staging/.git" && $(stat -c %u "$staging/.git") == $(id -u) ) ]]
                  git -C "$staging" init -b main >/dev/null
                  [[ -d "$staging/.git" && ! -L "$staging/.git" && $(stat -c %u "$staging/.git") == $(id -u) ]]
                  [[ $(realpath "$(git -C "$staging" rev-parse --show-toplevel)") == "$staging" ]]
                  [[ $(git -C "$staging" symbolic-ref --short HEAD) == main ]]
                  git -C "$staging" config --local pi-managed.creationKey "$creation_key"
                  rm -f "$marker"
                  [[ ! -e "$workspace_path" && ! -L "$workspace_path" ]]
                  mv -T "$staging" "$workspace_path"
                fi
                [[ $(realpath "$(git -C "$workspace_path" rev-parse --show-toplevel)") == "$workspace_path" ]]
                [[ $(git -C "$workspace_path" symbolic-ref --short HEAD) == main ]]
                resolve_project_identity
                jq -cn --arg rootKey "$root_key" --arg workspace "$workspace" --arg workspacePath "$workspace_path" \
                  '{rootKey:$rootKey,workspace:$workspace,relativeCwd:"",workspacePath:$workspacePath,cwd:$workspacePath,projectKey:null,projectDisplayName:null,checkoutDisplayName:null}'
                ;;
              workspace-resolve|root-ensure)
                : "''${PI_MANAGED_TEST_WORKSPACE_ROOT:?}"
                root_key=$(jq -er '.rootKey' <<<"$request")
                workspace=$(jq -er '.workspace' <<<"$request")
                relative_cwd=$(jq -er '.relativeCwd' <<<"$request")
                [[ "$root_key" == projects && "$workspace" != */* && "$workspace" != .* && "$relative_cwd" != /* && "$relative_cwd" != *..* ]]
                configured_root=$(realpath "$PI_MANAGED_TEST_WORKSPACE_ROOT")
                [[ -d "$configured_root" && ! -L "$PI_MANAGED_TEST_WORKSPACE_ROOT" ]]
                workspace_path=$(realpath "$configured_root/$workspace")
                [[ -d "$workspace_path" && ! -L "$configured_root/$workspace" && $(dirname "$workspace_path") == "$configured_root" && $(stat -c %u "$workspace_path") == $(id -u) ]]
                cwd=$(realpath "$workspace_path/''${relative_cwd:-.}")
                [[ "$cwd" == "$workspace_path" || "$cwd" == "$workspace_path/"* ]]
                if [[ "$operation" == root-ensure ]]; then
                  if ! tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" has-session -t "=$workspace" 2>/dev/null; then
                    tmux -L "$PI_MANAGED_TEST_TMUX_SOCKET" new-session -d -s "$workspace" -n shell -c "$workspace_path"
                  fi
                  jq -cn --arg sessionName "$workspace" --arg workspacePath "$workspace_path" '{sessionName:$sessionName,workspacePath:$workspacePath}'
                else
                  resolve_project_identity
                  jq -cn --arg rootKey "$root_key" --arg workspace "$workspace" --arg relativeCwd "$relative_cwd" \
                    --arg workspacePath "$workspace_path" --arg cwd "$cwd" \
                    '{rootKey:$rootKey,workspace:$workspace,relativeCwd:$relativeCwd,workspacePath:$workspacePath,cwd:$cwd,projectKey:null,projectDisplayName:null,checkoutDisplayName:null}'
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
        managedSessionLauncher = pkgs.callPackage ./nix/managed-session-launcher-wrapper.nix {
          launcherPackage = managedSessionLauncherBase;
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
                lsp.enable = true;
                managedSessions = {
                  enable = true;
                  user = "operator";
                  environmentFile = "/run/secrets/pi-managed-session.env";
                  homeserver = "https://matrix.example.com";
                  botUserId = "@pi-test:example.com";
                  operatorUserId = "@operator:example.com";
                  ignoredSenderUserIds = [ "@signalbot:example.com" "@facebookbot:example.com" ];
                  hostId = "test-host";
                  workspaceRoots.projects = "/home/operator/projects";
                  launcherPackage = managedSessionLauncherBase;
                };
              };
            }
          ];
        };
        lspDisabledModuleTest = lib.evalModules {
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
            { services.pi-harness = { enable = true; package = piHarnessPackage; lsp.enable = false; }; }
          ];
        };
        lspDisabledPiWrapper = builtins.elemAt lspDisabledModuleTest.config.environment.systemPackages 0;
        managedLspDisabledModuleTest = managedSessionModuleTest.extendModules {
          modules = [ { services.pi-harness.lsp.enable = lib.mkForce false; } ];
        };
        managedLspDisabledService = managedLspDisabledModuleTest.config.systemd.user.services.pi-managed-session-relay;
        managedLspDisabledCoordinatorPi = builtins.elemAt managedLspDisabledService.path 1;
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
          cp ${./tests}/eval-*.test.ts source/tests/
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
          runtimeInputs = [ pkgs.bash pkgs.coreutils pkgs.git pkgs.nodejs ] ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.bubblewrap ];
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
              PI_TEST_SHELL=${lib.getExe pkgs.bash} \
              ${lib.optionalString pkgs.stdenv.isLinux "PI_EVAL_BWRAP=${lib.getExe pkgs.bubblewrap} \\"}
              ${lib.getExe pkgs.nodejs} --test --test-concurrency=1 \
                ${evalTooling}/lib/tests/eval-*.test.js
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
        verification = import ./nix/verification.nix {
          inherit
            pkgs
            lib
            piPackage
            piHarnessPackage
            piHarnessResources
            piRPackage
            agentgraphPiResources
            managedSessionRelay
            managedSessionLauncher
            managedSessionPiWrapper
            managedSessionStatusWrapper
            managedSessionCoordinatorPi
            managedLspDisabledCoordinatorPi
            lspDisabledPiWrapper
            managedSessionModuleReport
            mattPocockSkillsResources
            migrateTkApp
            playwrightAgentCli
            piLspExtension
            evalSelfTestApp
            typeSetup
            lspPackages
            ;
          source = ./.;
        };
        verifyApp = verification.verifyApp;
        verifyLspLiveApp = verification.verifyLspLiveApp;
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

        checks = verification.checks // {
          managed-session-test-launcher = managedSessionLauncher;
          managed-session-test-coordinator-pi = managedSessionCoordinatorPi;
        };

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
