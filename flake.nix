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
        piPackage = upstreamPiPackage.overrideAttrs (old: {
          patches = (old.patches or [ ]) ++ [ ./nix/patches/pi-extension-expanded-input.patch ];
        });
        agentgraphPackage = agentgraph.packages.${system}.ag-unchecked;
        agentgraphPostgresPackage = agentgraph.packages.${system}.agentgraph-postgres;
        agentgraphPiResources = agentgraph.packages.${system}.agentgraph-pi-resources;
        piRPackage = pi-r.packages.${system}.pi-r;
        piLspExtension = pkgs.callPackage ./nix/pi-lsp-extension.nix {
          piLspExtensionSrc = pi-lsp-extension-src;
        };
        piHarnessResources = pkgs.callPackage ./nix/pi-harness-resources.nix {
          inherit piPackage;
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
            playwrightAgentCli
            ;
          harnessRevision = self.rev or self.dirtyRev or self.narHash or "unversioned";
          piRRevision = pi-r.rev or pi-r.dirtyRev or pi-r.narHash or "unversioned";
          fzf = pkgs.fzf;
          tmux = pkgs.tmux;
          d2 = pkgs.d2;
          graphviz = pkgs.graphviz;
          xdgUtils = pkgs.xdg-utils;
          jq = pkgs.jq;
        };
        remoteSessionModuleTest = lib.evalModules {
          specialArgs = { inherit pkgs; };
          modules = [
            {
              options = {
                assertions = lib.mkOption {
                  type = lib.types.listOf lib.types.attrs;
                  default = [ ];
                };
                environment.systemPackages = lib.mkOption {
                  type = lib.types.listOf lib.types.package;
                  default = [ ];
                };
              };
            }
            ./nix/module.nix
            {
              services.pi-harness = {
                enable = true;
                package = piHarnessPackage;
                sessionDirectory = "/home/operator/.local/state/syncthing/pi/sessions";
                remoteSession = {
                  environmentFile = "/run/secrets/pi/matrix-test-env";
                  homeserver = "https://matrix.example.com";
                  botUserId = "@pi-test:example.com";
                  operatorUserId = "@operator:example.com";
                  hostName = "test-host";
                };
              };
            }
          ];
        };
        remoteSessionModulePackages = remoteSessionModuleTest.config.environment.systemPackages;
        remoteSessionPiWrapper = builtins.elemAt remoteSessionModulePackages 0;
        remoteSessionWhoamiWrapper = builtins.elemAt remoteSessionModulePackages 1;
        remoteSessionModuleReport = pkgs.writeText "pi-harness-remote-session-module-test.json" (
          builtins.toJSON {
            assertions = map (item: item.assertion) remoteSessionModuleTest.config.assertions;
            packageCount = builtins.length remoteSessionModulePackages;
          }
        );
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
        piDevWrapper = pkgs.writeShellApplication {
          name = "pi";
          text = ''
            case "''${1-}" in
              install|remove|uninstall|update|list|config)
                exec ${lib.getExe piPackage} "$@"
                ;;
              *)
                exec ${lib.getExe piPackage} \
                  --extension "$PWD/config/agent/extensions/web-search/index.ts" \
                  --extension "$PWD/config/agent/extensions/github-issues/index.ts" \
                  --extension "$PWD/config/agent/extensions/diagram-tools/index.ts" \
                  --extension "$PWD/config/agent/extensions/worker-runner/index.ts" \
                  --extension "$PWD/config/agent/extensions/review-agents/index.ts" \
                  --extension "$PWD/config/agent/extensions/remote-session/index.ts" \
                  --extension "$PWD/config/agent/extensions/nix-runtime/index.ts" \
                  --extension "$PWD/config/agent/extensions/codex-fast/index.ts" \
                  --extension "$PWD/config/agent/extensions/tmux-cursor-focus/index.ts" \
                  --extension "$PWD/config/agent/extensions/sesh/index.ts" \
                  --extension "${agentgraphPiResources}/share/agentgraph-pi/extensions/agentgraph/index.ts" \
                  --extension "${piLspExtension}/share/pi-lsp-extension/src/index.ts" \
                  --skill "$PWD/config/agent/skills" \
                  --skill "${mattPocockSkillsResources}/share/pi-harness/mattpocock-skills" \
                  --skill "${agentgraphPiResources}/share/agentgraph-pi/skills" \
                  --prompt-template "$PWD/config/agent/prompts" \
                  --prompt-template "${agentgraphPiResources}/share/agentgraph-pi/prompts" \
                  --theme "$PWD/config/agent/themes" \
                  "$@"
                ;;
            esac
          '';
        };
        typeSetup = ''
          types_root=.pi-types/node_modules
          mkdir -p "$types_root/@earendil-works" "$types_root/@types"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent "$types_root/@earendil-works/pi-coding-agent"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core "$types_root/@earendil-works/pi-agent-core"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai "$types_root/@earendil-works/pi-ai"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui "$types_root/@earendil-works/pi-tui"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@types/node "$types_root/@types/node"
          ln -sfn ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox "$types_root/typebox"
        '';
        migrateTkApp = pkgs.writeShellApplication {
          name = "pi-migrate-tk";
          runtimeInputs = [
            ticketPackage
            pkgs.gh
          ];
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
            exec ${piHarnessPackage}/bin/pi "$@"
          '';
        };
        verifyApp = pkgs.writeShellApplication {
          name = "verify";
          runtimeInputs = [
            pkgs.check-jsonschema
            pkgs.coreutils
            pkgs.git
            pkgs.jq
            pkgs.nodejs
            pkgs.typescript
          ] ++ lib.optionals pkgs.stdenv.isLinux [
            pkgs.bubblewrap
          ];
          text = ''
            set -euo pipefail
            test -f config/agent/settings.json
            jq empty config/agent/settings.json
            test -f docs/architecture/decisions/0001-synthetic-evaluation-contracts.md
            test -f eval/contracts/path-policy.ts
            test -f eval/rpc/engine.ts
            test -f eval/rpc/README.md
            test -f eval/workspace/materialize.ts
            test -f eval/workspace/README.md
            test -f eval/trace/capture.ts
            test -f eval/trace/README.md
            test -f eval/grading/grade.ts
            test -f eval/grading/README.md
            if grep -R -F 'node:readline' eval/rpc; then
              echo "eval RPC engine must use strict LF framing, not Node readline" >&2
              exit 1
            fi
            test -f tests/fixtures/eval-rpc/fake-rpc.mjs
            schema_root=eval/contracts/schemas/v1
            fixture_root=../../fixtures
            (
              cd "$schema_root"
              for schema in *.schema.json; do
                check-jsonschema --check-metaschema "$schema"
              done
              check-jsonschema --schemafile pack.schema.json "$fixture_root/valid/pack.json"
              check-jsonschema --schemafile scenario.schema.json "$fixture_root/valid/scenarios/sensor-smoke.json"
              check-jsonschema --schemafile scenario.schema.json "$fixture_root/valid/scenarios/ui-policy-v1.json"
              check-jsonschema --schemafile synthetic-provenance.schema.json "$fixture_root/valid/provenance.json"
              check-jsonschema --schemafile metrics.schema.json "$fixture_root/valid/metrics.json"
              check-jsonschema --schemafile run-result.schema.json "$fixture_root/valid/run-result.json"
              check-jsonschema --schemafile comparison.schema.json "$fixture_root/valid/baselines/reviewed-summary.json"
              for fixture in pack-traversal pack-absolute pack-external-uri pack-nul-path pack-trailing-slash; do
                if check-jsonschema --schemafile pack.schema.json "$fixture_root/invalid/$fixture.json"; then
                  echo "invalid eval pack fixture passed validation: $fixture" >&2
                  exit 1
                fi
              done
              for fixture in pack-duplicate-suite-id pack-unknown-scenario; do
                check-jsonschema --schemafile pack.schema.json "$fixture_root/invalid/$fixture.json"
              done
              for fixture in scenario-generator-missing-outputs scenario-missing-provenance scenario-not-synthetic; do
                if check-jsonschema --schemafile scenario.schema.json "$fixture_root/invalid/$fixture.json"; then
                  echo "invalid synthetic scenario fixture passed validation: $fixture" >&2
                  exit 1
                fi
              done
              for fixture in provenance-extra-property provenance-missing-synthetic provenance-not-synthetic; do
                if check-jsonschema --schemafile synthetic-provenance.schema.json "$fixture_root/invalid/$fixture.json"; then
                  echo "invalid synthetic provenance fixture passed validation: $fixture" >&2
                  exit 1
                fi
              done
              for fixture in \
                assertion-file-missing-expected \
                assertion-final-text-missing-condition \
                assertion-git-missing-condition \
                assertion-oracle-missing-target \
                assertion-ui-missing-condition; do
                if check-jsonschema --schemafile assertion.schema.json "$fixture_root/invalid/$fixture.json"; then
                  echo "incomplete assertion fixture passed validation: $fixture" >&2
                  exit 1
                fi
              done
              (
                cd ../v2
                for schema in *.schema.json; do
                  check-jsonschema --check-metaschema "$schema"
                done
                check-jsonschema --schemafile scenario.schema.json "$fixture_root/valid/scenarios/sensor-smoke-v2.json"
                check-jsonschema --schemafile scenario.schema.json "$fixture_root/invalid/scenario-duplicate-ui-dialog.json"
                if check-jsonschema --schemafile scenario.schema.json "$fixture_root/invalid/scenario-unsupported-version.json"; then
                  echo "unsupported scenario version passed v2 validation" >&2
                  exit 1
                fi
                if check-jsonschema --schemafile ui-policy.schema.json "$fixture_root/invalid/ui-policy-response-mismatch.json"; then
                  echo "method-incompatible UI response fixture passed v2 validation" >&2
                  exit 1
                fi
              )
              (
                cd ../v3
                for schema in *.schema.json; do
                  check-jsonschema --check-metaschema "$schema"
                done
                check-jsonschema --schemafile scenario.schema.json "$fixture_root/valid/scenarios/sensor-smoke-v3.json"
              )
            )
            test -d config/agent/extensions
            test -f config/agent/extensions/web-search/index.ts
            test -f config/agent/extensions/github-issues/index.ts
            test -f config/agent/extensions/diagram-tools/index.ts
            test -f config/agent/extensions/worker-runner/index.ts
            test -f config/agent/extensions/review-agents/index.ts
            test -f config/agent/extensions/remote-session/index.ts
            test -f config/agent/extensions/remote-session/matrix-client.ts
            test -f config/agent/extensions/remote-session/state-store.ts
            test -f config/agent/extensions/nix-runtime/index.ts
            test -f config/agent/extensions/codex-fast/index.ts
            test -f config/agent/extensions/tmux-cursor-focus/index.ts
            test -f config/agent/extensions/sesh/index.ts
            test -d config/agent/skills
            test -f config/agent/skills/playwright-browser/SKILL.md
            test -d config/agent/prompts
            test -d config/agent/themes
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/web-search/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/github-issues/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/diagram-tools/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/worker-runner/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/review-agents/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/remote-session/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/remote-session/matrix-client.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/remote-session/state-store.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/nix-runtime/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/codex-fast/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/tmux-cursor-focus/index.ts
            test -f ${piHarnessResources}/share/pi-harness/agent/extensions/sesh/index.ts
            test -d ${piHarnessResources}/share/pi-harness/agent/extensions/node_modules/typebox
            test -d ${piHarnessResources}/share/pi-harness/agent/skills
            test -f ${piHarnessResources}/share/pi-harness/agent/skills/migrate-tk-to-github/SKILL.md
            test -f ${piHarnessResources}/share/pi-harness/agent/skills/playwright-browser/SKILL.md
            test -f ${piHarnessResources}/share/pi-harness/agent/skills/migrate-tk-to-github/references/inventory-schema.md
            grep -F 'disable-model-invocation: true' \
              ${piHarnessResources}/share/pi-harness/agent/skills/migrate-tk-to-github/SKILL.md >/dev/null
            mattpocock_skills_root=${mattPocockSkillsResources}/share/pi-harness/mattpocock-skills
            for skill_name in \
              ask-matt codebase-design code-review diagnosing-bugs domain-modeling \
              grill-with-docs implement prototype research resolving-merge-conflicts \
              setup-matt-pocock-skills tdd to-spec to-tickets triage wayfinder grilling handoff; do
              test -f "$mattpocock_skills_root/$skill_name/SKILL.md"
              grep -F "name: $skill_name" "$mattpocock_skills_root/$skill_name/SKILL.md" >/dev/null
            done
            grep -F 'review_agents' "$mattpocock_skills_root/code-review/SKILL.md" >/dev/null
            if grep -F "two \`Agent\` tool calls" "$mattpocock_skills_root/code-review/SKILL.md" >/dev/null; then
              echo "code-review skill still references the unavailable Agent tool" >&2
              exit 1
            fi
            for user_invoked_skill in \
              ask-matt grill-with-docs implement setup-matt-pocock-skills \
              to-spec to-tickets triage wayfinder handoff; do
              grep -F "disable-model-invocation: true" \
                "$mattpocock_skills_root/$user_invoked_skill/SKILL.md" >/dev/null
            done
            test -f "$mattpocock_skills_root/tdd/tests.md"
            test -f "$mattpocock_skills_root/setup-matt-pocock-skills/issue-tracker-github.md"
            jq -e '.enableSkillCommands == true' ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            test -d ${piHarnessResources}/share/pi-harness/agent/prompts
            test -d ${piHarnessResources}/share/pi-harness/agent/themes
            test -L ${piHarnessPackage}/share/pi-harness/agent
            test -f ${agentgraphPiResources}/share/agentgraph-pi/extensions/agentgraph/index.ts
            test -f ${agentgraphPiResources}/share/agentgraph-pi/skills/agentgraph-operator/SKILL.md
            test -f ${agentgraphPiResources}/share/agentgraph-pi/prompts/graph-change.md
            test -e ${piHarnessPackage}/bin/ag
            test -e ${piHarnessPackage}/bin/agentgraph-postgres
            test -x ${piHarnessPackage}/bin/pi-playwright
            test -x ${piHarnessPackage}/bin/pi-matrix-whoami
            test -x ${piHarnessPackage}/bin/pi-r-local
            launcher_identity=${piHarnessPackage}/share/pi-harness/eval/launcher-identity.json
            check-jsonschema --check-metaschema eval/launcher/schemas/v1/launcher-identity.schema.json
            check-jsonschema --check-metaschema eval/launcher/schemas/v1/runtime-provenance.schema.json
            check-jsonschema --schemafile eval/launcher/schemas/v1/launcher-identity.schema.json "$launcher_identity"
            jq -e '
              .schemaVersion == "1.0.0"
              and .launcher.id == "pi-r-local"
              and .launcher.path == "${piHarnessPackage}/bin/pi-r-local"
              and .launcher.defaultArgs == ["--mode", "rpc", "--no-session"]
              and .launcher.requiredResourceBindings == [
                "${piRPackage.resourcePaths.root}",
                "${piRPackage.resourcePaths.extension}",
                "${piRPackage.resourcePaths.skill}"
              ]
              and .piR.resourceRoot == "${piRPackage.resourcePaths.root}"
              and .piR.extensionPath == "${piRPackage.resourcePaths.extension}"
              and .piR.skillPath == "${piRPackage.resourcePaths.skill}"
            ' "$launcher_identity" >/dev/null
            launcher_attestation=$(mktemp)
            PI_EVAL_ATTESTATION_PATH="$launcher_attestation" \
              ${piHarnessPackage}/bin/pi-r-local --version >/dev/null
            jq -e '
              .launcherId == "pi-r-local"
              and .resourceRoot == "${piRPackage.resourcePaths.root}"
              and .extensionPath == "${piRPackage.resourcePaths.extension}"
              and .skillPath == "${piRPackage.resourcePaths.skill}"
            ' "$launcher_attestation" >/dev/null
            test -x ${piRPackage.resourcePaths.cli}
            test -x ${piRPackage.resourcePaths.rscript}
            test -x ${piRPackage.resourcePaths.parser}
            test -x ${piRPackage.resourcePaths.sandbox}
            test -f ${piRPackage.resourcePaths.extension}
            test -f ${piRPackage.resourcePaths.scoutExtension}
            test -f ${piRPackage.resourcePaths.skill}
            test -f ${piRPackage.resourcePaths.reference}
            test -f ${piRPackage.resourcePaths.formatter}
            test -x ${piRPackage.resourcePaths.parserGrammar}
            test -f ${piRPackage.resourcePaths.parserQuery}
            test -f ${piRPackage.resourcePaths.nixpkgsPin}
            test -f ${piRPackage.resourcePaths.dataInspector}
            test -f ${piRPackage.resourcePaths.valueSummary}
            test -n ${pkgs.lib.escapeShellArg piRPackage.resourcePaths.sandboxRuntimePath}
            grep -F 'PI_R_SANDBOX_PATH' ${piHarnessPackage}/bin/pi >/dev/null
            grep -F 'PI_R_SANDBOX_PATH' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F 'PI_R_DATA_INSPECTOR_SCRIPT' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F 'PI_R_VALUE_SUMMARY_SCRIPT' ${piHarnessPackage}/bin/pi >/dev/null
            grep -F 'PI_R_VALUE_SUMMARY_SCRIPT' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F 'PI_R_NIXPKGS_PIN_PATH' ${piHarnessPackage}/bin/pi >/dev/null
            grep -F 'PI_R_NIXPKGS_PIN_PATH' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F 'expandPromptTemplates: options?.expandPromptTemplates ?? false' \
              ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js >/dev/null
            grep -F 'expandPromptTemplates?: boolean' \
              ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts >/dev/null
            grep -F 'options?.onPromptExpanded?.(expandedText)' \
              ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js >/dev/null
            command_probe_dir=$(mktemp -d)
            cat > "$command_probe_dir/extension.ts" <<'EOF'
            import { writeFileSync } from "node:fs";
            import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
            export default function (pi: ExtensionAPI): void {
              pi.registerCommand("matrix-command-probe", {
                handler: async (args) => writeFileSync(process.env.PROBE_RESULT!, args),
              });
              pi.on("session_start", () => {
                pi.sendUserMessage("/matrix-command-probe expanded", { expandPromptTemplates: true });
              });
            }
            EOF
            PROBE_RESULT="$command_probe_dir/result" \
              printf '%s\n' '{"type":"get_state"}' | \
              PROBE_RESULT="$command_probe_dir/result" \
              timeout 10 ${piPackage}/bin/pi --mode rpc --no-session \
                --extension "$command_probe_dir/extension.ts" >/dev/null
            test "$(cat "$command_probe_dir/result")" = expanded
            rm -rf "$command_probe_dir"
            test -x ${remoteSessionPiWrapper}/bin/pi
            test -x ${remoteSessionWhoamiWrapper}/bin/pi-matrix-whoami
            jq -e '.packageCount == 2 and (.assertions | all)' ${remoteSessionModuleReport} >/dev/null
            grep -F 'PI_CODING_AGENT_SESSION_DIR' ${remoteSessionPiWrapper}/bin/pi >/dev/null
            grep -F '/home/operator/.local/state/syncthing/pi/sessions' \
              ${remoteSessionPiWrapper}/bin/pi >/dev/null
            grep -F 'PI_MATRIX_HOMESERVER' ${remoteSessionPiWrapper}/bin/pi >/dev/null
            grep -F '/run/secrets/pi/matrix-test-env' ${remoteSessionPiWrapper}/bin/pi >/dev/null
            grep -F 'exec ${piHarnessPackage}/bin/pi-matrix-whoami' \
              ${remoteSessionWhoamiWrapper}/bin/pi-matrix-whoami >/dev/null
            test -x ${playwrightAgentCli}/bin/playwright-cli-fallback
            ${playwrightAgentCli}/bin/playwright-cli-fallback --version | grep -Fx '0.1.17' >/dev/null
            test ! -e ${piHarnessPackage}/bin/tk
            test -x ${migrateTkApp}/bin/pi-migrate-tk
            grep -F 'no .tickets directory' ${migrateTkApp}/bin/pi-migrate-tk >/dev/null
            grep -F 'gh auth status' ${migrateTkApp}/bin/pi-migrate-tk >/dev/null
            grep -F -- "--extension \"${piRPackage.resourcePaths.extension}\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/web-search/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/github-issues/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/diagram-tools/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/worker-runner/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/review-agents/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/remote-session/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/codex-fast/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/tmux-cursor-focus/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"${piHarnessResources}/share/pi-harness/agent/extensions/sesh/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--skill \"${piHarnessResources}/share/pi-harness/agent/skills\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--skill \"${mattPocockSkillsResources}/share/pi-harness/mattpocock-skills\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--extension \"\$agentgraph_extensions_dir/agentgraph/index.ts\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F -- "--prompt-template \"\$agentgraph_prompts_dir\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "install|remove|uninstall|update|list|config)" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export AGENTGRAPH_CLI=\"\''${AGENTGRAPH_CLI:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export AGENTGRAPH_POSTGRES=\"\''${AGENTGRAPH_POSTGRES:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export PI_HARNESS_FZF=\"\''${PI_HARNESS_FZF:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export PI_HARNESS_TMUX=\"\''${PI_HARNESS_TMUX:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export PI_HARNESS_D2=\"\''${PI_HARNESS_D2:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export PI_HARNESS_DOT=\"\''${PI_HARNESS_DOT:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export PI_HARNESS_IMAGE_VIEWER=\"\''${PI_HARNESS_IMAGE_VIEWER:-" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "PI_HARNESS_AGENTGRAPH_ROOT" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "PI_HARNESS_AGENTGRAPH_SKILLS_DIR" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F "export AGENTGRAPH_PI_RESOURCES=\"\$agentgraph_root\"" ${piHarnessPackage}/bin/pi >/dev/null
            grep -F '${ticketPackage}/bin' ${migrateTkApp}/bin/pi-migrate-tk >/dev/null
            test -f ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/index.ts
            grep -F '".nix": "nix"' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/shared/language-map.ts >/dev/null
            grep -F '"dockerfile": "dockerfile"' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/shared/language-map.ts >/dev/null
            grep -F '".hs": "haskell"' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/shared/language-map.ts >/dev/null
            grep -F 'nix: { command: "nil", args: [] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'haskell: { command: "haskell-language-server-wrapper", args: ["--lsp"] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'dockerfile: { command: "docker-langserver", args: ["--stdio"] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'bash: { command: "bash-language-server", args: ["start"] }' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/lsp-manager.ts >/dev/null
            grep -F 'const runningStatuses = statuses.filter((s) => s.running);' ${piHarnessPackage.piLspExtension}/share/pi-lsp-extension/src/tools/symbols.ts >/dev/null
            jq -e '.extensions | index("./extensions/github-issues/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/diagram-tools/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/worker-runner/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/review-agents/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/remote-session/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/nix-runtime/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/codex-fast/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/tmux-cursor-focus/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null
            jq -e '.extensions | index("./extensions/sesh/index.ts")' \
              ${piHarnessResources}/share/pi-harness/agent/settings.json >/dev/null

            grep -F -- '--no-extensions' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F -- '--no-skills' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F -- '--no-context-files' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F -- '--extension "${piRPackage.resourcePaths.extension}"' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            grep -F -- '--skill "${piRPackage.resourcePaths.skill}"' ${piHarnessPackage}/bin/pi-r-local >/dev/null
            if grep -F "${piHarnessResources}/share/pi-harness/agent/extensions/" ${piHarnessPackage}/bin/pi-r-local >/dev/null; then
              echo "pi-local must not load general harness extensions" >&2
              exit 1
            fi
            PI_HARNESS_NORMAL_PI=${piHarnessPackage}/bin/pi \
              PI_HARNESS_LOCAL_PI=${piHarnessPackage}/bin/pi-r-local \
              node --test ${./tests/pi-r-integration.test.mjs}

            ${typeSetup}
            tsc --noEmit --project tsconfig.json
            test_build_dir=$(mktemp -d)
            tsc --project tsconfig.test.json --outDir "$test_build_dir"
            PI_HARNESS_JQ=${lib.getExe pkgs.jq} \
              PI_MATRIX_WHOAMI=${piHarnessPackage}/bin/pi-matrix-whoami \
              node --test \
                "$test_build_dir/tests/eval-contracts.test.js" \
                "$test_build_dir/tests/eval-grading.test.js" \
                "$test_build_dir/tests/eval-launcher.test.js" \
                "$test_build_dir/tests/eval-rpc.test.js" \
                "$test_build_dir/tests/eval-trace-metrics.test.js" \
                "$test_build_dir/tests/eval-workspace.test.js" \
                "$test_build_dir/tests/github-issues.test.js" \
                "$test_build_dir/tests/matrix-whoami.test.js" \
                "$test_build_dir/tests/remote-session.test.js" \
                "$test_build_dir/tests/remote-session-state.test.js" \
                "$test_build_dir/tests/playwright-resolver.test.js" \
                "$test_build_dir/tests/review-agents.test.js" \
                "$test_build_dir/tests/worker-runner.test.js"
          '';
        };
        verifyLspLiveApp = pkgs.writeShellApplication {
          name = "verify-lsp-live";
          runtimeInputs = [
            pkgs.coreutils
            pkgs.nodejs
            pkgs.typescript
          ]
          ++ lspPackages;
          text = ''
            set -euo pipefail
            for command_name in \
              typescript-language-server rust-analyzer ocamllsp nil pyright-langserver \
              gopls jdtls clangd lua-language-server bash-language-server \
              vscode-json-language-server vscode-html-language-server vscode-css-language-server \
              yaml-language-server docker-langserver taplo marksman terraform-ls; do
              command -v "$command_name" >/dev/null
            done
            ${typeSetup}
            test_build_dir=$(mktemp -d)
            tsc --project tsconfig.test.json --outDir "$test_build_dir"
            PI_LSP_EXTENSION=${piLspExtension}/share/pi-lsp-extension \
              PI_LSP_EXTENSION_SOURCE=${piLspExtension}/share/pi-lsp-extension/src \
              node --test "$test_build_dir/tests/lsp-live.test.js"
          '';
        };
      in
      {
        packages.pi-harness = piHarnessPackage;
        packages.pi-harness-resources = piHarnessResources;
        packages.mattpocock-skills-resources = mattPocockSkillsResources;
        packages.pi-lsp-extension = piLspExtension;
        packages.playwright-agent-cli = playwrightAgentCli;
        packages.migrate-tk = migrateTkApp;
        packages.pi = piPackage;
        packages.default = piHarnessPackage;

        apps.migrate-tk = flake-utils.lib.mkApp { drv = migrateTkApp; };
        apps.verify = flake-utils.lib.mkApp { drv = verifyApp; };
        apps.verify-lsp-live = flake-utils.lib.mkApp { drv = verifyLspLiveApp; };
        apps.default = flake-utils.lib.mkApp {
          drv = piHarnessPackage;
          exePath = "/bin/pi";
        };
        apps.pi = flake-utils.lib.mkApp {
          drv = piHarnessPackage;
          exePath = "/bin/pi";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            # piDevWrapper
            agentgraphPackage
            agentgraphPostgresPackage
            playwrightAgentCli
            pkgs.jq
            pkgs.tmux
            pkgs.d2
            pkgs.graphviz
            pkgs.xdg-utils
          ]
          ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.bubblewrap ]
          ++ lspPackages;

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
