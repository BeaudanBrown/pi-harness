{
  stdenvNoCC,
  lib,
  callPackage,
  bash,
  nodejs,
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
  playwrightAgentCli ? null,
  harnessRevision ? "unversioned",
  piRRevision ? "unversioned",
}:

let
  engineeringRuntimePath = lib.makeBinPath (callPackage ./engineering-runtime.nix { });
  profileDocument = piHarnessResources.agentProfiles;
  engineeringProfile = profileDocument.profiles."engineering-full";
  fragments = import ./launcher-fragments.nix { inherit lib; };
  engineeringResourceArgs = fragments.resourceArgs engineeringProfile {
    harnessRoot = "${piHarnessResources}/share/pi-harness/agent";
    mattSkillsRoot = "${mattPocockSkillsResources}/share/pi-harness/mattpocock-skills";
  };
  # package launchers are written through an expanding shell heredoc.
  lspCleanup = lib.replaceStrings [ "$" ] [ "\\$" ] fragments.lspCleanup;
  localProfile = profileDocument.profiles."pi-local";
  localInitialTools = lib.concatStringsSep "," localProfile.tools;
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
#!${bash}/bin/bash
set -euo pipefail
export NODE_PATH="${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules:${piPackage}/lib/node_modules/@mariozechner/pi-coding-agent/node_modules:\''${NODE_PATH:-}"
export PI_HARNESS_RESOURCES_ROOT="${piHarnessResources}/share/pi-harness/agent"
export PI_HARNESS_MATT_SKILLS_ROOT="${mattPocockSkillsResources}/share/pi-harness/mattpocock-skills"
export PI_HARNESS_ENGINEERING_RUNTIME_PATH="${engineeringRuntimePath}"
export PATH="\''${PATH:+\$PATH:}${engineeringRuntimePath}"
${lib.optionalString (piLspExtension != null) ''
if [[ "\''${PI_HARNESS_LSP_ENABLED:-0}" == 1 ]]; then
  export PI_HARNESS_LSP_EXTENSION="${piLspExtension}/share/pi-lsp-extension/src/index.ts"
else
  ${lspCleanup}
fi
''}
${fragments.piREnvironment piRPackage piPackage}
export PI_HARNESS_AGENT_PROFILE="\''${PI_HARNESS_AGENT_PROFILE:-engineering-full}"
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
  ${engineeringResourceArgs}
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

    cat > "$out/bin/pi-aloop" <<EOF
#!${bash}/bin/bash
set -euo pipefail
export PI_ALOOP_LAUNCHER="\''${PI_ALOOP_LAUNCHER:-$out/bin/pi}"
exec ${nodejs}/bin/node ${piHarnessResources}/share/pi-harness/agent/extensions/aloop/headless.mjs "\$@"
EOF
    chmod +x "$out/bin/pi-aloop"

    cat > "$out/bin/pi-r-local" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export NODE_PATH="${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules:${piPackage}/lib/node_modules/@mariozechner/pi-coding-agent/node_modules:\''${NODE_PATH:-}"
${fragments.piREnvironment piRPackage piPackage}
export PI_HARNESS_AGENT_PROFILE="pi-local"
${lspCleanup}
if [[ -n "\''${PI_EVAL_ATTESTATION_PATH:-}" ]]; then
  umask 077
  printf '{"launcherId":"pi-r-local","resourceRoot":"%s","extensionPath":"%s","skillPath":"%s"}\n' \
    "\$PI_R_RESOURCE_ROOT" "${piRPackage.resourcePaths.extension}" "${piRPackage.resourcePaths.skill}" \
    > "\$PI_EVAL_ATTESTATION_PATH"
fi
export PI_R_INITIAL_TOOLS="${localInitialTools}"
exec "${lib.getExe piPackage}" \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  --extension "${piRPackage.resourcePaths.extension}" \
  --extension "${piHarnessResources.agentProfileExtension}" \
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

    ${lib.optionalString (agentgraphPackage != null) ''
      ln -s "${agentgraphPackage}/bin/ag" "$out/bin/ag"
    ''}
    ${lib.optionalString (agentgraphPostgresPackage != null) ''
      ln -s "${agentgraphPostgresPackage}/bin/agentgraph-postgres" "$out/bin/agentgraph-postgres"
    ''}

    runHook postInstall
  '';

  passthru = {
    inherit engineeringRuntimePath;
    hasAloopDriver = true;
    pi = piPackage;
    piR = piRPackage;
    piResources = piHarnessResources.piResources;
    harnessResources = piHarnessResources;
    agentProfiles = profileDocument;
    agentProfileExtension = piHarnessResources.agentProfileExtension;
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
