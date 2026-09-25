{ config, lib, pkgs, ... }:
let
  cfg = config.services.pi-harness.bridgeChat.workspaceExecutor;
  package = import ./chat-workspace-package.nix { inherit pkgs; inherit (cfg) commands commandMounts; };
  privatePath = value: lib.hasPrefix "/" value && value != "/"
    && !(lib.hasPrefix "/nix/store/" value) && builtins.match "[^:\n\r]+" value != null;
in {
  options.services.pi-harness.bridgeChat.workspaceExecutor = {
    enable = lib.mkEnableOption "credential-free sandboxed chat workspace executor (not chat routing)";
    projectDirectory = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Host-approved canonical project directory. Normal host editing remains available; use one editor at a time.";
    };
    commands = lib.mkOption {
      type = lib.types.attrsOf (lib.types.listOf lib.types.str);
      default = { };
      description = "Named fixed argv commands, starting with a Nix store executable. Executed in the sandbox, never through a shell. Use trusted packaged commands, not project scripts.";
    };
    commandMounts = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          source = lib.mkOption { type = lib.types.str; };
          readOnly = lib.mkOption { type = lib.types.bool; default = true; };
        };
      });
      default = { };
      description = "Trusted data mounts for commands, under /commands/data/<name>; unavailable to generic file tools.";
    };
    user = lib.mkOption {
      type = lib.types.strMatching "[a-z_][a-z0-9_-]*";
      default = "pi-workspace";
      description = "Existing Unix identity with access to the project. No credentials are loaded or inherited.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [ {
      assertion = pkgs.stdenv.isLinux && privatePath cfg.projectDirectory
        && lib.all (name: builtins.match "[A-Za-z_][A-Za-z0-9_]*" name != null) (builtins.attrNames cfg.commands ++ builtins.attrNames cfg.commandMounts)
        && lib.all (argv: argv != [ ] && lib.hasPrefix "/nix/store/" (builtins.head argv)) (builtins.attrValues cfg.commands)
        && lib.all (mount: privatePath mount.source) (builtins.attrValues cfg.commandMounts);
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
        ExecStart = "${package}/bin/pi-chat-workspace ${lib.escapeShellArg cfg.projectDirectory} /run/pi-chat-workspace";
        RuntimeDirectory = "pi-chat-workspace";
        RuntimeDirectoryMode = "0750";
        UMask = "0077";
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.projectDirectory ] ++ map (mount: mount.source) (builtins.filter (mount: !mount.readOnly) (builtins.attrValues cfg.commandMounts));
        PrivateTmp = true;
        PrivateDevices = true;
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        # Bubblewrap owns the inner PID/proc namespace. Pre-masking paths below
        # /proc here makes its fresh procfs mount fail with "Mount too revealing".
        ProtectKernelTunables = false;
        ProtectKernelModules = true;
        ProtectKernelLogs = false;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        # Bubblewrap needs route netlink (and libc's interface lookup socket)
        # to initialise loopback in its private network namespace.
        PrivateNetwork = true;
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_NETLINK" ];
        InaccessiblePaths = [ "-/run/secrets" "-/run/agenix" "-/run/user" ];
        MemoryMax = "512M";
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
