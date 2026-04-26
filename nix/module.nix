{
  lib,
  config,
  options,
  pkgs,
  ...
}:
let
  cfg = config.services.pi-harness;
  hasHomeManager = options ? home-manager && options.home-manager ? users;
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

    user = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "beau";
      description = "Home Manager user that should receive the shared Pi config.";
    };

    installConfig = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to install the shared Pi config into the selected user's home.";
    };
  };

  config = lib.mkIf cfg.enable (
    {
      environment.systemPackages = [ cfg.package ];
    }
    // lib.optionalAttrs (cfg.installConfig && cfg.user != null && hasHomeManager) {
      home-manager.users.${cfg.user}.home.file = {
        ".pi/agent/settings.json".source = "${cfg.package}/share/pi-harness/agent/settings.json";
        ".pi/agent/extensions".source = "${cfg.package}/share/pi-harness/agent/extensions";
        ".pi/agent/skills".source = "${cfg.package}/share/pi-harness/agent/skills";
        ".pi/agent/prompts".source = "${cfg.package}/share/pi-harness/agent/prompts";
        ".pi/agent/themes".source = "${cfg.package}/share/pi-harness/agent/themes";
      };
    }
  );
}
