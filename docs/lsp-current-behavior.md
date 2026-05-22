# Current Pi LSP Behavior And Failure Modes

This note records the behavior of the packaged `pi-lsp-extension` input used by
`pi-harness` before reliability patches are added. It is meant to keep the LSP
workstream focused on generic protocol plumbing and avoid hiding problems that
belong to each project environment.

## Harness Packaging Model

- `pi-harness` packages upstream `pi-lsp-extension` from the pinned flake input
  and applies only small Nix-time patches in `nix/pi-lsp-extension.nix`.
- When `services.pi-harness.lsp.enable` is set, `nix/module.nix` loads that
  extension with `--extension` and appends fallback language-server packages to
  `PATH`.
- The wrapper appends fallback packages after the caller's existing `PATH`.
  Project-local language servers from dev shells, `node_modules/.bin`, or other
  environment setup must keep shadowing harness fallbacks.
- The harness adds low-risk server mappings only for language-server commands
  already installed in the fallback LSP package set, such as `ocamllsp`, `nil`,
  `clangd`, `lua-language-server`, `bash-language-server`, `vscode-*`
  JSON/HTML/CSS servers, `yaml-language-server`, `docker-langserver`, `taplo`,
  `marksman`, and `terraform-ls`.
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
- File synchronization is tied to Pi tool results. Reads send `didOpen` only if
  a matching server is already running. Writes and edits ask for the file's
  client, which may start the server, then send `didOpen` or `didChange` only
  when a client is already ready.
- Diagnostics are cached from LSP publish events. `lsp_diagnostics` for one file
  reports the cache for that file; `path="*"` reports cached diagnostics across
  currently running servers.
- `lsp_symbols` has two modes: document symbols for a path and workspace symbol
  search for a query. The query mode currently asks the first running server and
  falls back to tree-sitter only if no usable LSP response is available.
- `/lsp` currently reports configured language, command, running state, cached
  diagnostic count, and whether a shared daemon appears alive. It does not show
  roots, advertised capabilities, starting/error details, or per-file sync state.

## Failure Modes To Fix In This Workstream

- Unopened document failures: file-scoped LSP requests can reach a ready server
  for a file that was never synchronized with `textDocument/didOpen`. Some
  servers respond with document-not-found or empty results even though the file
  exists on disk. The generic fix is to ensure file-scoped LSP tools open or
  refresh the target document before sending text-document requests.
- First-running-server workspace symbols: workspace symbol search currently uses
  the first running server. If that server has no useful project, lacks the
  capability, or fails the request, the whole LSP workspace search can fail even
  when another running server could answer. The generic fix is to query all
  suitable running servers and combine or clearly report results.
- Opaque status: agents cannot reliably tell which root a server owns, which
  capabilities it advertised, whether a server is starting versus failed, or
  which diagnostics are cached. The generic fix is richer status/capability and
  diagnostic context without requiring language-specific interpretation.

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
