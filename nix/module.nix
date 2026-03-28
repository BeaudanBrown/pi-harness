{ lib, config, pkgs, ... }:
let
  cfg = config.services.pi-harness;
in
{
  options.services.pi-harness = {
    enable = lib.mkEnableOption "Install the pi-harness command via this module";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.writeShellApplication {
        name = "pi-harness";
        runtimeInputs = [ pkgs.bash ];
        text = ''
          echo "pi-harness skeleton package: install dependencies and set package via services.pi-harness.package"
        '';
      };
      defaultText = lib.literalExpression "pkgs.writeShellApplication { ... }";
      description = "The pi-harness package to install.";
    };

    installAlias = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to add a `ph` shell alias.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    programs.bash.interactiveShellInit = lib.mkIf cfg.installAlias ''
      alias ph='pi-harness'
    '';
  };
}
