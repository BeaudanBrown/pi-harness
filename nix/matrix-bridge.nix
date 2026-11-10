{ stdenvNoCC, lib, nodejs, python3, git, direnv, coreutils, runtimeShell, typescript, piPackage, nativeSessionLock, callPackage }:
let matrixMarkdown = callPackage ./matrix-markdown.nix { }; in
stdenvNoCC.mkDerivation {
  pname = "pi-matrix-bridge";
  version = "0.1.0";
  src = ../.;
  nativeBuildInputs = [ typescript ];
  buildPhase = ''
    runHook preBuild
    mkdir -p source
    cp -R config/agent/extensions/matrix-{bridge,shared} source/
    cat > tsconfig.json <<EOF
    {
      "compilerOptions": {
        "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
        "strict": true, "skipLibCheck": true, "types": ["node"],
        "typeRoots": ["${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@types"],
        "baseUrl": ".",
        "paths": {
          "@earendil-works/pi-coding-agent": ["${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"],
          "typebox": ["${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.d.mts"],
          "markdown-it": ["${matrixMarkdown}/lib/node_modules/@types/markdown-it/index.d.ts"],
          "markdown-it/*": ["${matrixMarkdown}/lib/node_modules/@types/markdown-it/*"]
        },
        "rootDir": "source", "outDir": "lib"
      },
      "include": ["source/matrix-bridge/main.ts", "source/matrix-bridge/task-worker.ts"]
    }
    EOF
    tsc --project tsconfig.json
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin" "$out/lib/node_modules"
    cp -R lib/. "$out/lib/"
    cp ${nativeSessionLock}/lib/session-lock.cjs "$out/lib/matrix-bridge/session-lock.cjs"
    cp config/agent/extensions/matrix-bridge/{local.py,task-git.py} "$out/lib/matrix-bridge/"
    substituteInPlace "$out/lib/matrix-bridge/task-worker.js" \
      --replace-fail '@taskGit@' '${lib.getExe git}' \
      --replace-fail '@taskPython@' '${lib.getExe python3}' \
      --replace-fail '@taskGitWaiter@' "$out/lib/matrix-bridge/task-git.py" \
      --replace-fail '@taskDirenv@' '${lib.getExe direnv}' \
      --replace-fail '@taskEnv@' '${lib.getExe' coreutils "env"}' \
      --replace-fail '@taskSessionManager@' '${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js'
    ln -s ${matrixMarkdown}/lib/node_modules/markdown-it "$out/lib/node_modules/markdown-it"
    ln -s ${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox "$out/lib/node_modules/typebox"
    cat > "$out/bin/pi-matrix-bridge" <<EOF
    #!${runtimeShell}
    exec ${lib.getExe nodejs} "$out/lib/matrix-bridge/main.js" "\$@"
    EOF
    cat > "$out/bin/pi-session" <<EOF
    #!${runtimeShell}
    exec ${lib.getExe python3} "$out/lib/matrix-bridge/local.py" "\$@"
    EOF
    cat > "$out/bin/pi-task-workspace" <<EOF
    #!${runtimeShell}
    exec ${lib.getExe nodejs} "$out/lib/matrix-bridge/task-worker.js" "\$@"
    EOF
    chmod +x "$out/bin/"*
    runHook postInstall
  '';
  meta = {
    description = "Optional Matrix bridge and relay-independent native Pi session helper";
    mainProgram = "pi-matrix-bridge";
    platforms = lib.platforms.linux;
  };
}
