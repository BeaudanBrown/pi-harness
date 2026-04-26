{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.services.pi-harness;
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
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
