{
  stdenvNoCC,
  lib,
  piPackage,
}:

let
  profileDocument = builtins.fromJSON (builtins.readFile ../config/agent/profiles.json);
  drv = stdenvNoCC.mkDerivation {
    pname = "pi-harness-resources";
    version = "0.1.0";
    src = ../.;

    dontBuild = true;

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/share/pi-harness/agent"
      cp -R config/agent/. "$out/share/pi-harness/agent/"

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

      runHook postInstall
    '';

    passthru.agentProfiles = profileDocument;

    passthru.agentProfileExtension = "${drv}/share/pi-harness/agent/extensions/agent-profiles/index.ts";

    passthru.managedSessionExtensions = {
      ordinary = "${drv}/share/pi-harness/agent/extensions/managed-sessions/adapter/ordinary.ts";
      coordinator = "${drv}/share/pi-harness/agent/extensions/managed-sessions/adapter/coordinator.ts";
    };

    passthru.piResources = {
      extensions = map
        (name: "${drv}/share/pi-harness/agent/extensions/${name}/index.ts")
        (builtins.filter
          (name: name != "pi-r" && name != "agentgraph" && name != "lsp")
          profileDocument.profiles."engineering-full".extensions);
      skills = lib.optional (builtins.elem "harness" profileDocument.profiles."engineering-full".skills) "${drv}/share/pi-harness/agent/skills";
      prompts = lib.optional (builtins.elem "harness" profileDocument.profiles."engineering-full".prompts) "${drv}/share/pi-harness/agent/prompts";
      themes = lib.optional (builtins.elem "harness" profileDocument.profiles."engineering-full".themes) "${drv}/share/pi-harness/agent/themes";
      runtimePackages = [ ];
    };

    meta = {
      description = "Immutable Pi resource paths for pi-harness";
      platforms = lib.platforms.linux ++ lib.platforms.darwin;
    };
  };
in
 drv
