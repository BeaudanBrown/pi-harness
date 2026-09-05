{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.services.pi-harness;

  defaultLspPackages = with pkgs; [
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

  defaultDiagramPackages = with pkgs; [
    graphviz
    d2
    xdg-utils
  ];

  fallbackRuntimePackages = [
    cfg.package
    pkgs.bash
    pkgs.which
  ]
  ++ lib.optionals cfg.lsp.enable cfg.lsp.packages
  ++ lib.optionals cfg.diagrams.enable cfg.diagrams.packages
  ++ lib.optionals (cfg.playwright.enable && cfg.playwright.package != null) [
    cfg.playwright.package
  ];
  runtimeFeaturesEnabled = cfg.lsp.enable || cfg.diagrams.enable || cfg.playwright.enable;
  sessionDirectoryEnabled = cfg.sessionDirectory != null;
  managedSessionsEnabled = cfg.managedSessions.enable;
  nonNullString = value: if value == null then "" else value;
  managedRelayPackage = if cfg.managedSessions.relayPackage == null then cfg.package else cfg.managedSessions.relayPackage;
  configuredManagedLauncherPackage = if cfg.managedSessions.launcherPackage == null then pkgs.runCommand "missing-managed-session-launcher" { } "mkdir -p $out" else cfg.managedSessions.launcherPackage;
  managedLauncherPackage = pkgs.callPackage ./managed-session-launcher-wrapper.nix {
    launcherPackage = configuredManagedLauncherPackage;
    launcherExecutable = cfg.managedSessions.launcherExecutable;
  };
  managedExtensions = cfg.package.managedSessionExtensions or {
    ordinary = "/missing-managed-ordinary";
    coordinator = "/missing-managed-coordinator";
    modelPolicy = "/missing-managed-model-policy";
  };
  profileDocument = cfg.package.agentProfiles or { profiles = { }; variants = { }; };
  engineeringProfile = profileDocument.profiles."engineering-full" or { extensions = [ ]; skills = [ ]; prompts = [ ]; themes = [ ]; };
  localProfile = profileDocument.profiles."pi-local" or { tools = [ ]; };
  managedLocalModelTools = builtins.toJSON localProfile.tools;
  managedVariant = profileDocument.variants."managed-project" or { excludeExtensions = [ ]; excludeSkills = [ ]; excludePrompts = [ ]; };
  managedProfileExtensions = builtins.filter
    (name: !(builtins.elem name (managedVariant.excludeExtensions or [ ])) && name != "pi-r" && name != "agentgraph")
    engineeringProfile.extensions;
  managedProfileExtensionArgs = lib.concatMapStringsSep "\n" (name:
    if name == "lsp" then ""
    else ''--extension "${cfg.package.harnessResources}/share/pi-harness/agent/extensions/${name}/index.ts"''
  ) managedProfileExtensions;
  managedProfileSkillArgs = lib.concatMapStringsSep "\n" (name:
    if builtins.elem name (managedVariant.excludeSkills or [ ]) then ""
    else if name == "harness" then ''--skill "${cfg.package.harnessResources}/share/pi-harness/agent/skills"''
    else if name == "matt-pocock" then ''--skill "${cfg.package.mattpocockSkills}/share/pi-harness/mattpocock-skills"''
    else ""
  ) engineeringProfile.skills;
  managedProfilePromptArgs = lib.concatMapStringsSep "\n" (name:
    if builtins.elem name (managedVariant.excludePrompts or [ ]) then ""
    else if name == "harness" then ''--prompt-template "${cfg.package.harnessResources}/share/pi-harness/agent/prompts"'' else ""
  ) engineeringProfile.prompts;
  managedProfileThemeArgs = lib.concatMapStringsSep "\n" (name:
    if name == "harness" then ''--theme "${cfg.package.harnessResources}/share/pi-harness/agent/themes"'' else ""
  ) engineeringProfile.themes;
  coordinatorProfile = profileDocument.profiles."managed-coordinator" or { tools = [ ]; };
  coordinatorTools = lib.concatStringsSep "," coordinatorProfile.tools;
  managedRawPi = cfg.package.pi or cfg.package;
  runtimeEnvironmentFiles = lib.filter (path: path != null) [ cfg.agentgraph.environmentFile ];
  runtimeEnvironmentSetup = lib.optionalString (runtimeEnvironmentFiles != [ ]) ''
    set -a
    ${lib.concatMapStringsSep "\n" (path: ''
      # shellcheck disable=SC1090
      . ${lib.escapeShellArg path}
    '') runtimeEnvironmentFiles}
    set +a
  '';
  sessionDirectoryEnvironment = lib.optionalString sessionDirectoryEnabled ''
    export PI_CODING_AGENT_SESSION_DIR=${lib.escapeShellArg (nonNullString cfg.sessionDirectory)}
  '';
  managedSessionEnvironment = lib.optionalString managedSessionsEnabled ''
    if [[ -z "''${XDG_RUNTIME_DIR:-}" ]]; then
      echo "pi-harness: XDG_RUNTIME_DIR is required for managed sessions" >&2
      exit 1
    fi
    export PI_MANAGED_SESSIONS_SOCKET="$XDG_RUNTIME_DIR/pi-managed-sessions/relay.sock"
  '';
  lspExtensionArray =
    if cfg.lsp.enable then
      ''extension_args=(--extension "${cfg.lsp.extension}/share/pi-lsp-extension/src/index.ts")''
    else
      "extension_args=()";
  lspEnabledEnvironment = ''export PI_HARNESS_LSP_ENABLED=${if cfg.lsp.enable then "1" else "0"}'';
  lspFallbackEnvironment = lib.optionalString cfg.lsp.enable ''
    export PI_HARNESS_LSP_FALLBACK_PATH="${lib.makeBinPath cfg.lsp.packages}"
  '';
  lspEnvironmentCleanup = ''
    if [[ -n "''${PI_HARNESS_LSP_FALLBACK_PATH:-}" ]]; then
      IFS=: read -r -a pi_path_parts <<< "''${PATH:-}"
      IFS=: read -r -a pi_lsp_parts <<< "''${PI_HARNESS_LSP_FALLBACK_PATH}"
      pi_clean_path=()
      for pi_path_part in "''${pi_path_parts[@]}"; do
        pi_keep_path=1
        for pi_lsp_part in "''${pi_lsp_parts[@]}"; do
          if [[ "$pi_path_part" == "$pi_lsp_part" ]]; then pi_keep_path=0; break; fi
        done
        if [[ "$pi_keep_path" == 1 ]]; then pi_clean_path+=("$pi_path_part"); fi
      done
      PATH="$(IFS=:; printf '%s' "''${pi_clean_path[*]}")"
      export PATH
    fi
    unset PI_HARNESS_LSP_ENABLED PI_HARNESS_LSP_EXTENSION PI_HARNESS_LSP_FALLBACK_PATH
  '';
  lspDisabledCleanup = lib.optionalString (!cfg.lsp.enable) lspEnvironmentCleanup;
  managedOrdinaryExtension = lib.optionalString managedSessionsEnabled ''
    extension_args+=(--extension "${managedExtensions.ordinary}")
  '';

  piWithRuntime = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail
    ${runtimeEnvironmentSetup}
    ${sessionDirectoryEnvironment}
    ${managedSessionEnvironment}
    export PATH="$PATH":${lib.makeBinPath fallbackRuntimePackages}
    ${lspEnabledEnvironment}
    ${lspFallbackEnvironment}
    ${lspDisabledCleanup}
    ${lspExtensionArray}
    ${managedOrdinaryExtension}
    exec ${cfg.package}/bin/pi "''${extension_args[@]}" "$@"
  '';

  coordinatorPi = pkgs.writeShellScriptBin "pi-managed-coordinator" ''
    set -euo pipefail
    : "''${PI_MANAGED_COORDINATOR_CWD:?PI_MANAGED_COORDINATOR_CWD is required}"
    : "''${PI_MANAGED_COORDINATOR_SESSION_FILE:?PI_MANAGED_COORDINATOR_SESSION_FILE is required}"
    export PI_HARNESS_AGENT_PROFILE="managed-coordinator"
    ${lspEnvironmentCleanup}
    coordinator_model_args=()
    [[ -z "''${PI_MANAGED_SESSION_MODEL:-}" ]] || coordinator_model_args+=(--model "$PI_MANAGED_SESSION_MODEL")
    [[ -z "''${PI_MANAGED_SESSION_THINKING:-}" ]] || coordinator_model_args+=(--thinking "$PI_MANAGED_SESSION_THINKING")
    cd "$PI_MANAGED_COORDINATOR_CWD"
    exec ${managedRawPi}/bin/pi \
      --no-extensions \
      --no-skills \
      --no-prompt-templates \
      --no-themes \
      --no-context-files \
      --no-builtin-tools \
      --extension "${managedExtensions.coordinator}" \
      --extension "${cfg.package.agentProfileExtension}" \
      --tools "${coordinatorTools}" \
      --session "$PI_MANAGED_COORDINATOR_SESSION_FILE" \
      "''${coordinator_model_args[@]}" \
      "$@"
  '';

  managedPiDispatch = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail
    case "''${PI_MANAGED_SESSION_LAUNCH_ROLE:-}" in
      coordinator)
        exec ${coordinatorPi}/bin/pi-managed-coordinator "$@"
        ;;
      project)
        : "''${PI_MANAGED_PROJECT_SESSION_FILE:?PI_MANAGED_PROJECT_SESSION_FILE is required}"
        export PI_HARNESS_AGENT_PROFILE="managed-project"
        export PI_MANAGED_LOCAL_MODEL_TOOLS=${lib.escapeShellArg managedLocalModelTools}
        export PI_HARNESS_RESOURCES_ROOT="${cfg.package.harnessResources}/share/pi-harness/agent"
        export PI_HARNESS_MATT_SKILLS_ROOT="${cfg.package.mattpocockSkills}/share/pi-harness/mattpocock-skills"
        export PATH="$PATH":${lib.makeBinPath fallbackRuntimePackages}
        ${lspEnabledEnvironment}
        ${lspFallbackEnvironment}
        ${lspDisabledCleanup}
        ${lib.optionalString cfg.lsp.enable ''export PI_HARNESS_LSP_EXTENSION="${cfg.lsp.extension}/share/pi-lsp-extension/src/index.ts"''}
        profile_args=(
          ${managedProfileExtensionArgs}
          ${managedProfileSkillArgs}
          ${managedProfilePromptArgs}
          ${managedProfileThemeArgs}
          --extension "${managedExtensions.ordinary}"
        )
        ${lspExtensionArray}
        # Disable ambient user discovery, then add only conventional resources
        # from this project. This preserves project engineering behavior without
        # reintroducing user-installed local/Pi-R/AgentGraph extensions.
        project_cwd="$(${pkgs.coreutils}/bin/pwd -P)"
        repository_root="$(${pkgs.git}/bin/git -C "$project_cwd" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$project_cwd")"
        repository_root="$(${pkgs.coreutils}/bin/realpath "$repository_root")"
        case "$project_cwd/" in
          "$repository_root/"*) ;;
          *) repository_root="$project_cwd" ;;
        esac
        project_config_roots=("$repository_root")
        [[ "$project_cwd" == "$repository_root" ]] || project_config_roots+=("$project_cwd")
        project_extension_args=()
        for config_root in "''${project_config_roots[@]}"; do
          extension_root="$config_root/.pi/extensions"
          [[ -d "$extension_root" ]] || continue
          while IFS= read -r -d "" candidate; do
            if [[ -d "$candidate" && ! -f "$candidate/index.ts" && ! -f "$candidate/index.js" && ! -f "$candidate/index.mts" && ! -f "$candidate/index.mjs" ]]; then
              continue
            fi
            resource_name="$(${pkgs.coreutils}/bin/basename "$candidate")"
            resource_name="''${resource_name%.*}"
            resource_key="''${resource_name,,}"
            case "$resource_key" in
              pi-r*|agentgraph*|sesh|tmux-cursor-focus) continue ;;
            esac
            project_extension_args+=(--extension "$candidate")
          done < <(${pkgs.findutils}/bin/find "$extension_root" -mindepth 1 -maxdepth 1 \( -type f \( -name '*.ts' -o -name '*.js' -o -name '*.mts' -o -name '*.mjs' \) -o -type d \) -print0 | ${pkgs.coreutils}/bin/sort -z)
        done
        project_skill_args=()
        add_project_skill_root() {
          local root=$1 include_root_markdown=$2 candidate resource_name resource_key
          [[ -d "$root" ]] || return 0
          while IFS= read -r -d "" candidate; do
            if [[ "$candidate" == */SKILL.md ]]; then
              resource_name="$(${pkgs.coreutils}/bin/basename "$(${pkgs.coreutils}/bin/dirname "$candidate")")"
            else
              [[ "$include_root_markdown" == 1 ]] || continue
              resource_name="$(${pkgs.coreutils}/bin/basename "$candidate")"
              resource_name="''${resource_name%.md}"
            fi
            resource_key="''${resource_name,,}"
            case "$resource_key" in
              pi-r*|agentgraph*|sesh|tmux-cursor-focus) continue ;;
            esac
            project_skill_args+=(--skill "$candidate")
          done < <(
            {
              ${pkgs.findutils}/bin/find "$root" -type f -name SKILL.md -print0
              if [[ "$include_root_markdown" == 1 ]]; then
                ${pkgs.findutils}/bin/find "$root" -mindepth 1 -maxdepth 1 -type f -name '*.md' ! -name SKILL.md -print0
              fi
            } | ${pkgs.coreutils}/bin/sort -z
          )
        }
        for config_root in "''${project_config_roots[@]}"; do
          add_project_skill_root "$config_root/.pi/skills" 1
        done
        skill_cursor="$project_cwd"
        while true; do
          add_project_skill_root "$skill_cursor/.agents/skills" 0
          [[ "$skill_cursor" == "$repository_root" || "$skill_cursor" == / ]] && break
          skill_cursor="$(${pkgs.coreutils}/bin/dirname "$skill_cursor")"
        done
        project_prompt_args=()
        for config_root in "''${project_config_roots[@]}"; do
          prompt_root="$config_root/.pi/prompts"
          [[ -d "$prompt_root" ]] || continue
          while IFS= read -r -d "" candidate; do
            resource_name="$(${pkgs.coreutils}/bin/basename "$candidate")"
            resource_name="''${resource_name%.md}"
            resource_key="''${resource_name,,}"
            case "$resource_key" in
              pi-r*|agentgraph*|sesh|tmux-cursor-focus) continue ;;
            esac
            project_prompt_args+=(--prompt-template "$candidate")
          done < <(${pkgs.findutils}/bin/find "$prompt_root" -mindepth 1 -maxdepth 1 -type f -name '*.md' -print0 | ${pkgs.coreutils}/bin/sort -z)
        done
        generation_args=()
        [[ -z "''${PI_MANAGED_SESSION_MODEL:-}" ]] || generation_args+=(--model "$PI_MANAGED_SESSION_MODEL")
        [[ -z "''${PI_MANAGED_SESSION_THINKING:-}" ]] || generation_args+=(--thinking "$PI_MANAGED_SESSION_THINKING")
        exec ${managedRawPi}/bin/pi \
          --no-extensions \
          --no-skills \
          --no-prompt-templates \
          --no-themes \
          "''${profile_args[@]}" \
          "''${extension_args[@]}" \
          "''${project_extension_args[@]}" \
          --extension "${managedExtensions.modelPolicy}" \
          "''${project_skill_args[@]}" \
          "''${project_prompt_args[@]}" \
          --session "$PI_MANAGED_PROJECT_SESSION_FILE" \
          --approve \
          "''${generation_args[@]}" \
          "$@"
        ;;
      *)
        echo "pi-managed-session: trusted launch role is required" >&2
        exit 1
        ;;
    esac
  '';

  managedDirenv = pkgs.writeShellScriptBin "direnv" ''
    set -euo pipefail
    if [[ "''${1:-}" == exec && "''${3:-}" == pi ]]; then
      cwd=$2
      shift 3
      exec ${pkgs.direnv}/bin/direnv exec "$cwd" ${managedPiDispatch}/bin/pi "$@"
    fi
    exec ${pkgs.direnv}/bin/direnv "$@"
  '';

  managedStatus = pkgs.writeShellScriptBin "pi-managed-session-status" ''
    set -euo pipefail
    runtime="''${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}/pi-managed-sessions"
    ${pkgs.systemd}/bin/systemctl --user is-active --quiet pi-managed-session-relay.service
    test -S "$runtime/relay.sock"
    registry="$runtime/registry.json"
    test -f "$registry"
    manifest_dir=${lib.escapeShellArg cfg.managedSessions.manifestDirectory}
    manifest_dir="''${manifest_dir//%h/$HOME}"
    test -d "$manifest_dir"
    pending_reconciliation=0
    if ${pkgs.bash}/bin/bash -c 'compgen -G "$1/conv_*.json" >/dev/null' _ "$manifest_dir"; then
      pending_reconciliation=$(${pkgs.jq}/bin/jq -s '[.[] | select(.kind == "project" and (.projectKey == null))] | length' "$manifest_dir"/conv_*.json)
    fi
    ${pkgs.jq}/bin/jq --argjson pending "$pending_reconciliation" '{service:"active",socket:"ready",conversations:(.conversations|length),states:(.conversations|group_by(.state)|map({key:.[0].state,value:length})|from_entries),cursorConfigured:any(.conversations[]?;.matrixCursor.status == "established"),pendingProjectReconciliation:$pending}' "$registry"
  '';

  managedRelayLaunch = pkgs.writeShellScript "pi-managed-session-relay-launch" ''
    set -euo pipefail
    credential_file=${lib.escapeShellArg (nonNullString cfg.managedSessions.environmentFile)}
    if [[ ! -f "$credential_file" || -L "$credential_file" ]]; then
      echo "pi-managed-session-relay: credential file must be a regular non-symlink file" >&2
      exit 1
    fi
    credential_owner=$(${pkgs.coreutils}/bin/stat -c %u "$credential_file")
    credential_mode=$(${pkgs.coreutils}/bin/stat -c %a "$credential_file")
    if [[ "$credential_owner" != "$(${pkgs.coreutils}/bin/id -u)" || ( "$credential_mode" != 400 && "$credential_mode" != 600 ) ]]; then
      echo "pi-managed-session-relay: credential file must be owned by the relay user with mode 0400 or 0600" >&2
      exit 1
    fi
    matrix_token=""
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue
      if [[ "$line" != PI_MATRIX_ACCESS_TOKEN=* || -n "$matrix_token" ]]; then
        echo "pi-managed-session-relay: credential file may contain only one PI_MATRIX_ACCESS_TOKEN assignment" >&2
        exit 1
      fi
      matrix_token="''${line#PI_MATRIX_ACCESS_TOKEN=}"
    done < "$credential_file"
    if [[ -z "$matrix_token" || ''${#matrix_token} -gt 4096 ]] || printf '%s' "$matrix_token" | ${pkgs.gnugrep}/bin/grep -q '[[:cntrl:]]'; then
      echo "pi-managed-session-relay: PI_MATRIX_ACCESS_TOKEN is missing or malformed" >&2
      exit 1
    fi
    export PI_MATRIX_ACCESS_TOKEN="$matrix_token"
    expand_home() { printf '%s' "''${1//%h/$HOME}"; }
    export PI_MANAGED_SESSIONS_RUNTIME_DIR="''${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}/pi-managed-sessions"
    export PI_MANAGED_SESSIONS_SOCKET="$PI_MANAGED_SESSIONS_RUNTIME_DIR/relay.sock"
    # The relay and interactive launcher must address the same per-user tmux server.
    unset TMUX TMUX_PANE
    export TMUX_TMPDIR="$XDG_RUNTIME_DIR"
    export PI_MANAGED_SESSIONS_MANIFEST_DIR="$(expand_home ${lib.escapeShellArg cfg.managedSessions.manifestDirectory})"
    export PI_MANAGED_COORDINATOR_WORKSPACE_DIR="$(expand_home ${lib.escapeShellArg cfg.managedSessions.coordinator.workspaceDirectory})"
    export PI_MANAGED_COORDINATOR_SESSION_FILE="$(expand_home ${lib.escapeShellArg cfg.managedSessions.coordinator.sessionFile})"
    export PI_MANAGED_PROJECT_SESSION_DIR="$(expand_home ${lib.escapeShellArg cfg.managedSessions.projectSessionDirectory})"
    exec ${lib.getExe managedRelayPackage}
  '';

in
{
  options.services.pi-harness = {
    enable = lib.mkEnableOption "shared Pi coding-agent configuration";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix {
        piPackage = pkgs.pi or (throw "services.pi-harness.package must be set to the flake package");
      };
      defaultText = lib.literalExpression "inputs.pi-harness.packages.${pkgs.system}.default";
      description = "The pi-harness package containing the Pi binary and shared agent config.";
    };

    sessionDirectory = lib.mkOption {
      type = lib.types.nullOr lib.types.nonEmptyStr;
      default = null;
      example = "/home/operator/.local/state/syncthing/pi/sessions";
      description = ''
        Optional Pi session storage directory exported by the installed pi
        wrapper as PI_CODING_AGENT_SESSION_DIR. This applies immediately after
        activation without requiring a new login session.
      '';
    };

    agentgraph.environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = lib.literalExpression ''config.sops.templates."agentgraph-litellm.env".path'';
      description = ''
        Optional runtime environment file sourced by the installed pi command.
        Use this for SOPS-managed LLM provider variables such as
        LITELLM_BASE_URL, LITELLM_API_KEY, and AG_LITELLM_DEFAULT_MODEL.
      '';
    };

    managedSessions = {
      enable = lib.mkEnableOption "boot-persistent managed Matrix sessions";

      user = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
        example = "operator";
        description = "Unix user whose lingered systemd user manager owns the single host relay.";
      };

      relayPackage = lib.mkOption {
        type = lib.types.nullOr lib.types.package;
        default = cfg.package.managedSessionRelay or null;
        defaultText = lib.literalExpression "services.pi-harness.package.managedSessionRelay";
        description = "Separately packaged managed-session relay executable.";
      };

      environmentFile = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
        example = lib.literalExpression ''config.sops.templates."pi-managed-session.env".path'';
        description = "SOPS-managed file strictly parsed as one PI_MATRIX_ACCESS_TOKEN assignment; it is never sourced as a general EnvironmentFile.";
      };

      homeserver = lib.mkOption { type = lib.types.nullOr lib.types.nonEmptyStr; default = null; };
      botUserId = lib.mkOption { type = lib.types.nullOr lib.types.nonEmptyStr; default = null; };
      operatorUserId = lib.mkOption { type = lib.types.nullOr lib.types.nonEmptyStr; default = null; };
      ignoredSenderUserIds = lib.mkOption {
        type = lib.types.listOf lib.types.nonEmptyStr;
        default = [ ];
        description = "Exact Matrix service-account MXIDs ignored for managed-session input; the relay bot is always ignored separately.";
      };
      hostId = lib.mkOption { type = lib.types.nullOr lib.types.nonEmptyStr; default = null; };
      botIsAdmin = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Must remain false; managed host bots are deliberately non-admin.";
      };

      workspaceRoots = lib.mkOption {
        type = lib.types.attrsOf lib.types.nonEmptyStr;
        default = { };
        example = { projects = "/home/operator/documents/projects"; };
        description = "Named immediate-child workspace roots passed to trusted host lifecycle launchers.";
      };

      projectSessionDirectory = lib.mkOption {
        type = lib.types.nonEmptyStr;
        default = "%h/.local/state/pi-managed-sessions/project-sessions";
        description = "Private host-local directory containing coordinator-created persisted project Pi sessions.";
      };

      manifestDirectory = lib.mkOption {
        type = lib.types.nonEmptyStr;
        default = "%h/.local/state/pi-managed-sessions/manifests";
        description = "Private synchronized coordinator/conversation manifest directory; %h expands to the relay user's home.";
      };

      launcherPackage = lib.mkOption {
        type = lib.types.nullOr lib.types.package;
        default = null;
        description = "Host-owned package providing the strict tmux_project managed launcher interface; pi-harness wraps its canonical workspace results with project-identity authority checks.";
      };

      launcherExecutable = lib.mkOption {
        type = lib.types.strMatching "bin/[A-Za-z0-9._+-]+";
        default = "bin/tmux_project";
        description = "Safe package-relative coordinator launcher executable under bin/.";
      };

      coordinator = {
        concept = lib.mkOption { type = lib.types.nonEmptyStr; default = "host coordinator"; };
        workspaceDirectory = lib.mkOption {
          type = lib.types.nonEmptyStr;
          default = "%h/.local/state/pi-managed-sessions/coordinator-workspace";
        };
        sessionFile = lib.mkOption {
          type = lib.types.nonEmptyStr;
          default = "%h/.local/state/pi-managed-sessions/coordinator/session.jsonl";
        };
      };
    };

    diagrams.enable = lib.mkEnableOption "diagram rendering tools for Pi";

    playwright.enable = lib.mkEnableOption "the harness Playwright Agent CLI browser fallback";

    playwright.package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = cfg.package.playwrightAgentCli or null;
      defaultText = lib.literalExpression "services.pi-harness.package.playwrightAgentCli";
      description = ''
        Nix-pinned Playwright Agent CLI and Chromium fallback exposed to Pi.
        Project adapters selected by pi-playwright take precedence over this package.
      '';
    };

    diagrams.packages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = defaultDiagramPackages;
      defaultText = lib.literalExpression "[ pkgs.graphviz pkgs.d2 pkgs.xdg-utils ]";
      description = ''
        Diagram CLI packages exposed on PATH for Pi architecture diagram tools.
        Project-local tools from dev shells take precedence because these are
        appended after the caller's PATH.
      '';
    };

    lsp.enable = lib.mkEnableOption "Language Server Protocol tools for Pi";

    lsp.packages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = defaultLspPackages;
      defaultText = lib.literalExpression "a broad set of common language servers";
      description = ''
        Language server packages exposed on PATH for Pi extensions such as
        pi-lsp-extension. These packages are appended after the caller's PATH so
        project-local language servers from dev shells take precedence.
      '';
    };

    lsp.extension = lib.mkOption {
      type = lib.types.package;
      default = cfg.package.piLspExtension;
      defaultText = lib.literalExpression "services.pi-harness.package.piLspExtension";
      description = "Nix-packaged pi-lsp-extension loaded with --extension.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.lsp.enable || cfg.lsp.extension != null;
        message = "services.pi-harness.lsp.enable requires a pi-lsp-extension package.";
      }
      {
        assertion = !cfg.playwright.enable || cfg.playwright.package != null;
        message = "services.pi-harness.playwright.enable requires a Playwright Agent CLI package.";
      }
      {
        assertion = !managedSessionsEnabled || (
          cfg.managedSessions.user != null
          && cfg.managedSessions.relayPackage != null
          && cfg.managedSessions.environmentFile != null
          && cfg.managedSessions.homeserver != null
          && cfg.managedSessions.botUserId != null
          && cfg.managedSessions.operatorUserId != null
          && cfg.managedSessions.hostId != null
          && cfg.managedSessions.launcherPackage != null
          && cfg.managedSessions.workspaceRoots != { }
          && cfg.package ? managedSessionExtensions
          && cfg.package.managedSessionExtensions ? ordinary
          && cfg.package.managedSessionExtensions ? coordinator
          && cfg.package.managedSessionExtensions ? modelPolicy
          && builtins.length localProfile.tools > 0
          && cfg.package ? pi
        );
        message = "services.pi-harness.managedSessions.enable requires user, relayPackage, environmentFile, Matrix identities, hostId, launcherPackage, named workspaceRoots, managed adapter/model-policy extensions, and a non-empty pi-local tool profile.";
      }
      {
        assertion = !managedSessionsEnabled || !cfg.managedSessions.botIsAdmin;
        message = "services.pi-harness managed-session bots must be non-admin.";
      }
      {
        assertion = !managedSessionsEnabled || (
          builtins.length cfg.managedSessions.ignoredSenderUserIds <= 64
          && builtins.length (lib.unique cfg.managedSessions.ignoredSenderUserIds) == builtins.length cfg.managedSessions.ignoredSenderUserIds
          && lib.all (userId: builtins.match "@[^[:space:]:]{1,255}:[^[:space:]]{1,255}" userId != null) cfg.managedSessions.ignoredSenderUserIds
          && !(builtins.elem (nonNullString cfg.managedSessions.operatorUserId) cfg.managedSessions.ignoredSenderUserIds)
        );
        message = "services.pi-harness.managedSessions.ignoredSenderUserIds must contain at most 64 unique complete MXIDs and cannot ignore the configured operator.";
      }
      {
        assertion = !managedSessionsEnabled || lib.all (name: builtins.match "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" name != null) (builtins.attrNames cfg.managedSessions.workspaceRoots);
        message = "services.pi-harness.managedSessions.workspaceRoots keys must be stable identifiers.";
      }
    ];

    users.users = lib.optionalAttrs (managedSessionsEnabled && cfg.managedSessions.user != null) {
      ${cfg.managedSessions.user}.linger = true;
    };

    systemd.user.services.pi-managed-session-relay = lib.mkIf managedSessionsEnabled {
      description = "Boot-persistent Pi managed-session host relay";
      wantedBy = [ "default.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      unitConfig.ConditionUser = nonNullString cfg.managedSessions.user;
      path = [ managedDirenv managedPiDispatch managedLauncherPackage pkgs.coreutils ];
      environment = {
        PI_MANAGED_SESSIONS_HOST_ID = nonNullString cfg.managedSessions.hostId;
        PI_MANAGED_SESSIONS_WORKSPACE_ROOTS = builtins.toJSON cfg.managedSessions.workspaceRoots;
        PI_MANAGED_COORDINATOR_CONCEPT = cfg.managedSessions.coordinator.concept;
        PI_MANAGED_COORDINATOR_LAUNCHER = "${managedLauncherPackage}/bin/tmux_project";
        PI_MATRIX_HOMESERVER = nonNullString cfg.managedSessions.homeserver;
        PI_MATRIX_BOT_USER_ID = nonNullString cfg.managedSessions.botUserId;
        PI_MATRIX_OPERATOR_USER_ID = nonNullString cfg.managedSessions.operatorUserId;
        PI_MATRIX_IGNORED_SENDER_USER_IDS = builtins.toJSON cfg.managedSessions.ignoredSenderUserIds;
      };
      serviceConfig = {
        Type = "simple";
        ExecStart = managedRelayLaunch;
        Restart = "always";
        RestartSec = 2;
        UMask = "0077";
        NoNewPrivileges = true;
      };
    };

    environment.systemPackages =
      (if runtimeEnvironmentFiles != [ ] || runtimeFeaturesEnabled || sessionDirectoryEnabled || managedSessionsEnabled then
        [ piWithRuntime ]
      else
        [ cfg.package ])
      ++ lib.optional managedSessionsEnabled managedStatus;
  };
}
