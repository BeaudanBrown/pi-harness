{
  pkgs,
  lib,
  source,
  piPackage,
  piHarnessPackage,
  piHarnessResources,
  piRPackage,
  agentgraphPiResources,
  managedSessionRelay,
  managedSessionLauncher,
  managedSessionPiWrapper,
  managedSessionStatusWrapper,
  managedSessionCoordinatorPi,
  managedLspDisabledCoordinatorPi,
  lspDisabledPiWrapper,
  managedSessionModuleReport,
  mattPocockSkillsResources,
  migrateTkApp,
  playwrightAgentCli,
  piLspExtension,
  evalSelfTestApp,
  typeSetup,
  lspPackages,
}:
let
  prepareSource = ''
    work="$TMPDIR/pi-harness-source"
    cp -R --no-preserve=mode ${source} "$work"
    chmod -R u+w "$work"
    cd "$work"
  '';

  sourceContracts = pkgs.runCommand "pi-harness-source-contracts" {
    nativeBuildInputs = [ pkgs.coreutils pkgs.gnugrep pkgs.jq pkgs.nodejs ];
  } ''
    ${prepareSource}
    node scripts/verification/resource-contract.mjs .
    for required in \
      docs/architecture/decisions/0001-synthetic-evaluation-contracts.md \
      docs/architecture/decisions/0002-managed-session-contracts.md \
      docs/verification.md \
      config/agent/extensions/managed-sessions/contracts.ts \
      config/agent/extensions/managed-sessions/adapter/ordinary.ts \
      config/agent/extensions/managed-sessions/adapter/coordinator.ts \
      config/agent/extensions/managed-sessions/relay/main.ts \
      eval/contracts/path-policy.ts eval/rpc/engine.ts eval/workspace/materialize.ts \
      eval/trace/capture.ts eval/grading/grade.ts; do
      test -f "$required" || { echo "missing required contract: $required" >&2; exit 1; }
    done
    if grep -R -n -E 'from "node:(child_process|http|https)"|PI_MATRIX|MATRIX_ACCESS_TOKEN|send-keys' \
      config/agent/extensions/managed-sessions/adapter; then
      echo "managed-session adapter crossed the relay authority seam" >&2
      exit 1
    fi
    if grep -R -n -F 'node:readline' eval/rpc; then
      echo "eval RPC engine must use strict LF framing, not Node readline" >&2
      exit 1
    fi
    test ! -e config/agent/extensions/remote-session
    test ! -e bin/pi-matrix-whoami
    touch "$out"
  '';

  schemaContracts = pkgs.runCommand "pi-harness-schema-contracts" {
    nativeBuildInputs = [ pkgs.check-jsonschema pkgs.coreutils ];
  } ''
    ${prepareSource}
    reject() {
      local schema=$1
      shift
      if check-jsonschema --schemafile "$schema" "$@"; then
        echo "invalid fixture unexpectedly passed $schema: $*" >&2
        exit 1
      fi
    }
    (
      cd eval/contracts/schemas/v1
      fixture_root=../../fixtures
      check-jsonschema --check-metaschema ./*.schema.json
      check-jsonschema --schemafile pack.schema.json "$fixture_root/valid/pack.json"
      check-jsonschema --schemafile scenario.schema.json \
        "$fixture_root/valid/scenarios/sensor-smoke.json" "$fixture_root/valid/scenarios/ui-policy-v1.json"
      check-jsonschema --schemafile synthetic-provenance.schema.json "$fixture_root/valid/provenance.json"
      check-jsonschema --schemafile metrics.schema.json "$fixture_root/valid/metrics.json"
      check-jsonschema --schemafile run-result.schema.json "$fixture_root/valid/run-result.json"
      check-jsonschema --schemafile comparison.schema.json "$fixture_root/valid/baselines/reviewed-summary.json"
      for fixture in pack-traversal pack-absolute pack-external-uri pack-nul-path pack-trailing-slash; do
        reject pack.schema.json "$fixture_root/invalid/$fixture.json"
      done
      # These are schema-valid and are rejected by the semantic loader tests.
      check-jsonschema --schemafile pack.schema.json \
        "$fixture_root/invalid/pack-duplicate-suite-id.json" "$fixture_root/invalid/pack-unknown-scenario.json"
      for fixture in scenario-generator-missing-outputs scenario-missing-provenance scenario-not-synthetic; do
        reject scenario.schema.json "$fixture_root/invalid/$fixture.json"
      done
      for fixture in provenance-extra-property provenance-missing-synthetic provenance-not-synthetic; do
        reject synthetic-provenance.schema.json "$fixture_root/invalid/$fixture.json"
      done
      for fixture in assertion-file-missing-expected assertion-final-text-missing-condition assertion-git-missing-condition assertion-oracle-missing-target assertion-ui-missing-condition; do
        reject assertion.schema.json "$fixture_root/invalid/$fixture.json"
      done
    )
    (
      cd eval/contracts/schemas/v2
      fixture_root=../../fixtures
      check-jsonschema --check-metaschema ./*.schema.json
      check-jsonschema --schemafile scenario.schema.json \
        "$fixture_root/valid/scenarios/sensor-smoke-v2.json" "$fixture_root/invalid/scenario-duplicate-ui-dialog.json"
      reject scenario.schema.json "$fixture_root/invalid/scenario-unsupported-version.json"
      reject ui-policy.schema.json "$fixture_root/invalid/ui-policy-response-mismatch.json"
    )
    (
      cd eval/contracts/schemas/v3
      fixture_root=../../fixtures
      check-jsonschema --check-metaschema ./*.schema.json
      check-jsonschema --schemafile scenario.schema.json "$fixture_root/valid/scenarios/sensor-smoke-v3.json"
    )
    touch "$out"
  '';

  testBuild = pkgs.runCommand "pi-harness-typescript-test-build" {
    nativeBuildInputs = [ pkgs.coreutils pkgs.typescript ];
  } ''
    ${prepareSource}
    ${typeSetup}
    mkdir -p "$out/build" "$out/source"
    tsc --project tsconfig.test.json --outDir "$out/build"
    cp -R config eval tests bin .aloop.json .pi-types "$out/source/"
  '';

  runCompiledTests = {
    name,
    selector,
    extraInputs ? [ ],
    environment ? "",
    nodeArgs ? "",
  }: pkgs.runCommand name {
    nativeBuildInputs = [ pkgs.bash pkgs.coreutils pkgs.git pkgs.nodejs pkgs.jq pkgs.gnugrep ] ++ extraInputs;
  } ''
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    work="$TMPDIR/work"
    cp -R --no-preserve=mode ${testBuild}/source "$work"
    chmod -R u+w "$work"
    chmod +x "$work/bin/pi-playwright"
    cd "$work"
    export NODE_PATH=${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules:${piPackage}/lib/node_modules/@mariozechner/pi-coding-agent/node_modules
    mapfile -t test_files < <(${selector})
    if [[ ''${#test_files[@]} -eq 0 ]]; then
      echo "${name}: no tests selected" >&2
      exit 1
    fi
    ${environment}
    node --test ${nodeArgs} "''${test_files[@]}"
    touch "$out"
  '';

  unitTests = runCompiledTests {
    name = "pi-harness-unit-tests";
    selector = ''
      find ${testBuild}/build/tests -maxdepth 1 -type f -name '*.test.js' \
        ! -name 'eval-*.test.js' \
        ! -name 'lsp-live.test.js' \
        ! -name 'managed-session-*.test.js' | sort
    '';
    environment = ''
      export PI_HARNESS_JQ=${lib.getExe pkgs.jq}
      export PI_TEST_BASH=${lib.getExe pkgs.bash}
    '';
  };

  managedSessionTests = runCompiledTests {
    name = "pi-harness-managed-session-tests";
    selector = ''find ${testBuild}/build/tests -maxdepth 1 -type f -name 'managed-session-*.test.js' | sort'';
    extraInputs = [ pkgs.direnv pkgs.tmux pkgs.imagemagick ];
    nodeArgs = "--test-concurrency=1";
    environment = ''
      export PI_HARNESS_JQ=${lib.getExe pkgs.jq}
      export PI_TEST_SHELL=${lib.getExe pkgs.bash}
      export PI_MANAGED_ADAPTER_TEST_PI=${piPackage}/bin/pi
      export PI_MANAGED_ADAPTER_ORDINARY_EXTENSION=${piHarnessResources.managedSessionExtensions.ordinary}
      export PI_MANAGED_ADAPTER_COORDINATOR_EXTENSION=${piHarnessResources.managedSessionExtensions.coordinator}
      export PI_MANAGED_ADAPTER_MODEL_POLICY_EXTENSION=${piHarnessResources.managedSessionExtensions.modelPolicy}
      export PI_MANAGED_SESSIONS_TEST_PEER_UID_HELPER=${managedSessionRelay}/libexec/pi-managed-session-peer-uid
      export PI_MANAGED_SESSIONS_TEST_RELAY_LOCK_HELPER=${managedSessionRelay}/libexec/pi-managed-session-relay-lock
      export PI_MANAGED_SESSIONS_TEST_IMAGE_NORMALIZER=${lib.getExe pkgs.imagemagick}
      export PI_MANAGED_SESSIONS_TEST_TMUX=${pkgs.tmux}/bin/tmux
      export PI_MANAGED_TEST_LAUNCHER=${managedSessionLauncher}/bin/tmux_project
      export PI_MANAGED_SESSIONS_WORKSPACE_ROOTS="{\"projects\":\"$TMPDIR/workspaces\"}"
      export PI_MANAGED_TEST_COORDINATOR_PI=${managedSessionCoordinatorPi}/bin/pi
      export PI_MANAGED_TEST_MANAGED_PI=${managedSessionCoordinatorPi}/bin/pi
      export PI_MANAGED_TEST_DIRENV=${pkgs.direnv}/bin/direnv
    '';
  };

  piRIntegration = pkgs.runCommand "pi-harness-pi-r-integration" {
    nativeBuildInputs = [ pkgs.git pkgs.nodejs ];
  } ''
    PI_HARNESS_NORMAL_PI=${piHarnessPackage}/bin/pi \
      PI_HARNESS_LOCAL_PI=${piHarnessPackage}/bin/pi-r-local \
      node --test ${source}/tests/pi-r-integration.test.mjs
    touch "$out"
  '';

  evalTests = pkgs.runCommand "pi-harness-eval-self-test-check" { } ''
    ${evalSelfTestApp}/bin/pi-eval-self-test
    touch "$out"
  '';

  packageContracts = pkgs.runCommand "pi-harness-package-contracts" {
    nativeBuildInputs = [ pkgs.check-jsonschema pkgs.coreutils pkgs.gnugrep pkgs.jq pkgs.nodejs ];
  } ''
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    agent_root=${piHarnessResources}/share/pi-harness/agent
    test -L ${piHarnessPackage}/share/pi-harness/agent
    for extension in ${lib.concatMapStringsSep " " lib.escapeShellArg piHarnessResources.piResources.extensions}; do
      test -f "$extension" || { echo "missing packaged extension: $extension" >&2; exit 1; }
    done
    test -f ${piHarnessResources.managedSessionExtensions.ordinary}
    test -f ${piHarnessResources.managedSessionExtensions.coordinator}
    test -f ${piHarnessResources.managedSessionExtensions.modelPolicy}
    test -d "$agent_root/extensions/node_modules/typebox"
    test -f "$agent_root/skills/migrate-tk-to-github/SKILL.md"
    test -f "$agent_root/skills/playwright-browser/SKILL.md"
    test ! -e "$agent_root/extensions/remote-session"

    test -f ${agentgraphPiResources}/share/agentgraph-pi/extensions/agentgraph/index.ts
    test -f ${agentgraphPiResources}/share/agentgraph-pi/skills/agentgraph-operator/SKILL.md
    test -e ${piHarnessPackage}/bin/ag
    test -e ${piHarnessPackage}/bin/agentgraph-postgres
    test -x ${piHarnessPackage}/bin/pi-playwright
    test -x ${piHarnessPackage}/bin/pi-r-local
    test ! -e ${piHarnessPackage}/bin/pi-matrix-whoami
    test ! -e ${piHarnessPackage}/bin/pi-managed-session-relay
    test -x ${managedSessionRelay}/bin/pi-managed-session-relay
    test ! -e ${piHarnessPackage}/bin/tk
    test -x ${migrateTkApp}/bin/pi-migrate-tk

    launcher_identity=${piHarnessPackage}/share/pi-harness/eval/launcher-identity.json
    check-jsonschema --check-metaschema ${source}/eval/launcher/schemas/v1/launcher-identity.schema.json ${source}/eval/launcher/schemas/v1/runtime-provenance.schema.json
    check-jsonschema --schemafile ${source}/eval/launcher/schemas/v1/launcher-identity.schema.json "$launcher_identity"
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
    trap 'rm -f "$launcher_attestation"' EXIT
    PI_EVAL_ATTESTATION_PATH="$launcher_attestation" ${piHarnessPackage}/bin/pi-r-local --version >/dev/null
    jq -e '
      .launcherId == "pi-r-local"
      and .resourceRoot == "${piRPackage.resourcePaths.root}"
      and .extensionPath == "${piRPackage.resourcePaths.extension}"
      and .skillPath == "${piRPackage.resourcePaths.skill}"
    ' "$launcher_attestation" >/dev/null

    for resource in \
      ${piRPackage.resourcePaths.extension} ${piRPackage.resourcePaths.scoutExtension} \
      ${piRPackage.resourcePaths.skill} ${piRPackage.resourcePaths.reference} \
      ${piRPackage.resourcePaths.formatter} ${piRPackage.resourcePaths.parserQuery} \
      ${piRPackage.resourcePaths.nixpkgsPin} ${piRPackage.resourcePaths.dataInspector} \
      ${piRPackage.resourcePaths.valueSummary}; do
      test -f "$resource" || { echo "missing pi-r resource: $resource" >&2; exit 1; }
    done
    for executable in ${piRPackage.resourcePaths.cli} ${piRPackage.resourcePaths.rscript} ${piRPackage.resourcePaths.parser} ${piRPackage.resourcePaths.sandbox}; do
      test -x "$executable" || { echo "missing pi-r executable: $executable" >&2; exit 1; }
    done
    ${playwrightAgentCli}/bin/playwright-cli-fallback --version | grep -Fx '0.1.17' >/dev/null

    # High-value negative package assertions remain explicit security contracts.
    ! grep -F 'extensions/remote-session/' ${piHarnessPackage}/bin/pi
    ! grep -F 'managed-sessions/adapter/' ${piHarnessPackage}/bin/pi
    ! grep -F '/run/secrets/pi-managed-session.env' ${managedSessionPiWrapper}/bin/pi
    touch "$out"
  '';

  moduleContracts = pkgs.runCommand "pi-harness-module-contracts" {
    nativeBuildInputs = [ pkgs.coreutils pkgs.gnugrep pkgs.jq ];
  } ''
    jq -e '(.assertions | all) and .relayUserLingers and .servicePathCount == 4
      and (.hasGeneralEnvironmentFile | not) and (.hasPrivateTmp | not)
      and .serviceEnvironment.PI_MANAGED_SESSIONS_HOST_ID == "test-host"
      and (.serviceEnvironment.PI_MATRIX_IGNORED_SENDER_USER_IDS | fromjson) == ["@signalbot:example.com", "@facebookbot:example.com"]' \
      ${managedSessionModuleReport} >/dev/null
    test -x ${managedSessionPiWrapper}/bin/pi
    test -x ${managedSessionStatusWrapper}/bin/pi-managed-session-status
    test -x ${managedSessionCoordinatorPi}/bin/pi
    test -x ${managedLspDisabledCoordinatorPi}/bin/pi
    test -x ${lspDisabledPiWrapper}/bin/pi

    # Generated wrappers are shell interfaces. Keep only capability and secret
    # assertions that cannot be observed without starting a long-lived Pi RPC process.
    coordinator=$(grep -Eo '/nix/store/[^ ]+-pi-managed-coordinator/bin/pi-managed-coordinator' ${managedSessionCoordinatorPi}/bin/pi | head -1)
    test -x "$coordinator"
    for flag in --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-builtin-tools; do
      grep -F -- "$flag" "$coordinator" >/dev/null
    done
    grep -F 'unset PI_HARNESS_LSP_ENABLED PI_HARNESS_LSP_EXTENSION PI_HARNESS_LSP_FALLBACK_PATH' "$coordinator" >/dev/null
    grep -F 'coordinator_model_args+=(--model "$PI_MANAGED_SESSION_MODEL")' "$coordinator" >/dev/null
    grep -F 'coordinator_model_args+=(--thinking "$PI_MANAGED_SESSION_THINKING")' "$coordinator" >/dev/null
    grep -F 'export PI_MANAGED_LOCAL_MODEL_TOOLS=' ${managedSessionCoordinatorPi}/bin/pi >/dev/null
    grep -F '${pkgs.bash}/bin' ${managedSessionCoordinatorPi}/bin/pi >/dev/null
    grep -F '${pkgs.which}/bin' ${managedSessionCoordinatorPi}/bin/pi >/dev/null
    managed_runtime_path=${lib.makeBinPath [ pkgs.bash pkgs.which pkgs.coreutils ]}
    test "$(${pkgs.coreutils}/bin/env -i PATH="$managed_runtime_path" which bash)" = '${lib.getExe pkgs.bash}'
    ${pkgs.coreutils}/bin/env -i PATH="$managed_runtime_path" sh -c 'date +%F >/dev/null'
    grep -F -- '--extension "${piHarnessResources.managedSessionExtensions.modelPolicy}"' ${managedSessionCoordinatorPi}/bin/pi >/dev/null
    ! grep -F '${piHarnessResources.managedSessionExtensions.modelPolicy}' "$coordinator" >/dev/null
    ! grep -F '${piLspExtension}/share/pi-lsp-extension/src/index.ts' ${lspDisabledPiWrapper}/bin/pi >/dev/null
    touch "$out"
  '';

  promptExpansionContract = pkgs.runCommand "pi-harness-prompt-expansion-contract" {
    nativeBuildInputs = [ pkgs.coreutils pkgs.nodejs ];
  } ''
    probe=$(mktemp -d)
    trap 'rm -rf "$probe"' EXIT
    cat > "$probe/extension.ts" <<'EOF'
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
    printf '%s\n' '{"type":"get_state"}' | env PROBE_RESULT="$probe/result" \
      timeout 10 ${piPackage}/bin/pi --mode rpc --no-session --extension "$probe/extension.ts" >/dev/null
    test "$(cat "$probe/result")" = expanded
    touch "$out"
  '';

  deterministicChecks = {
    source-contracts = sourceContracts;
    schema-contracts = schemaContracts;
    typescript-build = testBuild;
    unit-tests = unitTests;
    managed-session-tests = managedSessionTests;
    pi-r-integration = piRIntegration;
    eval-self-test = evalTests;
    package-contracts = packageContracts;
    module-contracts = moduleContracts;
    prompt-expansion-contract = promptExpansionContract;
  };

  verify = pkgs.runCommand "pi-harness-verify" { } ''
    mkdir -p "$out"
    ${lib.concatMapStringsSep "\n" (name: ''ln -s ${deterministicChecks.${name}} "$out/${name}"'') (builtins.attrNames deterministicChecks)}
    printf '%s\n' ${lib.concatMapStringsSep " " lib.escapeShellArg (builtins.attrNames deterministicChecks)} > "$out/checks"
  '';

  verifyApp = pkgs.writeShellApplication {
    name = "verify";
    text = ''
      echo "pi-harness deterministic verification passed:"
      while IFS= read -r check; do printf '  %s\n' "$check"; done < ${verify}/checks
    '';
  };

  verifyLspLiveApp = pkgs.writeShellApplication {
    name = "verify-lsp-live";
    runtimeInputs = [ pkgs.coreutils pkgs.nodejs ] ++ lspPackages;
    text = ''
      set -euo pipefail
      work=$(mktemp -d)
      trap 'rm -rf "$work"' EXIT
      cp -R --no-preserve=mode ${testBuild}/source/. "$work/"
      cd "$work"
      export NODE_PATH=${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules:${piPackage}/lib/node_modules/@mariozechner/pi-coding-agent/node_modules
      for command_name in \
        typescript-language-server rust-analyzer ocamllsp nil pyright-langserver \
        gopls jdtls clangd lua-language-server bash-language-server \
        vscode-json-language-server vscode-html-language-server vscode-css-language-server \
        yaml-language-server docker-langserver taplo marksman terraform-ls; do
        command -v "$command_name" >/dev/null
      done
      PI_LSP_EXTENSION=${piLspExtension}/share/pi-lsp-extension \
        PI_LSP_EXTENSION_SOURCE=${piLspExtension}/share/pi-lsp-extension/src \
        node --test ${testBuild}/build/tests/lsp-live.test.js
    '';
  };
in
{
  checks = deterministicChecks // { inherit verify; };
  inherit verifyApp verifyLspLiveApp;
}
