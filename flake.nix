{
  description = "Thin Pi configuration harness for NixOS hosts";

  nixConfig = {
    extra-substituters = [ "https://cache.numtide.com" ];
    extra-trusted-public-keys = [
      "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g="
    ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix-ai-tools = {
      url = "github:numtide/llm-agents.nix";
      inputs.bun2nix.url = "https://codeload.github.com/nix-community/bun2nix/tar.gz/2499dedd70744dba1815875b854818a3019e9e4c";
    };
    agentgraph = {
      url = "git+ssh://git@github.com/BeaudanBrown/agentgraph.git";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # pi-r owns a tested native parser/R runtime set; do not substitute the
    # harness Nixpkgs input because Tree-sitter CLI APIs differ across pins.
    pi-r.url = "github:BeaudanBrown/pi-r";
    pi-lsp-extension-src = {
      url = "github:samfoy/pi-lsp-extension/73251632ad116c973844cc28fb1210417295c6fe";
      flake = false;
    };
    mattpocock-skills-src = {
      url = "github:mattpocock/skills/391a2701dd948f94f56a39f7533f8eea9a859c87";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      nix-ai-tools,
      agentgraph,
      pi-r,
      pi-lsp-extension-src,
      mattpocock-skills-src,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (pkgs) lib;
        upstreamPiPackage = nix-ai-tools.packages.${system}.pi;
        nativeSessionLock = pkgs.callPackage ./nix/pi-session-lock.nix { };
        piPackage = upstreamPiPackage.overrideAttrs (old: {
          patches = (old.patches or [ ]) ++ [
            ./nix/patches/pi-prompt-expanded-hook.patch
            ./nix/patches/pi-native-session-lock.patch
          ];
          postPatch = (old.postPatch or "") + ''
            cp ${nativeSessionLock}/lib/session-lock.cjs dist/core/session-lock.cjs
          '';
          # Apply after npm dependencies exist, before Bun embeds the CLI modules.
          preInstall = ''
            patch -p1 < ${./nix/patches/pi-queued-message-removal.patch}
            patch -p1 < ${./nix/patches/pi-bridge-persistence.patch}
            patch -p1 < ${./nix/patches/pi-bridge-control-preflight.patch}
            patch -p1 < ${./nix/patches/pi-bridge-queued-preflight.patch}
          '' + (old.preInstall or "");
          postInstall = (old.postInstall or "") + ''
            sdk_root="$out/lib/node_modules/@earendil-works/pi-coding-agent"
            mkdir -p "$sdk_root"
            cp -R dist package.json "$sdk_root/"
            # The chat worker imports the real SDK, not only declaration files.
            # Keep its pinned dependency tree so ESM imports resolve without
            # ambient NODE_PATH, an engineering launcher, or another installation.
            cp -R node_modules "$sdk_root/"
          '';
        });
        agentgraphPackage = agentgraph.packages.${system}.ag-unchecked;
        agentgraphPostgresPackage = agentgraph.packages.${system}.agentgraph-postgres;
        agentgraphPiResources = agentgraph.packages.${system}.agentgraph-pi-resources;
        piRPackage = pi-r.packages.${system}.pi-r;
        harnessSourceRevision = self.rev or self.dirtyRev or self.narHash or "unversioned";
        piRSourceRevision = pi-r.rev or pi-r.dirtyRev or pi-r.narHash or "unversioned";
        piLspExtension = pkgs.callPackage ./nix/pi-lsp-extension.nix {
          piLspExtensionSrc = pi-lsp-extension-src;
        };
        piHarnessResources = pkgs.callPackage ./nix/pi-harness-resources.nix {
          inherit piPackage;
        };
        matrixBridge = pkgs.callPackage ./nix/matrix-bridge.nix {
          inherit piPackage nativeSessionLock;
        };
        mattPocockSkillsResources = pkgs.callPackage ./nix/mattpocock-skills-resources.nix {
          mattPocockSkillsSrc = mattpocock-skills-src;
        };
        ticketPackage = pkgs.callPackage ./nix/ticket.nix { };
        playwrightAgentCli = pkgs.callPackage ./nix/playwright-agent-cli.nix { };
        piHarnessPackage = pkgs.callPackage ./nix/package.nix {
          inherit
            piPackage
            piHarnessResources
            mattPocockSkillsResources
            agentgraphPackage
            agentgraphPostgresPackage
            agentgraphPiResources
            piRPackage
            piLspExtension
            matrixBridge
            playwrightAgentCli
            ;
          harnessRevision = harnessSourceRevision;
          piRRevision = piRSourceRevision;
          fzf = pkgs.fzf;
          tmux = pkgs.tmux;
          d2 = pkgs.d2;
          graphviz = pkgs.graphviz;
          xdgUtils = pkgs.xdg-utils;
          jq = pkgs.jq;
        };
        lspDisabledModuleTest = lib.evalModules {
          specialArgs = { inherit pkgs; };
          modules = [
            { options.systemd.tmpfiles.rules = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; }; }
            {
              options = {
                users.groups = lib.mkOption { type = lib.types.attrs; default = { }; };
                systemd.services = lib.mkOption { type = lib.types.attrs; default = { }; };
                assertions = lib.mkOption { type = lib.types.listOf lib.types.attrs; default = [ ]; };
                environment.systemPackages = lib.mkOption { type = lib.types.listOf lib.types.package; default = [ ]; };
                users.users = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
                systemd.user.services = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
              };
            }
            ./nix/module.nix
            { services.pi-harness = { enable = true; package = piHarnessPackage; lsp.enable = false; }; }
          ];
        };
        modulePackage = module: name: lib.findFirst (package: lib.getName package == name)
          (throw "Missing module executable ${name}") module.config.environment.systemPackages;
        lspDisabledPiWrapper = modulePackage lspDisabledModuleTest "pi";
        bridgeModuleTest = lspDisabledModuleTest.extendModules {
          modules = [ {
            services.pi-harness = {
              lsp.enable = lib.mkForce true;
              matrixBridge = {
                enable = true;
                retainRuntime = false; # The separate runtime-pin suite supplies a writable store double.
                user = "operator";
                hostId = "native-test";
                roots = [ "%h/projects" ];
                environmentFile = "/run/secrets/native-test.env";
                homeserver = "https://matrix.invalid";
                botUserId = "@host:matrix.invalid";
                operatorUserId = "@operator:matrix.invalid";
              };
            };
          } ];
        };
        bridgePiWrapper = modulePackage bridgeModuleTest "pi";
        bridgeLocalOnlyWrapper = modulePackage bridgeModuleTest "pi-local-only";
        bridgePinnedTest = bridgeModuleTest.extendModules {
          modules = [ { services.pi-harness.matrixBridge.retainRuntime = lib.mkForce true; } ];
        };
        bridgeModuleReport = pkgs.writeText "pi-harness-native-bridge-module-test.json" (builtins.toJSON {
          assertions = map (item: item.assertion) bridgeModuleTest.config.assertions;
          services = builtins.attrNames bridgeModuleTest.config.systemd.user.services;
          service = bridgeModuleTest.config.systemd.user.services.pi-matrix-bridge;
          userLingers = bridgeModuleTest.config.users.users.operator.linger;
          helper = "${modulePackage bridgeModuleTest "pi-session"}/bin/pi-session";
          offlineHelper = "${modulePackage lspDisabledModuleTest "pi-session"}/bin/pi-session";
          nativeScript = bridgePiWrapper.text;
          pinnedScript = (modulePackage bridgePinnedTest "pi").text;
          disabledHasNoBridge = !(lspDisabledModuleTest.config.systemd.user.services ? pi-matrix-bridge);
          legacyOptionAbsent = !(bridgeModuleTest.options.services.pi-harness ? managedSessions);
          legacyOptionRejected = !(builtins.tryEval (builtins.deepSeq
            (bridgeModuleTest.extendModules { modules = [ { services.pi-harness.managedSessions.enable = true; } ]; }).config.environment.systemPackages true)).success;
        });
        lspPackages = with pkgs; [
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
        matrixMarkdown = pkgs.callPackage ./nix/matrix-markdown.nix { };
        typeSetup = ''
          types_root=.pi-types/node_modules
          mkdir -p "$types_root/@earendil-works" "$types_root/@types"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent "$types_root/@earendil-works/pi-coding-agent"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core "$types_root/@earendil-works/pi-agent-core"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai "$types_root/@earendil-works/pi-ai"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui "$types_root/@earendil-works/pi-tui"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@types/node "$types_root/@types/node"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox "$types_root/typebox"
          ln -sfn ${matrixMarkdown}/lib/node_modules/@types/markdown-it "$types_root/@types/markdown-it"
          ln -sfn ${matrixMarkdown}/lib/node_modules/@types/linkify-it "$types_root/@types/linkify-it"
          ln -sfn ${matrixMarkdown}/lib/node_modules/@types/mdurl "$types_root/@types/mdurl"
        '';
        evalTooling = pkgs.runCommand "pi-harness-eval-tooling" {
          nativeBuildInputs = [ pkgs.typescript ];
        } ''
          mkdir -p source/tests source/tests/fixtures "$out/lib" "$out/bin" "$out/share/pi-harness-eval-self-test"
          cp -r ${./eval} source/eval
          cp ${./tests}/eval-*.test.ts source/tests/
          cp -r ${./tests/fixtures/eval-rpc} source/tests/fixtures/eval-rpc
          cp -r ${./tests/fixtures/eval-traces} source/tests/fixtures/eval-traces
          cat > tsconfig.json <<EOF
          {
            "compilerOptions": {
              "target": "ES2022",
              "module": "NodeNext",
              "moduleResolution": "NodeNext",
              "strict": true,
              "skipLibCheck": true,
              "types": ["node"],
              "typeRoots": ["${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@types"],
              "rootDir": "source",
              "outDir": "$out/lib"
            },
            "include": ["source/eval/**/*.ts", "source/tests/**/*.ts"]
          }
          EOF
          tsc --project tsconfig.json
          cp -r source/eval "$out/share/pi-harness-eval-self-test/eval"
          cp -r source/tests "$out/share/pi-harness-eval-self-test/tests"
          cat > "$out/bin/pi-eval" <<EOF
          #!${pkgs.runtimeShell}
          exec ${lib.getExe pkgs.nodejs} "$out/lib/eval/cli/main.js" "\$@"
          EOF
          chmod +x "$out/bin/pi-eval"
        '';
        evalApp = pkgs.writeShellApplication {
          name = "pi-eval";
          runtimeInputs = [ pkgs.git pkgs.nodejs ] ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.bubblewrap ];
          text = ''
            set -euo pipefail
            export PI_EVAL_LAUNCHER_IDENTITY=${piHarnessPackage}/share/pi-harness/eval/launcher-identity.json
            export PI_EVAL_EXPECTED_PI_VERSION=${lib.escapeShellArg piPackage.version}
            export PI_EVAL_EXPECTED_HARNESS_REVISION=${lib.escapeShellArg harnessSourceRevision}
            export PI_EVAL_EXPECTED_LAUNCHER_ID=pi-r-local
            export PI_EVAL_EXPECTED_LAUNCHER_PATH=${piHarnessPackage}/bin/pi-r-local
            export PI_EVAL_EXPECTED_PI_R_REVISION=${lib.escapeShellArg piRSourceRevision}
            export PI_EVAL_EXPECTED_PI_R_ROOT=${piRPackage.resourcePaths.root}
            export PI_EVAL_EXPECTED_PI_R_EXTENSION=${piRPackage.resourcePaths.extension}
            export PI_EVAL_EXPECTED_PI_R_SKILL=${piRPackage.resourcePaths.skill}
            exec ${evalTooling}/bin/pi-eval "$@"
          '';
        };
        evalSelfTestApp = pkgs.writeShellApplication {
          name = "pi-eval-self-test";
          runtimeInputs = [ pkgs.bash pkgs.coreutils pkgs.git pkgs.nodejs ] ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.bubblewrap ];
          text = ''
            set -euo pipefail
            home=$(mktemp -d)
            trap 'rm -rf "$home"' EXIT
            work="$home/work"
            cp -R --no-preserve=mode ${evalTooling}/share/pi-harness-eval-self-test "$work"
            chmod -R u+w "$work"
            cd "$work"
            env -i \
              HOME="$home" \
              TMPDIR="''${TMPDIR:-/tmp}" \
              PATH="$PATH" \
              PI_TEST_SHELL=${lib.getExe pkgs.bash} \
              ${lib.optionalString pkgs.stdenv.isLinux "PI_EVAL_BWRAP=${lib.getExe pkgs.bubblewrap} \\"}
              ${lib.getExe pkgs.nodejs} --test --test-concurrency=1 \
                ${evalTooling}/lib/tests/eval-*.test.js
          '';
        };
        migrateTkApp = pkgs.writeShellApplication {
          name = "pi-migrate-tk";
          runtimeInputs = [ ticketPackage pkgs.gh ];
          text = ''
            set -euo pipefail
            if [ ! -d .tickets ]; then
              echo "pi-migrate-tk: no .tickets directory in the current project; run this from a tk-backed repository." >&2
              exit 1
            fi
            if ! gh auth status >/dev/null 2>&1; then
              echo "pi-migrate-tk: GitHub CLI authentication is required; run gh auth login first." >&2
              exit 1
            fi
            export PI_HARNESS_TK_MIGRATION=1
            exec ${piHarnessPackage}/bin/pi \
              --skill "${piHarnessResources}/share/pi-harness/agent/migration-skills/migrate-tk-to-github" "$@"
          '';
        };
        verification = import ./nix/verification.nix {
          inherit pkgs lib piPackage nativeSessionLock matrixBridge bridgePiWrapper bridgeLocalOnlyWrapper bridgeModuleReport
            piHarnessPackage piHarnessResources piRPackage agentgraphPiResources lspDisabledPiWrapper
            mattPocockSkillsResources migrateTkApp playwrightAgentCli piLspExtension typeSetup lspPackages;
          source = ./.;
        };
        verifyApp = verification.verifyApp;
        verifyLspLiveApp = verification.verifyLspLiveApp;
      in
      {
        packages.pi-harness = piHarnessPackage;
        packages.pi-harness-resources = piHarnessResources;
        packages.matrix-bridge = matrixBridge;
        packages.bridge-chat = import ./nix/bridge-chat-package.nix { inherit pkgs piPackage; };
        packages.chat-workspace = import ./nix/chat-workspace-package.nix { inherit pkgs; };
        packages.chat-files = import ./nix/chat-files-package.nix { inherit pkgs; };
        packages.mattpocock-skills-resources = mattPocockSkillsResources;
        packages.pi-lsp-extension = piLspExtension;
        packages.playwright-agent-cli = playwrightAgentCli;
        packages.migrate-tk = migrateTkApp;
        packages.pi = piPackage;
        packages.default = piHarnessPackage;
        checks = verification.checks;
        apps.migrate-tk = flake-utils.lib.mkApp { drv = migrateTkApp; };
        apps.eval = flake-utils.lib.mkApp { drv = evalApp; };
        apps.eval-self-test = flake-utils.lib.mkApp { drv = evalSelfTestApp; };
        apps.verify = flake-utils.lib.mkApp { drv = verifyApp; };
        apps.verify-lsp-live = flake-utils.lib.mkApp { drv = verifyLspLiveApp; };
        apps.verify-chat-workspace-live = flake-utils.lib.mkApp { drv = verification.verifyWorkspaceLiveApp; };
        apps.verify-chat-files-live = flake-utils.lib.mkApp { drv = verification.verifyFilesLiveApp; };
        apps.default = flake-utils.lib.mkApp { drv = piHarnessPackage; exePath = "/bin/pi"; };
        apps.pi = flake-utils.lib.mkApp { drv = piHarnessPackage; exePath = "/bin/pi"; };
        devShells.default = pkgs.mkShell {
          packages = [
            agentgraphPackage agentgraphPostgresPackage playwrightAgentCli
            pkgs.jq pkgs.tmux pkgs.d2 pkgs.graphviz pkgs.xdg-utils
          ] ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.bubblewrap ] ++ lspPackages;
          shellHook = ''
            ${typeSetup}
          '';
        };
      }
    )
    // {
      nixosModules.default = import ./nix/module.nix;
      nixosModules.pi-harness = import ./nix/module.nix;
    };
}
