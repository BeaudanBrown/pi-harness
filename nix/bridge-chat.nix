{ config, lib, pkgs, ... }:
let
  cfg = config.services.pi-harness.bridgeChat.assistant;
  package = import ./bridge-chat-package.nix { inherit pkgs; piPackage = config.services.pi-harness.package.pi; };
  socket = "/run/pi-chat-model/answer.sock";
  settings = pkgs.writeText "pi-chat-transport.json" (builtins.toJSON {
    inherit (cfg) homeserver ownerUserId remoteOwnerUserIds roomIds allJoinedRooms;
    modelSocket = socket;
  });
  privatePath = value: lib.hasPrefix "/" value && !(lib.hasPrefix "/nix/store/" value)
    && builtins.match "[^:\n\r]+" value != null;
  common = {
    DynamicUser = true;
    Group = "pi-chat";
    StateDirectoryMode = "0700";
    UMask = "0077";
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    NoNewPrivileges = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
    CapabilityBoundingSet = "";
    InaccessiblePaths = [ "-/run/postgresql" "-/var/lib/postgresql" "-/run/secrets" "-/run/user" "-/var/lib/mautrix-signal" "-/var/lib/mautrix-meta-facebook" ];
    LimitCORE = 0;
    MemoryMax = "256M";
    TasksMax = 32;
    Restart = "on-failure";
    RestartSec = 10;
    TimeoutStopSec = 5;
  };
in {
  options.services.pi-harness.bridgeChat.assistant = {
    enable = lib.mkEnableOption "stateless owner-only !pi assistant (requires separately approved credentials and live acceptance)";
    homeserver = lib.mkOption { type = lib.types.str; default = ""; description = "HTTPS origin, without a path, of the owner's Matrix homeserver."; };
    ownerUserId = lib.mkOption { type = lib.types.strMatching "@[^[:space:]:]+:[^[:space:]]+"; description = "Exact Matrix owner account used for intake and replies. The token inherits this account's privileges."; };
    matrixTokenFile = lib.mkOption { type = lib.types.str; description = "Runtime file containing only a dedicated owner-login access token. This credential has account-wide authority, including admin rights if the owner has them; never provide an appservice token."; };
    modelUser = lib.mkOption { type = lib.types.strMatching "[a-z_][a-z0-9_-]*"; description = "Existing Unix user whose installed Pi login the worker reuses."; };
    piAgentDirectory = lib.mkOption { type = lib.types.str; description = "Original existing Pi agent directory, containing auth.json and its shared sibling lock. Bound at the same path for Pi-coordinated credential refresh; no resources/settings/models are discovered from it."; };
    model = lib.mkOption { type = lib.types.strMatching "[a-zA-Z0-9._-]{1,100}"; default = "gpt-5.4"; description = "Explicit Codex model; verify account entitlement during activation. No fallback to another model."; };
    roomIds = lib.mkOption { type = lib.types.listOf (lib.types.strMatching "![^[:space:]]+"); default = [ ]; description = "Initial test-room allowlist; use new IDs after recreating encrypted mirrors."; };
    allJoinedRooms = lib.mkOption { type = lib.types.bool; default = false; description = "Explicitly accept commands in all eligible rooms this owner account joins, not just roomIds. Does not grant server-wide access."; };
    remoteOwnerUserIds = lib.mkOption { type = lib.types.listOf (lib.types.strMatching "@[^[:space:]:]+:[^[:space:]]+"); default = [ ]; description = "Exact bridge-controlled puppet MXIDs independently verified to represent this owner. Never derive authority from display names or message metadata."; };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = privatePath cfg.matrixTokenFile && privatePath cfg.piAgentDirectory && cfg.piAgentDirectory != "/"; message = "Chat credentials and existing Pi auth directory must be absolute runtime paths, never Nix store paths."; }
      { assertion = lib.hasPrefix "https://" cfg.homeserver; message = "Chat transport requires an HTTPS homeserver origin."; }
      { assertion = cfg.allJoinedRooms || cfg.roomIds != [ ]; message = "Chat assistant requires an explicit test-room allowlist or allJoinedRooms approval."; }
      { assertion = builtins.length cfg.roomIds <= 256 && builtins.length cfg.remoteOwnerUserIds <= 8; message = "Chat allowlists exceed their bounds."; }
    ];
    users.groups.pi-chat = { };
    systemd.services.pi-chat-model = {
      description = "Restricted stateless Pi SDK worker using existing Pi authentication";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        HOME = "/var/lib/pi-chat-model";
        PI_CODING_AGENT_DIR = "/var/lib/pi-chat-model/isolated";
      };
      serviceConfig = common // {
        DynamicUser = false;
        User = cfg.modelUser;
        # Keep the real path and its shared lock visible; a copied credential or
        # private bind of only auth.json would break Pi's refresh coordination.
        ProtectHome = "tmpfs";
        BindPaths = [ cfg.piAgentDirectory ];
        ReadWritePaths = [ cfg.piAgentDirectory ];
        ExecStart = "${package}/bin/pi-chat-model ${socket} ${lib.escapeShellArg "${cfg.piAgentDirectory}/auth.json"} ${cfg.model}";
        RuntimeDirectory = "pi-chat-model";
        RuntimeDirectoryMode = "0750";
        StateDirectory = "pi-chat-model";
        WorkingDirectory = "/var/lib/pi-chat-model";
      };
    };
    systemd.services.pi-chat-transport = {
      description = "Owner-only Matrix !pi intake and bounded reply transport";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "pi-chat-model.service" ];
      wants = [ "network-online.target" "pi-chat-model.service" ];
      serviceConfig = common // {
        ExecStart = "${package}/bin/pi-chat-transport ${settings}";
        LoadCredential = [ "matrix:${cfg.matrixTokenFile}" ];
        StateDirectory = "pi-chat-transport";
        WorkingDirectory = "/var/lib/pi-chat-transport";
      };
    };
  };
}
