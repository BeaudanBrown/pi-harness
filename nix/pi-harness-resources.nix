{
  stdenvNoCC,
  lib,
  piPackage,
}:

let
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

    passthru.piResources = {
      extensions = [
        "${drv}/share/pi-harness/agent/extensions/web-search/index.ts"
        "${drv}/share/pi-harness/agent/extensions/agent-loop/index.ts"
        "${drv}/share/pi-harness/agent/extensions/nix-runtime/index.ts"
      ];
      skills = [ "${drv}/share/pi-harness/agent/skills" ];
      prompts = [ "${drv}/share/pi-harness/agent/prompts" ];
      themes = [ "${drv}/share/pi-harness/agent/themes" ];
      runtimePackages = [ ];
    };

    meta = {
      description = "Immutable Pi resource paths for pi-harness";
      platforms = lib.platforms.linux ++ lib.platforms.darwin;
    };
  };
in
 drv
