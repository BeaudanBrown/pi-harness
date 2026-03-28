{
  description = "pi-harness workspace (skeleton)";

    inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        packages.default = pkgs.writeShellApplication {
          name = "pi-harness";
          runtimeInputs = [ pkgs.bash ];
          text = ''
            if ! command -v pi >/dev/null 2>&1; then
              echo "pi executable not found in PATH" >&2
              exit 1
            fi
            exec pi "$@"
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
