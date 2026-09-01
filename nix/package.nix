{
  stdenvNoCC,
  lib,
  piPackage,
  piHarnessResources,
  mattPocockSkillsResources,
  piRPackage,
  agentgraphPackage ? null,
  agentgraphPostgresPackage ? null,
  agentgraphPiResources ? null,
  piLspExtension ? null,
  managedSessionRelay ? null,
  fzf ? null,
  tmux ? null,
  d2 ? null,
  graphviz ? null,
  xdgUtils ? null,
  plantuml ? null,
  mermaidCli ? null,
  structurizrCli ? null,
  jq,
  nodejs,
  playwrightAgentCli ? null,
  harnessRevision ? "unversioned",
  piRRevision ? "unversioned",
}:

let
  evalLauncherIdentity = builtins.toJSON {
    schemaVersion = "1.0.0";
    launcher = {
      id = "pi-r-local";
      path = "@out@/bin/pi-r-local";
      defaultArgs = [
        "--mode"
        "rpc"
        "--no-session"
      ];
      requiredResourceBindings = [
        piRPackage.resourcePaths.root
        piRPackage.resourcePaths.extension
        piRPackage.resourcePaths.skill
      ];
    };
    pi.version = piPackage.version;
    harness.revision = harnessRevision;
    piR = {
      revision = piRRevision;
      resourceRoot = piRPackage.resourcePaths.root;
      extensionPath = piRPackage.resourcePaths.extension;
      skillPath = piRPackage.resourcePaths.skill;
    };
  };
in
stdenvNoCC.mkDerivation {
  pname = "pi-harness";
  version = "0.1.0";
  src = ../.;

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/pi-harness"
    ln -s ${piHarnessResources}/share/pi-harness/agent "$out/share/pi-harness/agent"

    mkdir -p "$out/bin"
    cat > "$out/bin/pi" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export NODE_PATH="${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules:${piPackage}/lib/node_modules/@mariozechner/pi-coding-agent/node_modules:\''${NODE_PATH:-}"
export PI_R_RESOURCE_ROOT="${piRPackage.resourcePaths.root}"
export PI_R_TREE_SITTER="${piRPackage.resourcePaths.parser}"
export PI_R_TREE_SITTER_R="${piRPackage.resourcePaths.parserGrammar}"
export PI_R_TREE_SITTER_QUERY="${piRPackage.resourcePaths.parserQuery}"
export PI_R_RSCRIPT="${piRPackage.resourcePaths.rscript}"
export PI_R_BASE_RSCRIPT="${piRPackage.resourcePaths.rscript}"
export PI_R_FORMATTER_SCRIPT="${piRPackage.resourcePaths.formatter}"
export PI_R_CONTRACT_READER="${piRPackage.resourcePaths.contractReader}"
export PI_R_BWRAP="${piRPackage.resourcePaths.sandbox}"
export PI_R_WORKER_RSCRIPT="${piRPackage.resourcePaths.rscript}"
export PI_R_WORKER_SCRIPT="${piRPackage.resourcePaths.worker}"
export PI_R_VALUE_SUMMARY_SCRIPT="${piRPackage.resourcePaths.valueSummary}"
export PI_R_TARGET_RUNNER_SCRIPT="${piRPackage.resourcePaths.targetRunner}"
export PI_R_ARTIFACT_INSPECTOR_SCRIPT="${piRPackage.resourcePaths.artifactInspector}"
export PI_R_DATA_INSPECTOR_SCRIPT="${piRPackage.resourcePaths.dataInspector}"
export PI_R_SANDBOX_PATH="${piRPackage.resourcePaths.sandboxRuntimePath}"
export PI_R_NIXPKGS_PATH="${piRPackage.resourcePaths.nixpkgs}"
export PI_R_NIXPKGS_PIN_PATH="${piRPackage.resourcePaths.nixpkgsPin}"
export PI_R_SCOUT_PI="${lib.getExe piPackage}"
export PI_R_SCOUT_EXTENSION="${piRPackage.resourcePaths.scoutExtension}"
unset PI_R_TEST_TREE_SITTER PI_R_TEST_TREE_SITTER_R PI_R_TEST_TREE_SITTER_QUERY PI_R_TEST_BASE_RSCRIPT PI_R_TEST_RESOURCE_ROOT
${lib.optionalString (agentgraphPackage != null) ''export AGENTGRAPH_CLI="\''${AGENTGRAPH_CLI:-${agentgraphPackage}/bin/ag}"''}
${lib.optionalString (agentgraphPostgresPackage != null) ''export AGENTGRAPH_POSTGRES="\''${AGENTGRAPH_POSTGRES:-${agentgraphPostgresPackage}/bin/agentgraph-postgres}"''}
${lib.optionalString (fzf != null) ''export PI_HARNESS_FZF="\''${PI_HARNESS_FZF:-${fzf}/bin/fzf}"''}
${lib.optionalString (tmux != null) ''export PI_HARNESS_TMUX="\''${PI_HARNESS_TMUX:-${tmux}/bin/tmux}"''}
${lib.optionalString (d2 != null) ''export PI_HARNESS_D2="\''${PI_HARNESS_D2:-${d2}/bin/d2}"''}
${lib.optionalString (graphviz != null) ''export PI_HARNESS_DOT="\''${PI_HARNESS_DOT:-${graphviz}/bin/dot}"''}
${lib.optionalString (xdgUtils != null) ''export PI_HARNESS_IMAGE_VIEWER="\''${PI_HARNESS_IMAGE_VIEWER:-${xdgUtils}/bin/xdg-open}"''}
${lib.optionalString (plantuml != null) ''export PI_HARNESS_PLANTUML="\''${PI_HARNESS_PLANTUML:-${plantuml}/bin/plantuml}"''}
${lib.optionalString (mermaidCli != null) ''export PI_HARNESS_MERMAID_CLI="\''${PI_HARNESS_MERMAID_CLI:-${mermaidCli}/bin/mmdc}"''}
${lib.optionalString (structurizrCli != null) ''export PI_HARNESS_STRUCTURIZR="\''${PI_HARNESS_STRUCTURIZR:-${structurizrCli}/bin/structurizr}"''}

case "\''${1-}" in
  install|remove|uninstall|update|list|config)
    exec "${lib.getExe piPackage}" "\$@"
    ;;
