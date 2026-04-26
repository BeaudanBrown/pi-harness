{ stdenvNoCC, lib, piPackage }:

stdenvNoCC.mkDerivation {
  pname = "pi-harness";
  version = "0.1.0";
  src = ../.;

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/pi-harness/agent"
    cp -R config/agent/. "$out/share/pi-harness/agent/"

    mkdir -p "$out/bin"
    ln -s "${lib.getExe piPackage}" "$out/bin/pi"

    runHook postInstall
  '';

  passthru = {
    pi = piPackage;
  };

  meta = {
    description = "Shared Pi coding-agent configuration for Beau's machines";
    mainProgram = "pi";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
