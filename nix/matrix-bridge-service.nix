{ lib, pkgs, cfg, harnessPackage, nativeLauncher, sessionDirectory, hostName }:
let
  inherit (lib) mkOption types;
  publicConfig = pkgs.writeText "pi-matrix-bridge-ui.json" (builtins.toJSON {
    inherit (cfg) socket roots;
  });
  helper = pkgs.writeShellScriptBin "pi-session" ''
    set -euo pipefail
    export PI_BRIDGE_PI=${lib.escapeShellArg "${nativeLauncher}/bin/pi"}
    export PI_BRIDGE_TMUX=${lib.escapeShellArg (lib.getExe cfg.tmuxPackage)}
    export PI_BRIDGE_DIRENV=${lib.escapeShellArg (lib.getExe pkgs.direnv)}
    export PI_BRIDGE_STATE_DIRECTORY=${lib.escapeShellArg cfg.stateDirectory}
    export PI_BRIDGE_SESSION_ROOTS=${lib.escapeShellArg (builtins.toJSON cfg.sessionRoots)}
    ${lib.optionalString (cfg.windowLauncher != null) ''export PI_BRIDGE_WINDOW_LAUNCHER=${lib.escapeShellArg (lib.getExe cfg.windowLauncher)}''}
    exec ${cfg.package}/bin/pi-session "$@"
  '';
  daemonConfig = pkgs.writeText "pi-matrix-bridge.json" (builtins.toJSON {
    inherit (cfg) hostId stateDirectory socket roots homeserver botUserId operatorUserId ignoredSenderUserIds;
    localHelper = "${helper}/bin/pi-session";
  });
in {
  inherit helper;
  environment = lib.optionalString cfg.enable ''
    for key in "''${!PI_MATRIX_@}" "''${!PI_MANAGED_@}" "''${!PI_BRIDGE_CHAT_@}"; do unset "$key"; done
    # This ordinary entry point reuses the central engineering profile, not an
    # inherited managed role. Workers/experiments have their own entry points.
    unset MATRIX_ACCESS_TOKEN MATRIX_OPERATOR_TOKEN CREDENTIALS_DIRECTORY PI_HARNESS_AGENT_PROFILE
    if [[ "''${PI_HARNESS_LOCAL_ONLY:-0}" != 1 && "''${PI_BRIDGE_LOCAL_ONLY:-0}" != 1 ]]; then
      export PI_MATRIX_BRIDGE_UI_CONFIG=${publicConfig}
    fi
  '';
  options = {
    enable = lib.mkEnableOption "the optional native-session Matrix bridge (never local launch admission)";
    package = mkOption { type = types.nullOr types.package; default = harnessPackage.matrixBridge or null; };
    user = mkOption { type = types.nullOr types.str; default = null; };
    hostId = mkOption { type = types.str; default = hostName; description = "Stable host identity, preserved across updates."; };
    roots = mkOption { type = types.listOf types.str; default = [ ]; description = "Interactive workspaces eligible for asynchronous enrollment; unrelated local Pi remains available."; };
    sessionRoots = mkOption {
      type = types.listOf types.str;
      default = if sessionDirectory == null then [ "%h/.pi/agent/sessions" ] else [ sessionDirectory ];
      description = "Native history directories for the offline picker. Bound historical files are also included when the optional ledger is readable.";
    };
    stateDirectory = mkOption { type = types.str; default = "%h/.local/state/pi-matrix-bridge"; };
    socket = mkOption { type = types.str; default = "%t/pi-matrix-bridge/bridge.sock"; };
    environmentFile = mkOption {
      type = types.nullOr types.str; default = null;
      description = "Existing SOPS file containing only PI_MATRIX_ACCESS_TOKEN. Loaded as a systemd credential, never a child environment variable.";
    };
    homeserver = mkOption { type = types.nullOr types.str; default = null; };
    botUserId = mkOption { type = types.nullOr types.str; default = null; };
    operatorUserId = mkOption { type = types.nullOr types.str; default = null; description = "Human owner invited by asynchronous room/Space setup; not a participant allowlist."; };
    ignoredSenderUserIds = mkOption { type = types.listOf types.str; default = [ ]; };
    tmuxPackage = mkOption { type = types.package; default = pkgs.tmux; description = "Host-owned tmux client; use the independently owned shared server wrapper on persistent hosts."; };
    windowLauncher = mkOption { type = types.nullOr types.package; default = null; description = "Optional host-owned tmux_project package providing native-window with fixed argv JSON. No managed host protocol."; };
    retainRuntime = mkOption { type = types.bool; default = true; description = "Root each ordinary Pi launcher closure for its running lifetime; upgrades never replace live Pi."; };
  };
  assertions = [
    {
      assertion = !cfg.enable || (cfg.package != null && cfg.user != null && cfg.environmentFile != null && cfg.homeserver != null && cfg.botUserId != null && cfg.operatorUserId != null && cfg.roots != [ ]);
      message = "services.pi-harness.matrixBridge requires a packaged bridge, user, credential file, Matrix identities, and workspace roots.";
    }
    {
      assertion = !cfg.enable || (builtins.match "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" cfg.hostId != null && lib.all (user: builtins.match "@[^[:space:]:]+:[^[:space:]]+" user != null) cfg.ignoredSenderUserIds);
      message = "Matrix bridge host and ignored sender identities must be valid.";
    }
  ];
  service = {
    description = "Optional Matrix bridge for ordinary native Pi sessions";
    wantedBy = [ "default.target" ];
    after = [ "network-online.target" ];
    unitConfig.ConditionUser = if cfg.user == null then "" else cfg.user;
    path = [ pkgs.coreutils pkgs.git pkgs.direnv ];
    serviceConfig = {
      Type = "simple";
      ExecStart = "${cfg.package}/bin/pi-matrix-bridge --config ${daemonConfig} --credential-file %d/matrix-token";
      LoadCredential = [ "matrix-token:${if cfg.environmentFile == null then "/missing" else cfg.environmentFile}" ];
      Restart = "on-failure";
      RestartSec = 5;
      TimeoutStopSec = 20;
      KillMode = "process";
      UMask = "0077";
      RuntimeDirectory = "pi-matrix-bridge";
      RuntimeDirectoryMode = "0700";
      # This is the operator's trusted account, not a process sandbox. Never
      # poison an interactive shared tmux server (or its shells/sudo) via NNP.
      NoNewPrivileges = false;
    };
    # Deliberately no PartOf/BindsTo/Requires or stop/restart hooks for tmux/Pi.
  };
}
