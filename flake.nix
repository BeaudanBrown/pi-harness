{
  description = "Thin Pi configuration harness for NixOS hosts";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix-ai-tools = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      nix-ai-tools,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        piPackage = nix-ai-tools.packages.${system}.pi;
        piHarnessPackage = pkgs.callPackage ./nix/package.nix {
          inherit piPackage;
        };
        verifyApp = pkgs.writeShellApplication {
          name = "verify";
          runtimeInputs = [
            pkgs.coreutils
            pkgs.jq
          ];
          text = ''
            set -euo pipefail
            test -f config/agent/settings.json
            jq empty config/agent/settings.json
            test -d config/agent/extensions
            test -d config/agent/skills
            test -d config/agent/prompts
            test -d config/agent/themes
          '';
        };
      in
      {
        packages.pi-harness = piHarnessPackage;
        packages.pi = piPackage;
        packages.default = piHarnessPackage;

        apps.verify = flake-utils.lib.mkApp { drv = verifyApp; };
        apps.default = flake-utils.lib.mkApp { drv = piPackage; };
        apps.pi = flake-utils.lib.mkApp { drv = piPackage; };

        devShells.default = pkgs.mkShell {
          packages = [
            piPackage
            pkgs.jq
            pkgs.tmux
          ];
        };
      }
    )
    // {
      nixosModules.default = import ./nix/module.nix;
      nixosModules.pi-harness = import ./nix/module.nix;
    };
}
