{
  stdenvNoCC,
  lib,
  piPackage,
  agentgraphPackage ? null,
  agentgraphPostgresPackage ? null,
  agentgraphPiResources ? null,
}:

stdenvNoCC.mkDerivation {
  pname = "pi-harness";
  version = "0.1.0";
  src = ../.;

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/pi-harness/agent"
    cp -R config/agent/. "$out/share/pi-harness/agent/"

    ${lib.optionalString (agentgraphPiResources != null) ''
      mkdir -p "$out/share/pi-harness/agent/extensions"
      mkdir -p "$out/share/pi-harness/agent/skills"
      mkdir -p "$out/share/pi-harness/agent/prompts"
      mkdir -p "$out/share/pi-harness/agent/sql"
      cp -R ${agentgraphPiResources}/share/agentgraph-pi/extensions/. "$out/share/pi-harness/agent/extensions/"
      cp -R ${agentgraphPiResources}/share/agentgraph-pi/skills/. "$out/share/pi-harness/agent/skills/"
      cp -R ${agentgraphPiResources}/share/agentgraph-pi/prompts/. "$out/share/pi-harness/agent/prompts/"
      cp -R ${agentgraphPiResources}/share/agentgraph-pi/sql/. "$out/share/pi-harness/agent/sql/"
      cat > "$out/share/pi-harness/agent/settings.json" <<'JSON'
{
  "$schema": "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/core/settings-schema.json",
  "extensions": [
    "./extensions/web-search/index.ts",
    "./extensions/agentgraph/index.ts"
  ],
  "skills": [
    "./skills"
  ],
  "prompts": [
    "./prompts"
  ],
  "themes": [
    "./themes"
  ],
  "enableSkillCommands": true,
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
JSON
    ''}

    mkdir -p "$out/share/pi-harness/agent/extensions/node_modules"
    typebox_dir=""
    for candidate in \
      "${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox" \
      "${piPackage}/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/typebox"
    do
      if [ -d "$candidate" ]; then
        typebox_dir="$candidate"
        break
      fi
    done
    if [ -z "$typebox_dir" ]; then
      echo "Could not find Pi-bundled typebox in ${piPackage}" >&2
      exit 1
    fi
    cp -R "$typebox_dir" "$out/share/pi-harness/agent/extensions/node_modules/typebox"

    mkdir -p "$out/bin"
    cat > "$out/bin/pi" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export NODE_PATH="${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules:${piPackage}/lib/node_modules/@mariozechner/pi-coding-agent/node_modules:\''${NODE_PATH:-}"
export AG_DEV_ROOT="$out/share/pi-harness/agent"
${lib.optionalString (agentgraphPackage != null) ''export AGENTGRAPH_CLI="${agentgraphPackage}/bin/ag"''}
${lib.optionalString (agentgraphPostgresPackage != null) ''export AGENTGRAPH_POSTGRES="${agentgraphPostgresPackage}/bin/agentgraph-postgres"''}
exec "${lib.getExe piPackage}" "\$@"
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
    agentgraph = agentgraphPackage;
    agentgraphPostgres = agentgraphPostgresPackage;
    agentgraphPiResources = agentgraphPiResources;
  };

  meta = {
    description = "Shared Pi coding-agent configuration for Beau's machines";
    mainProgram = "pi";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