esac

resource_args=(
  --extension "${piRPackage.resourcePaths.extension}"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/web-search/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/github-issues/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/aloop/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/diagram-tools/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/worker-runner/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/review-agents/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/remote-session/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/nix-runtime/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/codex-fast/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/tmux-cursor-focus/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/sesh/index.ts"
  --skill "${piHarnessResources}/share/pi-harness/agent/skills"
  --skill "${mattPocockSkillsResources}/share/pi-harness/mattpocock-skills"
  --prompt-template "${piHarnessResources}/share/pi-harness/agent/prompts"
  --theme "${piHarnessResources}/share/pi-harness/agent/themes"
)
${lib.optionalString (agentgraphPiResources != null) ''agentgraph_root="\''${PI_HARNESS_AGENTGRAPH_ROOT:-\''${AGENTGRAPH_PI_RESOURCES:-${agentgraphPiResources}/share/agentgraph-pi}}"
agentgraph_extensions_dir="\''${PI_HARNESS_AGENTGRAPH_EXTENSIONS_DIR:-\$agentgraph_root/extensions}"
agentgraph_skills_dir="\''${PI_HARNESS_AGENTGRAPH_SKILLS_DIR:-\$agentgraph_root/skills}"
agentgraph_prompts_dir="\''${PI_HARNESS_AGENTGRAPH_PROMPTS_DIR:-\$agentgraph_root/prompts}"
export AGENTGRAPH_PI_RESOURCES="\$agentgraph_root"

if [[ ! -f "\$agentgraph_extensions_dir/agentgraph/index.ts" ]]; then
  echo "pi-harness: missing AgentGraph extension at \$agentgraph_extensions_dir/agentgraph/index.ts" >&2
  exit 1
fi
if [[ ! -d "\$agentgraph_skills_dir" ]]; then
  echo "pi-harness: missing AgentGraph skills dir at \$agentgraph_skills_dir" >&2
  exit 1
fi
if [[ ! -d "\$agentgraph_prompts_dir" ]]; then
  echo "pi-harness: missing AgentGraph prompts dir at \$agentgraph_prompts_dir" >&2
  exit 1
fi
resource_args+=(
  --extension "\$agentgraph_extensions_dir/agentgraph/index.ts"
  --skill "\$agentgraph_skills_dir"
  --prompt-template "\$agentgraph_prompts_dir"
)''}

exec "${lib.getExe piPackage}" "\''${resource_args[@]}" "\$@"
EOF
    chmod +x "$out/bin/pi"

    cat > "$out/bin/pi-r-local" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export NODE_PATH="${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules:${piPackage}/lib/node_modules/@mariozechner/pi-coding-agent/node_modules:\''${NODE_PATH:-}"
