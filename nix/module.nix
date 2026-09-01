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
  ]
  ++ lib.optionals cfg.lsp.enable cfg.lsp.packages
  ++ lib.optionals cfg.diagrams.enable cfg.diagrams.packages
  ++ lib.optionals (cfg.playwright.enable && cfg.playwright.package != null) [
    cfg.playwright.package
  ];
  runtimeFeaturesEnabled = cfg.lsp.enable || cfg.diagrams.enable || cfg.playwright.enable;
  sessionDirectoryEnabled = cfg.sessionDirectory != null;
  remoteSessionEnabled = cfg.remoteSession.environmentFile != null;
  managedSessionsEnabled = cfg.managedSessions.enable;
  nonNullString = value: if value == null then "" else value;
  managedRelayPackage = if cfg.managedSessions.relayPackage == null then cfg.package else cfg.managedSessions.relayPackage;
  managedLauncherPackage = if cfg.managedSessions.launcherPackage == null then pkgs.runCommand "missing-managed-session-launcher" { } "mkdir -p $out" else cfg.managedSessions.launcherPackage;
  managedExtensions = cfg.package.managedSessionExtensions or { ordinary = "/missing-managed-ordinary"; coordinator = "/missing-managed-coordinator"; };
  managedRawPi = cfg.package.pi or cfg.package;
  runtimeEnvironmentFiles = lib.filter (path: path != null) [
    cfg.agentgraph.environmentFile
    cfg.remoteSession.environmentFile
  ];
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
  remoteSessionEnvironment = lib.optionalString remoteSessionEnabled ''
    export PI_MATRIX_HOMESERVER=${lib.escapeShellArg (nonNullString cfg.remoteSession.homeserver)}
    export PI_MATRIX_BOT_USER_ID=${lib.escapeShellArg (nonNullString cfg.remoteSession.botUserId)}
    export PI_MATRIX_OPERATOR_USER_ID=${lib.escapeShellArg (nonNullString cfg.remoteSession.operatorUserId)}
    export PI_MATRIX_HOSTNAME=${lib.escapeShellArg (nonNullString cfg.remoteSession.hostName)}
  '';
  lspExtensionArray =
    if cfg.lsp.enable then
      ''extension_args=(--extension "${cfg.lsp.extension}/share/pi-lsp-extension/src/index.ts")''
    else
      "extension_args=()";
  managedOrdinaryExtension = lib.optionalString managedSessionsEnabled ''
    extension_args+=(--extension "${managedExtensions.ordinary}")
  '';

  piWithRuntime = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail
    ${runtimeEnvironmentSetup}
    ${sessionDirectoryEnvironment}
    ${managedSessionEnvironment}
    ${remoteSessionEnvironment}
    export PATH="$PATH":${lib.makeBinPath fallbackRuntimePackages}
    ${lspExtensionArray}
    ${managedOrdinaryExtension}
    exec ${cfg.package}/bin/pi "''${extension_args[@]}" "$@"
  '';

  coordinatorPi = pkgs.writeShellScriptBin "pi-managed-coordinator" ''
    set -euo pipefail
    : "''${PI_MANAGED_COORDINATOR_CWD:?PI_MANAGED_COORDINATOR_CWD is required}"
    : "''${PI_MANAGED_COORDINATOR_SESSION_FILE:?PI_MANAGED_COORDINATOR_SESSION_FILE is required}"
    cd "$PI_MANAGED_COORDINATOR_CWD"
    exec ${managedRawPi}/bin/pi \
      --no-extensions \
      --extension "${managedExtensions.coordinator}" \
      --session "$PI_MANAGED_COORDINATOR_SESSION_FILE" \
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
        exec ${managedRawPi}/bin/pi \
          --no-extensions \
          --extension "${managedExtensions.ordinary}" \
          --session "$PI_MANAGED_PROJECT_SESSION_FILE" \
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
    if [[ -z "$matrix_token" || "$matrix_token" == *$'\r'* || "$matrix_token" == *$'\n'* ]]; then
      echo "pi-managed-session-relay: PI_MATRIX_ACCESS_TOKEN is missing or malformed" >&2
      exit 1
    fi
    export PI_MATRIX_ACCESS_TOKEN="$matrix_token"
    expand_home() { printf '%s' "''${1//%h/$HOME}"; }
    export PI_MANAGED_SESSIONS_RUNTIME_DIR="''${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}/pi-managed-sessions"
    export PI_MANAGED_SESSIONS_SOCKET="$PI_MANAGED_SESSIONS_RUNTIME_DIR/relay.sock"
    export PI_MANAGED_SESSIONS_MANIFEST_DIR="$(expand_home ${lib.escapeShellArg cfg.managedSessions.manifestDirectory})"
    export PI_MANAGED_COORDINATOR_WORKSPACE_DIR="$(expand_home ${lib.escapeShellArg cfg.managedSessions.coordinator.workspaceDirectory})"
    export PI_MANAGED_COORDINATOR_SESSION_FILE="$(expand_home ${lib.escapeShellArg cfg.managedSessions.coordinator.sessionFile})"
    export PI_MANAGED_PROJECT_SESSION_DIR="$(expand_home ${lib.escapeShellArg cfg.managedSessions.projectSessionDirectory})"
    exec ${lib.getExe managedRelayPackage}
  '';

  matrixWhoami = pkgs.writeShellScriptBin "pi-matrix-whoami" ''
    set -euo pipefail
    ${runtimeEnvironmentSetup}
    ${remoteSessionEnvironment}
    exec ${cfg.package}/bin/pi-matrix-whoami "$@"
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

    remoteSession = {
      environmentFile = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
        example = lib.literalExpression ''config.sops.secrets."pi/matrix-env".path'';
        description = ''
          Optional SOPS-managed environment file containing only
          PI_MATRIX_ACCESS_TOKEN. When set, the pi command and
          pi-matrix-whoami receive the Matrix remote-session configuration.
        '';
      };

      homeserver = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
        example = "https://matrix.example.com";
        description = "Matrix homeserver base URL for the host bot.";
      };

      botUserId = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
        example = "@pi-host:example.com";
        description = "Expected Matrix user ID for the host bot.";
      };

      operatorUserId = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
        example = "@operator:example.com";
        description = "Only Matrix user ID authorized to send remote input.";
      };

      hostName = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
        example = "workstation";
        description = "Literal host routing name used by the remote-session extension.";
      };
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
        description = "Host-owned package providing the strict tmux_project managed launcher interface.";
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
          && cfg.package ? pi
        );
        message = "services.pi-harness.managedSessions.enable requires user, relayPackage, environmentFile, Matrix identities, hostId, launcherPackage, and named workspaceRoots.";
      }
      {
        assertion = !managedSessionsEnabled || !cfg.managedSessions.botIsAdmin;
        message = "services.pi-harness managed-session bots must be non-admin.";
      }
      {
        assertion = !managedSessionsEnabled || !remoteSessionEnabled;
        message = "services.pi-harness managed sessions cannot expose the legacy per-Pi Matrix credential environment.";
      }
      {
        assertion = !managedSessionsEnabled || lib.all (name: builtins.match "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" name != null) (builtins.attrNames cfg.managedSessions.workspaceRoots);
        message = "services.pi-harness.managedSessions.workspaceRoots keys must be stable identifiers.";
      }
      {
        assertion =
          !remoteSessionEnabled
          || lib.all (value: value != null) [
            cfg.remoteSession.homeserver
            cfg.remoteSession.botUserId
            cfg.remoteSession.operatorUserId
            cfg.remoteSession.hostName
          ];
        message = ''
          services.pi-harness.remoteSession.environmentFile requires homeserver,
          botUserId, operatorUserId, and hostName.
        '';
      }
    ];

    systemd.lingerUsers = lib.mkIf managedSessionsEnabled (lib.optional (cfg.managedSessions.user != null) cfg.managedSessions.user);

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
        PI_MANAGED_COORDINATOR_LAUNCHER = "${managedLauncherPackage}/${cfg.managedSessions.launcherExecutable}";
        PI_MATRIX_HOMESERVER = nonNullString cfg.managedSessions.homeserver;
        PI_MATRIX_BOT_USER_ID = nonNullString cfg.managedSessions.botUserId;
        PI_MATRIX_OPERATOR_USER_ID = nonNullString cfg.managedSessions.operatorUserId;
      };
      serviceConfig = {
        Type = "simple";
        ExecStart = managedRelayLaunch;
        Restart = "always";
        RestartSec = 2;
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateTmp = true;
      };
    };

    environment.systemPackages =
      (if runtimeEnvironmentFiles != [ ] || runtimeFeaturesEnabled || sessionDirectoryEnabled || managedSessionsEnabled then
        [ piWithRuntime ]
      else
        [ cfg.package ])
      ++ lib.optional remoteSessionEnabled matrixWhoami;
  };
}
