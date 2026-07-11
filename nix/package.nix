{
  stdenvNoCC,
  lib,
  piPackage,
  piHarnessResources,
  mattPocockSkillsResources,
  agentgraphPackage ? null,
  agentgraphPostgresPackage ? null,
  agentgraphPiResources ? null,
  piLspExtension ? null,
  fzf ? null,
  tmux ? null,
  d2 ? null,
  graphviz ? null,
  xdgUtils ? null,
  plantuml ? null,
  mermaidCli ? null,
  structurizrCli ? null,
}:

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
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/web-search/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/github-issues/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/diagram-tools/index.ts"
  --extension "${piHarnessResources}/share/pi-harness/agent/extensions/worker-runner/index.ts"
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
    piResources = piHarnessResources.piResources;
    harnessResources = piHarnessResources;
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
  };

  meta = {
    description = "Shared Pi coding-agent configuration for Beau's machines";
    mainProgram = "pi";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