export PI_R_RESOURCE_ROOT="${piRPackage.resourcePaths.root}"
export PI_R_TREE_SITTER="${piRPackage.resourcePaths.parser}"
export PI_R_TREE_SITTER_R="${piRPackage.resourcePaths.parserGrammar}"
export PI_R_TREE_SITTER_QUERY="${piRPackage.resourcePaths.parserQuery}"
export PI_R_RSCRIPT="${piRPackage.resourcePaths.rscript}"
export PI_R_BASE_RSCRIPT="${piRPackage.resourcePaths.rscript}"
export PI_R_FORMATTER_SCRIPT="${piRPackage.resourcePaths.formatter}"
export PI_R_CONTRACT_READER="${piRPackage.resourcePaths.contractReader}"
export PI_R_BWRAP="${piRPackage.resourcePaths.sandbox}"
export PI_R_WORKER_RSCRIPT="${piRPackage.resourcePaths.rscript}"
export PI_R_WORKER_SCRIPT="${piRPackage.resourcePaths.worker}"
export PI_R_VALUE_SUMMARY_SCRIPT="${piRPackage.resourcePaths.valueSummary}"
export PI_R_TARGET_RUNNER_SCRIPT="${piRPackage.resourcePaths.targetRunner}"
export PI_R_ARTIFACT_INSPECTOR_SCRIPT="${piRPackage.resourcePaths.artifactInspector}"
export PI_R_DATA_INSPECTOR_SCRIPT="${piRPackage.resourcePaths.dataInspector}"
export PI_R_SANDBOX_PATH="${piRPackage.resourcePaths.sandboxRuntimePath}"
export PI_R_NIXPKGS_PATH="${piRPackage.resourcePaths.nixpkgs}"
export PI_R_NIXPKGS_PIN_PATH="${piRPackage.resourcePaths.nixpkgsPin}"
export PI_R_SCOUT_PI="${lib.getExe piPackage}"
export PI_R_SCOUT_EXTENSION="${piRPackage.resourcePaths.scoutExtension}"
unset PI_R_TEST_TREE_SITTER PI_R_TEST_TREE_SITTER_R PI_R_TEST_TREE_SITTER_QUERY PI_R_TEST_BASE_RSCRIPT PI_R_TEST_RESOURCE_ROOT
if [[ -n "\''${PI_EVAL_ATTESTATION_PATH:-}" ]]; then
  umask 077
  printf '{"launcherId":"pi-r-local","resourceRoot":"%s","extensionPath":"%s","skillPath":"%s"}\n' \
    "\$PI_R_RESOURCE_ROOT" "${piRPackage.resourcePaths.extension}" "${piRPackage.resourcePaths.skill}" \
    > "\$PI_EVAL_ATTESTATION_PATH"
fi
export PI_R_INITIAL_TOOLS="\''${PI_R_INITIAL_TOOLS:-read,bash,edit,write,grep,find,ls}"
exec "${lib.getExe piPackage}" \
  --no-extensions \
  --no-skills \
  --no-context-files \
  --extension "${piRPackage.resourcePaths.extension}" \
  --skill "${piRPackage.resourcePaths.skill}" \
  "\$@"
EOF
    chmod +x "$out/bin/pi-r-local"

    mkdir -p "$out/share/pi-harness/eval"
    cat > "$out/share/pi-harness/eval/launcher-identity.json" <<'EOF'
${evalLauncherIdentity}
EOF
    substituteInPlace "$out/share/pi-harness/eval/launcher-identity.json" \
      --replace-fail '@out@' "$out"

    cp bin/pi-playwright "$out/bin/pi-playwright"
    substituteInPlace "$out/bin/pi-playwright" \
      --replace-fail '@PI_HARNESS_JQ@' '${lib.getExe jq}'
    chmod +x "$out/bin/pi-playwright"

    cp bin/pi-matrix-whoami "$out/bin/pi-matrix-whoami"
    substituteInPlace "$out/bin/pi-matrix-whoami" \
      --replace-fail '@PI_HARNESS_NODE@' '${lib.getExe nodejs}'
    chmod +x "$out/bin/pi-matrix-whoami"
    ${lib.optionalString (agentgraphPackage != null) ''
      ln -s "${agentgraphPackage}/bin/ag" "$out/bin/ag"
    ''}
    ${lib.optionalString (agentgraphPostgresPackage != null) ''
      ln -s "${agentgraphPostgresPackage}/bin/agentgraph-postgres" "$out/bin/agentgraph-postgres"
    ''}

    runHook postInstall
  '';

  passthru = {
    pi = piPackage;
    piR = piRPackage;
    piResources = piHarnessResources.piResources;
    harnessResources = piHarnessResources;
    managedSessionExtensions = piHarnessResources.managedSessionExtensions;
    inherit managedSessionRelay;
    mattpocockSkills = mattPocockSkillsResources;
    agentgraph = agentgraphPackage;
    agentgraphPostgres = agentgraphPostgresPackage;
    agentgraphPiResources = agentgraphPiResources;
    piLspExtension = piLspExtension;
    fzf = fzf;
    tmux = tmux;
    d2 = d2;
    graphviz = graphviz;
    xdgUtils = xdgUtils;
    plantuml = plantuml;
    mermaidCli = mermaidCli;
    structurizrCli = structurizrCli;
    playwrightAgentCli = playwrightAgentCli;
    evalLauncherIdentity = {
      path = "share/pi-harness/eval/launcher-identity.json";
      inherit harnessRevision piRRevision;
    };
  };

  meta = {
    description = "Shared Pi coding-agent configuration for Beau's machines";
    mainProgram = "pi";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
