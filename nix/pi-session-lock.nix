{ stdenv, nodejs, lib }:
stdenv.mkDerivation {
  pname = "pi-native-session-lock";
  version = "1";
  src = lib.fileset.toSource {
    root = ../config/agent/extensions/matrix-bridge;
    fileset = lib.fileset.unions [
      ../config/agent/extensions/matrix-bridge/session-lock.c
      ../config/agent/extensions/matrix-bridge/session-lock.cjs
    ];
  };
  buildPhase = ''
    $CC -shared -fPIC -O2 -Wall -Wextra -Werror \
      -I ${nodejs}/include/node session-lock.c -o session-lock.node
  '';
  installPhase = ''
    mkdir -p "$out/lib"
    cp session-lock.node session-lock.cjs "$out/lib/"
    substituteInPlace "$out/lib/session-lock.cjs" \
      --replace-fail '@nativeLockAddon@' "$out/lib/session-lock.node"
  '';
  meta.platforms = lib.platforms.linux ++ lib.platforms.darwin;
}
