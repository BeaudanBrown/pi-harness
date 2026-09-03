{
  stdenv,
  lib,
  nodejs,
  typescript,
  piPackage,
  imagemagick,
  runtimeShell,
}:

stdenv.mkDerivation {
  pname = "pi-managed-session-relay";
  version = "0.1.0";
  src = ../.;

  nativeBuildInputs = [ typescript ];

  buildPhase = ''
    runHook preBuild
    mkdir -p source/managed-sessions
    cp config/agent/extensions/managed-sessions/contracts.ts source/managed-sessions/contracts.ts
    cp config/agent/extensions/managed-sessions/v2-contracts.ts source/managed-sessions/v2-contracts.ts
    cp config/agent/extensions/managed-sessions/checkpoint.ts source/managed-sessions/checkpoint.ts
    cp config/agent/extensions/managed-sessions/aloop-lifecycle.ts source/managed-sessions/aloop-lifecycle.ts
    cp -R config/agent/extensions/managed-sessions/relay source/managed-sessions/relay
    cat > tsconfig.json <<EOF
    {
      "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "strict": true,
        "skipLibCheck": true,
        "types": ["node"],
        "typeRoots": ["${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@types"],
        "baseUrl": ".",
        "paths": {
          "typebox": ["${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox"],
          "typebox/value": ["${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/value/index.d.mts"]
        },
        "rootDir": "source",
        "outDir": "lib"
      },
      "include": ["source/**/*.ts"]
    }
    EOF
    tsc --project tsconfig.json
    $CC -O2 -Wall -Wextra -Werror -o pi-managed-session-peer-uid \
      config/agent/extensions/managed-sessions/relay/peer-uid.c
    $CC -O2 -Wall -Wextra -Werror -o pi-managed-session-relay-lock \
      config/agent/extensions/managed-sessions/relay/relay-lock.c
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/node_modules" "$out/libexec" "$out/bin"
    cp -R lib/managed-sessions "$out/lib/managed-sessions"
    cp -R ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox "$out/lib/node_modules/typebox"
    cp pi-managed-session-peer-uid "$out/libexec/pi-managed-session-peer-uid"
    cp pi-managed-session-relay-lock "$out/libexec/pi-managed-session-relay-lock"
    cat > "$out/bin/pi-managed-session-relay" <<EOF
    #!${runtimeShell}
    export PI_MANAGED_SESSIONS_PEER_UID_HELPER="$out/libexec/pi-managed-session-peer-uid"
    export PI_MANAGED_SESSIONS_RELAY_LOCK_HELPER="$out/libexec/pi-managed-session-relay-lock"
    export PI_MANAGED_SESSIONS_IMAGE_NORMALIZER="${lib.getExe imagemagick}"
    exec ${lib.getExe nodejs} "$out/lib/managed-sessions/relay/main.js" "\$@"
    EOF
    chmod +x "$out/bin/pi-managed-session-relay"
    runHook postInstall
  '';

  meta = {
    description = "Host-local managed Pi session relay foundation";
    mainProgram = "pi-managed-session-relay";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
