{ lib, config, pkgs, ... }:
let
  cfg = config.services.pi-harness;
in
{
  options.services.pi-harness = {
    enable = lib.mkEnableOption "Install the pi-harness command via this module";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "The pi-harness package to install.";
    };

    installAlias = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to add a `ph` shell alias in interactive bash shells.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    programs.bash.interactiveShellInit = lib.mkIf cfg.installAlias ''
      alias ph='pi-harness'
    '';
  };
}
