{ config, lib, pkgs, ... }:
let
  cfg = config.services.pi-harness.bridgeChat.preflight;
  python = pkgs.python3.withPackages (p: [ p.pyyaml ]);
  settings = pkgs.writeText "pi-bridge-chat-preflight.json" (builtins.toJSON {
    inherit (cfg) ownerUserId;
    bridges = lib.mapAttrs (_: bridge: bridge.endpoint) cfg.bridges;
  });
  runner = pkgs.writeShellScript "pi-bridge-chat-preflight" ''
    exec ${python}/bin/python3 -I ${../scripts/bridge-chat-preflight.py} ${settings}
  '';
in
{
  options.services.pi-harness.bridgeChat.preflight = {
    enable = lib.mkEnableOption "read-only, credential-isolated bridge readiness inspection (not the !pi assistant)";
    ownerUserId = lib.mkOption {
      type = lib.types.strMatching "@[^[:space:]:]+:[^[:space:]]+";
      description = "Matrix identity whose existing bridge logins are inspected. Not a token.";
    };
    bridges = lib.mkOption {
      default = { };
      description = "Bridge runtime configurations copied privately by systemd; only whitelisted diagnostic fields are reported.";
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          endpoint = lib.mkOption {
            type = lib.types.strMatching "http://127[.]0[.]0[.]1:[0-9]+/?";
            description = "Literal loopback bridge address. Redirects and proxy environment variables are never used.";
          };
          credentialFile = lib.mkOption {
            type = lib.types.str;
            description = "Absolute runtime YAML configuration path, not a Nix path or store file. Copied with LoadCredential; never read during evaluation.";
          };
          serviceUnit = lib.mkOption {
            type = lib.types.strMatching "[a-zA-Z0-9@._-]+[.]service";
            description = "Existing bridge unit to order the probe after. The probe never restarts it.";
          };
        };
      });
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = builtins.length (builtins.attrNames cfg.bridges) >= 1 && builtins.length (builtins.attrNames cfg.bridges) <= 8;
        message = "Bridge preflight requires between one and eight bridges.";
      }
      {
        assertion = lib.all (name: builtins.match "[a-z][a-z0-9-]{0,31}" name != null) (builtins.attrNames cfg.bridges);
        message = "Bridge preflight names must be safe credential identifiers.";
      }
      {
        assertion = lib.all (bridge:
          lib.hasPrefix "/" bridge.credentialFile &&
          !(lib.hasPrefix "/nix/store/" bridge.credentialFile) &&
          builtins.match "[^:\n\r]+" bridge.credentialFile != null
        ) (builtins.attrValues cfg.bridges);
        message = "Bridge credential sources must be absolute runtime paths, never store paths.";
      }
    ];
    systemd.services.pi-bridge-chat-preflight = {
      description = "Read-only Pi bridge chat preflight (no model or chat processing)";
      wantedBy = [ "multi-user.target" ];
      after = map (bridge: bridge.serviceUnit) (builtins.attrValues cfg.bridges);
      serviceConfig = {
        Type = "oneshot";
        ExecStart = runner;
        LoadCredential = lib.mapAttrsToList (name: bridge: "${name}:${bridge.credentialFile}") cfg.bridges;
        DynamicUser = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        NoNewPrivileges = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
        IPAddressDeny = "any";
        IPAddressAllow = "localhost";
        CapabilityBoundingSet = "";
        UMask = "0077";
        TimeoutStartSec = 45;
        MemoryMax = "128M";
        TasksMax = 16;
        LimitCORE = 0;
        StandardOutput = "journal";
        StandardError = "journal";
      };
    };
  };
}
