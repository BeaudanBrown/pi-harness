{ config, lib, pkgs, ... }:
let
  cfg = config.services.pi-harness.bridgeChat.workspaceExecutor;
  package = import ./chat-workspace-package.nix { inherit pkgs; };
  privatePath = value: lib.hasPrefix "/" value && value != "/"
    && !(lib.hasPrefix "/nix/store/" value) && builtins.match "[^:\n\r]+" value != null;
in {
  options.services.pi-harness.bridgeChat.workspaceExecutor = {
    enable = lib.mkEnableOption "credential-free sandboxed chat workspace executor (not chat routing)";
    projectDirectory = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Host-approved canonical project directory. The operator must arrange editor ownership and serialize writers.";
    };
    user = lib.mkOption {
      type = lib.types.strMatching "[a-z_][a-z0-9_-]*";
      default = "pi-workspace";
      description = "Existing Unix identity with access to the project. No credentials are loaded or inherited.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [ {
      assertion = pkgs.stdenv.isLinux && privatePath cfg.projectDirectory;
      message = "workspaceExecutor requires Linux and an absolute runtime project directory.";
    } ];
    users.groups.pi-chat = { };
    systemd.services.pi-chat-workspace = {
      description = "Isolated Pi project file operations (no model or transport credentials)";
      wantedBy = [ "multi-user.target" ];
      unitConfig.RequiresMountsFor = cfg.projectDirectory;
      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = "pi-chat";
        ExecStart = "${package}/bin/pi-chat-workspace ${lib.escapeShellArg cfg.projectDirectory} /var/lib/pi-chat-workspace /run/pi-chat-workspace";
        StateDirectory = "pi-chat-workspace";
        StateDirectoryMode = "0700";
        RuntimeDirectory = "pi-chat-workspace";
        RuntimeDirectoryMode = "0750";
        UMask = "0077";
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.projectDirectory ];
        PrivateTmp = true;
        PrivateDevices = true;
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        RestrictAddressFamilies = [ "AF_UNIX" ];
        InaccessiblePaths = [ "-/run/secrets" "-/run/agenix" "-/run/user" ];
        MemoryMax = "256M";
        TasksMax = 16;
        CPUQuota = "100%";
        LimitCORE = 0;
        LimitNOFILE = 128;
        TimeoutStopSec = 10;
        KillMode = "control-group";
        Restart = "on-failure";
        RestartSec = 10;
      };
    };
  };
}
