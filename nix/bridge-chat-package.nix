{ pkgs, piPackage }:
let
  sdk = "${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent";
in pkgs.runCommand "pi-bridge-chat" { nativeBuildInputs = [ pkgs.typescript ]; } ''
  mkdir -p source
  cp -R ${../config/agent/extensions/bridge-chat} source/bridge-chat
  cp -R ${../config/agent/extensions/matrix-shared} source/matrix-shared
  cp -R ${../config/agent/extensions/web-search} source/web-search
  mkdir -p source/managed-sessions/adapter
  cp ${../config/agent/extensions/managed-sessions/adapter/artifact-export.ts} source/managed-sessions/adapter/artifact-export.ts
  cp ${../config/agent/extensions/managed-sessions/contracts.ts} source/managed-sessions/contracts.ts
  cp ${../config/agent/extensions/managed-sessions/v2-contracts.ts} source/managed-sessions/v2-contracts.ts
  cp ${../config/agent/extensions/managed-sessions/image-validation.ts} source/managed-sessions/image-validation.ts
  cat > tsconfig.json <<EOF
  {
    "compilerOptions": {
      "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
      "strict": true, "skipLibCheck": true, "types": ["node"],
      "typeRoots": ["${sdk}/node_modules/@types"],
      "baseUrl": ".", "paths": {
        "@earendil-works/pi-coding-agent": ["${sdk}/dist/index.d.ts"],
        "typebox": ["${sdk}/node_modules/typebox/build/index.d.mts"],
        "typebox/value": ["${sdk}/node_modules/typebox/build/value/index.d.mts"]
      },
      "rootDir": "source", "outDir": "lib"
    },
    "include": ["source/**/*.ts", "source/**/*.mts"]
  }
EOF
  tsc --project tsconfig.json
  mkdir -p "$out/bin" "$out/lib/node_modules/@earendil-works"
  cp -R lib/* "$out/lib/"
  ln -s ${sdk} "$out/lib/node_modules/@earendil-works/pi-coding-agent"
  ln -s ${sdk}/node_modules/typebox "$out/lib/node_modules/typebox"
  for role in model transport; do
    entry=main.js
    if [ "$role" = model ]; then entry=model-main.mjs; fi
    cat > "$out/bin/pi-chat-$role" <<EOF
#!${pkgs.runtimeShell}
unset NODE_OPTIONS NODE_PATH
exec ${pkgs.nodejs}/bin/node "$out/lib/bridge-chat/$entry" "\$@"
EOF
    chmod +x "$out/bin/pi-chat-$role"
  done
''
