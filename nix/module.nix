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
  defaultDiagramPackages = with pkgs; [ graphviz d2 xdg-utils ];
  engineeringRuntimePath = cfg.package.engineeringRuntimePath or (lib.makeBinPath (pkgs.callPackage ./engineering-runtime.nix { }));
  engineeringRuntimeEnvironment = ''
    export PI_HARNESS_ENGINEERING_RUNTIME_PATH="${engineeringRuntimePath}"
    export PATH="''${PATH:+$PATH:}${engineeringRuntimePath}"
  '';
  fallbackRuntimePackages = [ cfg.package pkgs.bash pkgs.which ]
    ++ lib.optionals cfg.lsp.enable cfg.lsp.packages
    ++ lib.optionals cfg.diagrams.enable cfg.diagrams.packages
    ++ lib.optionals (cfg.playwright.enable && cfg.playwright.package != null) [ cfg.playwright.package ];
  bridge = import ./matrix-bridge-service.nix {
    inherit lib pkgs pinRuntime;
    cfg = cfg.matrixBridge;
    harnessPackage = cfg.package;
    nativeLauncher = nativePiWithRuntime;
    sessionDirectory = cfg.sessionDirectory;
    hostName = config.networking.hostName or "host";
  };
  fragments = import ./launcher-fragments.nix { inherit lib; };
  runtimeEnvironmentFiles = lib.filter (path: path != null) (lib.optional cfg.experiments.agentgraph.enable cfg.agentgraph.environmentFile);
  experimentEnvironment = ''
    export PI_HARNESS_ENABLE_PI_R=${if cfg.experiments.piR.enable then "1" else "0"}
    export PI_HARNESS_ENABLE_AGENTGRAPH=${if cfg.experiments.agentgraph.enable then "1" else "0"}
  '';
  runtimeEnvironmentSetup = lib.optionalString (runtimeEnvironmentFiles != [ ]) ''
    set -a
    ${lib.concatMapStringsSep "\n" (path: ''
      # shellcheck disable=SC1090
      . ${lib.escapeShellArg path}
    '') runtimeEnvironmentFiles}
    set +a
  '';
  sessionDirectoryEnvironment = lib.optionalString (cfg.sessionDirectory != null) ''
    export PI_CODING_AGENT_SESSION_DIR=${lib.escapeShellArg cfg.sessionDirectory}
  '';
  lspExtensionArray = if cfg.lsp.enable then
    ''extension_args=(--extension "${cfg.lsp.extension}/share/pi-lsp-extension/src/index.ts")''
    else "extension_args=()";
  lspEnabledEnvironment = ''export PI_HARNESS_LSP_ENABLED=${if cfg.lsp.enable then "1" else "0"}'';
  lspFallbackEnvironment = lib.optionalString cfg.lsp.enable ''
    export PI_HARNESS_LSP_FALLBACK_PATH="${lib.makeBinPath cfg.lsp.packages}"
  '';
  lspDisabledCleanup = lib.optionalString (!cfg.lsp.enable) fragments.lspCleanup;
  pinRuntime = lib.optionalString (cfg.matrixBridge.enable && cfg.matrixBridge.retainRuntime) ''
    launcher="$(${pkgs.coreutils}/bin/readlink -f "$0")"
    if [[ "''${PI_HARNESS_PINNED_LAUNCHER:-}" != "$launcher" ]]; then
      export PI_RUNTIME_NIX_STORE=${pkgs.nix}/bin/nix-store
      exec ${pkgs.python3}/bin/python3 ${../scripts/pin-runtime.py} "$launcher" "$@"
    fi
    unset PI_HARNESS_PINNED_LAUNCHER PI_RUNTIME_NIX_STORE
  '';
  nativePiWithRuntime = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail
    ${pinRuntime}
    ${experimentEnvironment}
    ${runtimeEnvironmentSetup}
    ${sessionDirectoryEnvironment}
    # Old environment names are discarded, never used to select another runtime.
    for key in "''${!PI_MANAGED_@}"; do unset "$key"; done
    if [[ "''${PI_HARNESS_LOCAL_ONLY:-0}" == 1 ]]; then
      for key in "''${!PI_MATRIX_@}" "''${!PI_BRIDGE_CHAT_@}"; do unset "$key"; done
      unset PI_HARNESS_AGENT_PROFILE
    fi
    ${bridge.environment}
    ${lib.optionalString (!(cfg.package ? engineeringRuntimePath)) engineeringRuntimeEnvironment}
    export PATH="$PATH":${lib.makeBinPath fallbackRuntimePackages}
    ${lspEnabledEnvironment}
    ${lspFallbackEnvironment}
    ${lspDisabledCleanup}
    ${lspExtensionArray}
    exec ${cfg.package}/bin/pi "''${extension_args[@]}" "$@"
  '';
  localOnlyPi = pkgs.writeShellScriptBin "pi-local-only" ''
    unset MATRIX_ACCESS_TOKEN MATRIX_OPERATOR_TOKEN CREDENTIALS_DIRECTORY
    export PI_HARNESS_LOCAL_ONLY=1
    export PI_BRIDGE_LOCAL_ONLY=1
    exec ${nativePiWithRuntime}/bin/pi "$@"
  '';
  headlessAloop = pkgs.writeShellScriptBin "pi-aloop" ''
    export PI_ALOOP_LAUNCHER=${nativePiWithRuntime}/bin/pi
    exec ${cfg.package}/bin/pi-aloop "$@"
  '';
in
{
  imports = [ ./bridge-chat-preflight.nix ./bridge-chat.nix ./chat-workspace.nix ];

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
    sessionDirectory = lib.mkOption {
      type = lib.types.nullOr lib.types.nonEmptyStr;
      default = null;
      example = "/home/operator/.local/state/syncthing/pi/sessions";
      description = ''
        Optional Pi session storage directory exported by the installed pi
        wrapper as PI_CODING_AGENT_SESSION_DIR. This applies immediately after
        activation without requiring a new login session.
      '';
    };
    experiments = {
      piR.enable = lib.mkEnableOption "Pi-R resources in ordinary engineering launches";
      agentgraph.enable = lib.mkEnableOption "AgentGraph resources in ordinary engineering launches";
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
    matrixBridge = bridge.options;
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
    ] ++ bridge.assertions;
    users.users = lib.optionalAttrs (cfg.matrixBridge.enable && cfg.matrixBridge.user != null) {
      ${cfg.matrixBridge.user}.linger = true;
    };
    systemd.user.services.pi-matrix-bridge = lib.mkIf cfg.matrixBridge.enable bridge.service;
    environment.systemPackages = [ nativePiWithRuntime localOnlyPi ]
      ++ lib.optional (cfg.matrixBridge.package != null) bridge.helper
      ++ lib.optional (cfg.package.hasAloopDriver or false) headlessAloop;
  };
}
