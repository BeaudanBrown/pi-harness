{
  buildNpmPackage,
  lib,
  piLspExtensionSrc,
  writeText,
  applyPatches,
}:

let
  packageLock = writeText "pi-lsp-extension-package-lock.json" ''
    {
      "name": "pi-lsp-extension",
      "version": "1.2.1",
      "lockfileVersion": 3,
      "requires": true,
      "packages": {
        "": {
          "name": "pi-lsp-extension",
          "version": "1.2.1",
          "license": "MIT",
          "dependencies": {
            "tree-sitter-wasms": "^0.1.13",
            "typebox": "^1.1.38",
            "vscode-languageserver-protocol": "^3.17.5",
            "web-tree-sitter": "^0.24.7"
          }
        },
        "node_modules/tree-sitter-wasms": {
          "version": "0.1.13",
          "resolved": "https://registry.npmjs.org/tree-sitter-wasms/-/tree-sitter-wasms-0.1.13.tgz",
          "integrity": "sha512-wT+cR6DwaIz80/vho3AvSF0N4txuNx/5bcRKoXouOfClpxh/qqrF4URNLQXbbt8MaAxeksZcZd1j8gcGjc+QxQ==",
          "license": "Unlicense",
          "dependencies": {
            "tree-sitter-wasms": "^0.1.11"
          }
        },
        "node_modules/typebox": {
          "version": "1.1.38",
          "resolved": "https://registry.npmjs.org/typebox/-/typebox-1.1.38.tgz",
          "integrity": "sha512-pZ0aQPmMmXoUvSbeuWf/Hzsc+avNw/Zd6VeE8CFgkVGWyuHPJvqeJJDeJqLve+K70LvjYIoleGcoJHPT17cWoA==",
          "license": "MIT"
        },
        "node_modules/vscode-jsonrpc": {
          "version": "8.2.0",
          "resolved": "https://registry.npmjs.org/vscode-jsonrpc/-/vscode-jsonrpc-8.2.0.tgz",
          "integrity": "sha512-C+r0eKJUIfiDIfwJhria30+TYWPtuHJXHtI7J0YlOmKAo7ogxP20T0zxB7HZQIFhIyvoBPwWskjxrvAtfjyZfA==",
          "license": "MIT",
          "engines": {
            "node": ">=14.0.0"
          }
        },
        "node_modules/vscode-languageserver-protocol": {
          "version": "3.17.5",
          "resolved": "https://registry.npmjs.org/vscode-languageserver-protocol/-/vscode-languageserver-protocol-3.17.5.tgz",
          "integrity": "sha512-mb1bvRJN8SVznADSGWM9u/b07H7Ecg0I3OgXDuLdn307rl/J3A9YD6/eYOssqhecL27hK1IPZAsaqh00i/Jljg==",
          "license": "MIT",
          "dependencies": {
            "vscode-jsonrpc": "8.2.0",
            "vscode-languageserver-types": "3.17.5"
          }
        },
        "node_modules/vscode-languageserver-types": {
          "version": "3.17.5",
          "resolved": "https://registry.npmjs.org/vscode-languageserver-types/-/vscode-languageserver-types-3.17.5.tgz",
          "integrity": "sha512-Ld1VelNuX9pdF39h2Hgaeb5hEZM2Z3jUrrMgWQAu82jMtZp7p3vJT3BzToKtZI7NgQssZje5o0zryOrhQvzQAg==",
          "license": "MIT"
        },
        "node_modules/web-tree-sitter": {
          "version": "0.24.7",
          "resolved": "https://registry.npmjs.org/web-tree-sitter/-/web-tree-sitter-0.24.7.tgz",
          "integrity": "sha512-CdC/TqVFbXqR+C51v38hv6wOPatKEUGxa39scAeFSm98wIhZxAYonhRQPSMmfZ2w7JDI0zQDdzdmgtNk06/krQ==",
          "license": "MIT"
        }
      }
    }
  '';
in
buildNpmPackage {
  pname = "pi-lsp-extension";
  version = "1.2.1";
  src = applyPatches {
    name = "pi-lsp-extension-patched-src";
    src = piLspExtensionSrc;
    patches = [
      ../patches/pi-lsp-extension-document-sync.patch
      ../patches/pi-lsp-extension-status-reporting.patch
      ../patches/pi-lsp-extension-setup-guidance.patch
      ../patches/pi-lsp-extension-language-server-mappings.patch
      ../patches/pi-lsp-extension-workspace-symbols-all-servers.patch
      ../patches/pi-lsp-extension-document-sync-hardening.patch
      ../patches/pi-lsp-extension-workspace-symbols-hardening.patch
      ../patches/pi-lsp-extension-language-mapping-hardening.patch
    ];
  };
  npmDepsHash = "sha256-j0BEIgsM9pUL56lE5JdJrlFW8jjZkkrox2KB8VRFLgE=";
  dontNpmBuild = true;

  postPatch = ''
    cp ${packageLock} package-lock.json
    substituteInPlace src/shared/language-map.ts \
      --replace-fail '  ".rs": "rust",' $'  ".rs": "rust",\n  ".hs": "haskell",\n  ".lhs": "haskell",\n  ".ml": "ocaml",\n  ".mli": "ocaml",'
    substituteInPlace src/lsp-manager.ts \
      --replace-fail '  rust: { command: "rust-analyzer", args: [] },' $'  rust: { command: "rust-analyzer", args: [] },\n  haskell: { command: "haskell-language-server-wrapper", args: ["--lsp"] },\n  ocaml: { command: "ocamllsp", args: [] },'
    substituteInPlace src/tools/*.ts \
      --replace-fail '@sinclair/typebox' 'typebox'
    cat > package.json <<'JSON'
    {
      "name": "pi-lsp-extension",
      "version": "1.2.1",
      "type": "module",
      "description": "Pi coding agent extension for LSP integration",
      "license": "MIT",
      "pi": {
        "extensions": ["./src/index.ts"]
      },
      "dependencies": {
        "tree-sitter-wasms": "^0.1.13",
        "typebox": "^1.1.38",
        "vscode-languageserver-protocol": "^3.17.5",
        "web-tree-sitter": "^0.24.7"
      }
    }
    JSON
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/pi-lsp-extension"
    cp -R . "$out/share/pi-lsp-extension/"
    runHook postInstall
  '';

  meta = {
    description = "Pi coding-agent LSP extension packaged without Pi's npm installer";
    homepage = "https://github.com/samfoy/pi-lsp-extension";
    license = lib.licenses.mit;
  };
}
