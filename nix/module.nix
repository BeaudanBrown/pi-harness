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

  defaultDiagramPackages = with pkgs; [
    graphviz
    d2
    xdg-utils
  ];

  fallbackRuntimePackages = [
    cfg.package
  ]
  ++ lib.optionals cfg.lsp.enable cfg.lsp.packages
  ++ lib.optionals cfg.diagrams.enable cfg.diagrams.packages
  ++ lib.optionals (cfg.playwright.enable && cfg.playwright.package != null) [
    cfg.playwright.package
  ];
  runtimeFeaturesEnabled = cfg.lsp.enable || cfg.diagrams.enable || cfg.playwright.enable;
  remoteSessionEnabled = cfg.remoteSession.environmentFile != null;
  nonNullString = value: if value == null then "" else value;
  runtimeEnvironmentFiles = lib.filter (path: path != null) [
    cfg.agentgraph.environmentFile
    cfg.remoteSession.environmentFile
  ];
  runtimeEnvironmentSetup = lib.optionalString (runtimeEnvironmentFiles != [ ]) ''
    set -a
    ${lib.concatMapStringsSep "\n" (path: ''
      # shellcheck disable=SC1090
      . ${lib.escapeShellArg path}
    '') runtimeEnvironmentFiles}
    set +a
  '';
  remoteSessionEnvironment = lib.optionalString remoteSessionEnabled ''
    export PI_MATRIX_HOMESERVER=${lib.escapeShellArg (nonNullString cfg.remoteSession.homeserver)}
    export PI_MATRIX_BOT_USER_ID=${lib.escapeShellArg (nonNullString cfg.remoteSession.botUserId)}
    export PI_MATRIX_OPERATOR_USER_ID=${lib.escapeShellArg (nonNullString cfg.remoteSession.operatorUserId)}
    export PI_MATRIX_HOSTNAME=${lib.escapeShellArg (nonNullString cfg.remoteSession.hostName)}
  '';
  lspExtensionArray =
    if cfg.lsp.enable then
      ''extension_args=(--extension "${cfg.lsp.extension}/share/pi-lsp-extension/src/index.ts")''
    else
      "extension_args=()";

  piWithRuntime = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail
    ${runtimeEnvironmentSetup}
    ${remoteSessionEnvironment}
    export PATH="$PATH":${lib.makeBinPath fallbackRuntimePackages}
    ${lspExtensionArray}
    exec ${cfg.package}/bin/pi "''${extension_args[@]}" "$@"
  '';

  matrixWhoami = pkgs.writeShellScriptBin "pi-matrix-whoami" ''
    set -euo pipefail
    ${runtimeEnvironmentSetup}
    ${remoteSessionEnvironment}
    exec ${cfg.package}/bin/pi-matrix-whoami "$@"
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

    remoteSession = {
      environmentFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = lib.literalExpression ''config.sops.secrets."pi/matrix-env".path'';
        description = ''
          Optional SOPS-managed environment file containing only
          PI_MATRIX_ACCESS_TOKEN. When set, the pi command and
          pi-matrix-whoami receive the Matrix remote-session configuration.
        '';
      };

      homeserver = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "https://matrix.example.com";
        description = "Matrix homeserver base URL for the host bot.";
      };

      botUserId = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "@pi-host:example.com";
        description = "Expected Matrix user ID for the host bot.";
      };

      operatorUserId = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "@operator:example.com";
        description = "Only Matrix user ID authorized to send remote input.";
      };

      hostName = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "workstation";
        description = "Literal host routing name used by the remote-session extension.";
      };
    };

    diagrams.enable = lib.mkEnableOption "diagram rendering tools for Pi";

    playwright.enable = lib.mkEnableOption "the harness Playwright Agent CLI browser fallback";

    playwright.package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = cfg.package.playwrightAgentCli or null;
      defaultText = lib.literalExpression "services.pi-harness.package.playwrightAgentCli";
      description = ''
        Nix-pinned Playwright Agent CLI and Chromium fallback exposed to Pi.
        Project adapters selected by pi-playwright take precedence over this package.
      '';
    };

    diagrams.packages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = defaultDiagramPackages;
      defaultText = lib.literalExpression "[ pkgs.graphviz pkgs.d2 pkgs.xdg-utils ]";
      description = ''
        Diagram CLI packages exposed on PATH for Pi architecture diagram tools.
        Project-local tools from dev shells take precedence because these are
        appended after the caller's PATH.
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
      {
        assertion = !cfg.playwright.enable || cfg.playwright.package != null;
        message = "services.pi-harness.playwright.enable requires a Playwright Agent CLI package.";
      }
      {
        assertion =
          !remoteSessionEnabled
          || lib.all (value: value != null && value != "") [
            cfg.remoteSession.homeserver
            cfg.remoteSession.botUserId
            cfg.remoteSession.operatorUserId
            cfg.remoteSession.hostName
          ];
        message = ''
          services.pi-harness.remoteSession.environmentFile requires homeserver,
          botUserId, operatorUserId, and hostName.
        '';
      }
    ];

    environment.systemPackages =
      (if runtimeEnvironmentFiles != [ ] || runtimeFeaturesEnabled then [ piWithRuntime ] else [ cfg.package ])
      ++ lib.optional remoteSessionEnabled matrixWhoami;
  };
}
