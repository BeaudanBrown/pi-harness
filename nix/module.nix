{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.services.pi-harness;

  agentgraphWrapper = pkgs.writeShellApplication {
    name = cfg.agentgraph.wrapperName;
    runtimeInputs = [ cfg.package ];
    text = ''
      set -euo pipefail
      set -a
      # shellcheck disable=SC1090
      source ${lib.escapeShellArg cfg.agentgraph.environmentFile}
      set +a
      exec pi "$@"
    '';
  };
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

    agentgraph = {
      environmentFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = lib.literalExpression ''config.sops.templates."agentgraph-litellm.env".path'';
        description = ''
          Optional runtime environment file sourced by the AgentGraph Pi wrapper.
          Use this for SOPS-managed LLM provider variables such as
          LITELLM_BASE_URL, LITELLM_API_KEY, and AG_LITELLM_DEFAULT_MODEL.
        '';
      };

      wrapperName = lib.mkOption {
        type = lib.types.str;
        default = "pi";
        description = "Name of the Pi wrapper that sources services.pi-harness.agentgraph.environmentFile.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages =
      if cfg.agentgraph.environmentFile == null then
        [ cfg.package ]
      else
        [ agentgraphWrapper ];
  };
}
