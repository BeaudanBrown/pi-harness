{ buildNpmPackage }:
buildNpmPackage {
  pname = "pi-matrix-markdown";
  version = "1.0.0";
  src = ./matrix-markdown;
  npmDepsHash = "sha256-AqvDO4sVPRTuD/spO4z0ec3PR/eubyt0ku2mzUPY8UA=";
  dontNpmBuild = true;
  installPhase = ''
    mkdir -p "$out/lib"
    cp -R node_modules "$out/lib/node_modules"
  '';
}
