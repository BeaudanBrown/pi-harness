{
  description = "pi-harness workspace";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix-ai-tools = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, flake-utils, nix-ai-tools, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib = pkgs.lib;
        piHarnessPackage = pkgs.callPackage ./nix/package.nix { };
        lintBody = ''
          set -euo pipefail

          repo_root="$(git rev-parse --show-toplevel)"
          cd "''${repo_root}"

          git diff --check

          if [ ! -f go.mod ]; then
            echo "lint: no go.mod yet; skipping Go-specific checks"
            exit 0
          fi

          mapfile -t go_files < <(
            find . -type f -name '*.go' \
              -not -path './.git/*' \
              -not -path './vendor/*' \
              | sort
          )

          if [ "''${#go_files[@]}" -eq 0 ]; then
            echo "lint: go.mod exists but no Go files were found"
            exit 0
          fi

          unformatted="$(gofmt -l "''${go_files[@]}")"
          if [ -n "''${unformatted}" ]; then
            echo "gofmt needs to run on:" >&2
            printf '%s\n' "''${unformatted}" >&2
            exit 1
          fi

          go vet ./...
          staticcheck ./...
        '';
        testBody = ''
          set -euo pipefail

          repo_root="$(git rev-parse --show-toplevel)"
          cd "''${repo_root}"

          if [ ! -f go.mod ]; then
            echo "test: no go.mod yet; skipping Go tests"
            exit 0
          fi

          go test ./...
          node --test ./.pi/extensions/pi-harness-runtime/runtime-status.test.mjs
        '';
        lintApp = pkgs.writeShellApplication {
          name = "lint";
          runtimeInputs = [
            pkgs.bash
            pkgs.coreutils
            pkgs.findutils
            pkgs.git
            pkgs.go
            pkgs.go-tools
            pkgs.gnugrep
          ];
          text = lintBody;
        };
        testApp = pkgs.writeShellApplication {
          name = "test";
          runtimeInputs = [
            pkgs.bash
            pkgs.coreutils
            pkgs.git
            pkgs.go
            pkgs.nodejs
          ];
          text = testBody;
        };
        verifyApp = pkgs.writeShellApplication {
          name = "verify";
          runtimeInputs = [ lintApp testApp ];
          text = ''
            set -euo pipefail
            ${lib.getExe lintApp}
            ${lib.getExe testApp}
          '';
        };
      in
      {
        packages.pi-harness = piHarnessPackage;
        packages.default = piHarnessPackage;

        apps.lint = flake-utils.lib.mkApp { drv = lintApp; };
        apps.test = flake-utils.lib.mkApp { drv = testApp; };
        apps.verify = flake-utils.lib.mkApp { drv = verifyApp; };
        apps.default = flake-utils.lib.mkApp { drv = piHarnessPackage; };
        apps.pi-harness = flake-utils.lib.mkApp { drv = piHarnessPackage; };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bash
            pkgs.fzf
            pkgs.go
            pkgs.go-tools
            pkgs.gopls
            pkgs.jq
            pkgs.just
            pkgs.nodejs
            pkgs.tmux
          ];
          shellHook = ''
            echo "pi-harness shell"
            echo "quality gate: nix run .#verify"
          '';
        };
      }
    )
    // {
      nixosModules.default = import ./nix/module.nix;
      nixosModules.pi-harness = import ./nix/module.nix;
    };
}
