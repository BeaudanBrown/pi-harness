{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.services.pi-harness;

  piWithAgentGraphEnv = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail
    set -a
    # shellcheck disable=SC1090,SC1091
    . ${lib.escapeShellArg cfg.agentgraph.environmentFile}
    set +a
    export PATH=${lib.makeBinPath [ cfg.package ]}:"$PATH"
    exec ${cfg.package}/bin/pi "$@"
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
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages =
      if cfg.agentgraph.environmentFile == null then
        [ cfg.package ]
      else
        [ piWithAgentGraphEnv ];
  };
}
