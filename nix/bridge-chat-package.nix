{ pkgs, piPackage }:
let
  oauthModule = "${piPackage}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js";
in pkgs.runCommand "pi-bridge-chat" { } ''
  mkdir -p "$out/bin" "$out/lib"
  cp ${../scripts/bridge-chat-transport.py} "$out/lib/transport.py"
  cp ${../scripts/bridge-chat-model.mjs} "$out/lib/model.mjs"
  cat > "$out/bin/pi-chat-transport" <<EOF
#!${pkgs.runtimeShell}
exec ${pkgs.python3}/bin/python3 -I "$out/lib/transport.py" "\$@"
EOF
  cat > "$out/bin/pi-chat-model" <<EOF
#!${pkgs.runtimeShell}
set -eu
unset NODE_OPTIONS NODE_PATH
exec ${pkgs.nodejs}/bin/node "$out/lib/model.mjs" "\$1" "\$2" "\$3" ${oauthModule} "\$4"
EOF
  chmod +x "$out/bin/"*
  test -f ${oauthModule}
''
