{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.services.pi-harness;

  defaultLspPackages = with pkgs; [
    nodejs
    nil
    nixd
    typescript-language-server
    typescript
    pyright
    ruff
    rust-analyzer
    ocamlPackages.ocaml-lsp
    gopls
    jdt-language-server
    clang-tools
    lua-language-server
    marksman
    taplo
    yaml-language-server
    vscode-langservers-extracted
    bash-language-server
    dockerfile-language-server
    terraform-ls
    tailwindcss-language-server
  ];

  fallbackRuntimePackages = [ cfg.package ] ++ lib.optionals cfg.lsp.enable cfg.lsp.packages;
  lspExtensionArray =
    if cfg.lsp.enable then
      ''extension_args=(--extension "${cfg.lsp.extension}/share/pi-lsp-extension/src/index.ts")''
    else
      ''extension_args=()'';

  piWithAgentGraphEnv = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail
    set -a
    # shellcheck disable=SC1090,SC1091
    . ${lib.escapeShellArg cfg.agentgraph.environmentFile}
    set +a
    export PATH="$PATH":${lib.makeBinPath fallbackRuntimePackages}
    ${lspExtensionArray}
    exec ${cfg.package}/bin/pi "''${extension_args[@]}" "$@"
  '';

  piWithRuntimePath = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail
    export PATH="$PATH":${lib.makeBinPath fallbackRuntimePackages}
    ${lspExtensionArray}
    exec ${cfg.package}/bin/pi "''${extension_args[@]}" "$@"
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

    lsp.enable = lib.mkEnableOption "Language Server Protocol tools for Pi";

    lsp.packages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = defaultLspPackages;
      defaultText = lib.literalExpression "a broad set of common language servers";
      description = ''
        Language server packages exposed on PATH for Pi extensions such as
        pi-lsp-extension. These packages are appended after the caller's PATH so
        project-local language servers from dev shells take precedence.
      '';
    };

    lsp.extension = lib.mkOption {
      type = lib.types.package;
      default = cfg.package.piLspExtension;
      defaultText = lib.literalExpression "services.pi-harness.package.piLspExtension";
      description = "Nix-packaged pi-lsp-extension loaded with --extension.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.lsp.enable || cfg.lsp.extension != null;
        message = "services.pi-harness.lsp.enable requires a pi-lsp-extension package.";
      }
    ];

    environment.systemPackages =
      if cfg.agentgraph.environmentFile == null && cfg.lsp.enable then
        [ piWithRuntimePath ]
      else if cfg.agentgraph.environmentFile == null then
        [ cfg.package ]
      else
        [ piWithAgentGraphEnv ];
  };
}
