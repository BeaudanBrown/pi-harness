# Current Pi LSP Behavior And Failure Modes

This note records the behavior of the packaged `pi-lsp-extension` input used by
`pi-harness` after the local reliability patches are applied. It is meant to
keep the LSP workstream focused on generic protocol plumbing and avoid hiding
problems that belong to each project environment.

## Harness Packaging Model

- `pi-harness` packages upstream `pi-lsp-extension` from the pinned flake input
  and applies only small Nix-time patches in `nix/pi-lsp-extension.nix`.
- When `services.pi-harness.lsp.enable` is set, `nix/module.nix` loads that
  extension with `--extension` and appends fallback language-server packages to
  `PATH`.
- The wrapper appends fallback packages after the caller's existing `PATH`.
  Project-local language servers from dev shells, `node_modules/.bin`, or other
  environment setup must keep shadowing harness fallbacks.
- The harness adds low-risk server mappings for common language-server commands
  expected to be provided either by the project environment or by the fallback
  LSP package set. Haskell maps to `haskell-language-server-wrapper --lsp` so
  project GHC/HLS versions on the caller's `PATH` can be used without a
  project `.pi-lsp.json`. Fallback-packaged mappings include commands such as
  `ocamllsp`, `nil`, `clangd`, `lua-language-server`,
  `bash-language-server`, `vscode-*` JSON/HTML/CSS servers,
  `yaml-language-server`, `docker-langserver`, `taplo`, `marksman`, and
  `terraform-ls`.
- These fallback mappings do not change command precedence: project-local
  servers on the caller's `PATH` still shadow the harness packages because the
  wrapper appends fallback packages after the existing `PATH`.
- The harness may add low-risk server mappings for already-installed servers,
  but it should not implement language-specific project discovery or dependency
  installation.

## Current Runtime Behavior

- LSP servers start lazily. Most file-scoped tools call `getClientForFile`; the
  first call starts the server in the background and returns an unavailable or
  starting message instead of waiting for readiness.
- File-scoped LSP requests ensure the target document is open on the active
  server before sending the request. The sync layer tracks stable server
  identities so reconnecting to the same daemon does not send duplicate
  `didOpen`, and it sends `didChange` when file content changed since the last
  sync.
- Diagnostics are cached from LSP publish events. `lsp_diagnostics` for one file
  reports the cache for that file; `path="*"` reports cached diagnostics across
  currently running servers.
- `lsp_symbols` has two modes: document symbols for a path and workspace symbol
  search for a query. Query mode asks all running servers that do not explicitly
  lack workspace-symbol capability, applies a per-server timeout, returns
  partial results with warnings, and falls back to tree-sitter when useful.
- `/lsp` reports configured language, command, args, running/starting/stopped
  state, root, cached diagnostic count/files, advertised capabilities, shared
  daemon state, last startup error, and setup hints.

## Fixed Failure Modes

- Unopened document failures: file-scoped LSP requests now open or refresh the
  target document before sending text-document requests.
- Duplicate daemon `didOpen`: document sync now keys state by stable server
  identity instead of transient client object identity.
- First-running-server workspace symbols: workspace symbol search now queries all
  suitable running servers and reports partial failures instead of failing
  globally on the first bad server.
- Opaque status: `/lsp` now exposes root, command args, state, capability,
  diagnostics, shared-daemon, last-error, and setup-hint context.

## Failures To Report Honestly, Not Hide

- TypeScript "No Project" is usually a project configuration signal: the server
  did not find a `tsconfig.json`/`jsconfig.json` or was launched from an
  unsuitable root. The harness should surface this clearly, not invent a project
  file or guess roots beyond generic workspace/root handling.
- Missing TypeScript dependencies, missing SDKs, or unresolved imports are owned
  by the project environment. The harness may make fallback tools available on
  `PATH`, but it should not run package managers, install dependencies, or patch
  project manifests.
- A language server missing from the active environment should be reported as a
  command/startup failure. The project can provide its own server through the
  dev shell or `.pi-lsp.json`; harness packages are only fallbacks.

## Non-Goals

- Do not add custom dependency resolvers, `npm install` behavior, or per-language
  package-manager logic.
- Do not prefer harness language servers over project-local ones.
- Do not fork `pi-lsp-extension` until the patch stack is large enough to make
  local Nix-time substitutions hard to review.
- Do not guarantee semantic diagnostics for projects whose language server can
  start but whose project configuration is incomplete.

## Intended Fix Boundary

The near-term fixes should be generic and protocol-level: document sync before
file-scoped requests, multi-server workspace queries, clearer status output,
additional low-risk mappings for installed servers, and honest startup/config
failure messages. Project-specific dependency and configuration correctness
remain the responsibility of the repository being edited.
