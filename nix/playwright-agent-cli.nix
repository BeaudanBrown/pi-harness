{
  lib,
  buildNpmPackage,
  fetchFromGitHub,
  makeWrapper,
  chromium,
  runtimeShell,
}:

buildNpmPackage rec {
  pname = "playwright-agent-cli";
  version = "0.1.17";

  src = fetchFromGitHub {
    owner = "microsoft";
    repo = "playwright-cli";
    rev = "v${version}";
    hash = "sha256-tc/2Qck3mm6BqWTu2lvvfsM0/BHO/Z0ZvCdFZ7QQqKI=";
  };

  npmDepsHash = "sha256-u44jWprmr3RdzB3aDL3K0ShT5lLxr175z3C8pN43YFA=";
  dontNpmBuild = true;
  nativeBuildInputs = [ makeWrapper ];

  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

  postInstall = ''
        wrapProgram "$out/bin/playwright-cli" \
          --set NO_UPDATE_NOTIFIER 1 \
          --set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 1 \
          --set PLAYWRIGHT_MCP_BROWSER chromium \
          --set PLAYWRIGHT_MCP_EXECUTABLE_PATH ${lib.getExe chromium} \
          --set PLAYWRIGHT_MCP_HEADLESS true \
          --set PLAYWRIGHT_MCP_ISOLATED true \
          --unset PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS

        cat > "$out/bin/playwright-cli-fallback" <<EOF
    #!${runtimeShell}
    set -euo pipefail
    cache_home="\''${XDG_CACHE_HOME:-\$HOME/.cache}"
    export PLAYWRIGHT_MCP_OUTPUT_DIR="\''${PLAYWRIGHT_MCP_OUTPUT_DIR:-\$cache_home/pi-harness/playwright/fallback}"
    mkdir -p "\$PLAYWRIGHT_MCP_OUTPUT_DIR"
    exec "$out/bin/playwright-cli" "\$@"
    EOF
        chmod +x "$out/bin/playwright-cli-fallback"
  '';

  meta = {
    description = "Nix-pinned Playwright Agent CLI with an isolated Chromium fallback";
    homepage = "https://github.com/microsoft/playwright-cli";
    license = lib.licenses.asl20;
    mainProgram = "playwright-cli-fallback";
    platforms = lib.platforms.linux;
  };
}
