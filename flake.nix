{
  description = "pi-harness workspace (skeleton)";

    inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix-ai-tools = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, flake-utils, nix-ai-tools, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        piCommand = pkgs.lib.getExe nix-ai-tools.packages.${system}.pi;
      in
      {
        packages.default = pkgs.writeShellApplication {
          name = "pi-harness";
          runtimeInputs = [ pkgs.bash ];
          text = ''
            exec ${pkgs.lib.escapeShellArg piCommand} "$@"
          '';
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.bash pkgs.nodejs ];
          shellHook = ''
            echo "pi-harness shell"
          '';
        };
      }
    )
    // {
      nixosModules.default = import ./nix/module.nix;
      nixosModules.pi-harness = import ./nix/module.nix;
    };
}
