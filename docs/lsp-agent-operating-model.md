# Agent-Facing LSP Operating Model

Pi's LSP tools are a protocol bridge for agents. They make language-server
responses easier to request and inspect, but they do not replace a correctly
configured project environment.

## Responsibility Boundary

- The project environment owns dependencies, SDKs, generated files, language
  server versions, and project configuration such as `tsconfig.json`,
  `pyproject.toml`, or `.pi-lsp.json`.
- The language server owns semantic answers: diagnostics, definitions,
  references, document symbols, and workspace symbols.
- The Pi extension owns generic protocol plumbing: starting configured servers,
  opening and refreshing documents before file-scoped requests, caching
  diagnostics, querying all running servers for workspace symbols, and reporting
  server status clearly.
- The harness provides fallback language-server binaries and low-risk mappings
  for common installed servers, but it does not install project packages, create
  manifests, infer language-specific roots, or hide missing dependency errors.

## Recommended Agent Workflow

1. Start from the project environment: enter the repo's dev shell or direnv
   first, then launch `pi` from the project root unless the repo documents a
   different root.
2. Read the file before using file-scoped LSP tools. The harness patches ensure
   file-scoped LSP requests open or refresh the target document, so the first
   LSP response may still be `starting`; retry shortly after startup.
3. Check `/lsp status` when answers look stale or unavailable. Use the reported
   server state, root, command, diagnostic counts, capabilities, last error, and
   setup hint to decide whether the server is ready or the project environment
   needs attention.
4. Prefer file-scoped semantic tools when the server advertises the matching
   capability, such as diagnostics, definitions, references, or document
   symbols for a known path.
5. Use workspace symbol search for cross-project navigation only after relevant
   servers are running. The harness queries all running servers and summarizes
   per-server successes or failures before falling back.
6. Fall back to `rg`, normal file reads, or tree-sitter results when no LSP
   server is configured, the server lacks the needed capability, startup is
   failing, or the project intentionally has incomplete semantic setup.

## Shadowing And Fallback Servers

When `services.pi-harness.lsp.enable` is enabled, the NixOS wrapper appends the
harness LSP packages after the caller's existing `PATH`. That order is the
shadowing guarantee:

- Project-local servers from `nix develop`, direnv, `node_modules/.bin`, virtual
  environments, or other repo setup take precedence.
- Harness-installed servers are fallbacks only, used when the active project
  environment does not provide a matching command first.
- Project-owned `.pi-lsp.json` commands remain the right place for explicit
  server overrides.

The current fallback set includes common servers such as TypeScript,
Python/Ruff, Rust, Go, Nix, OCaml, C/C++, Lua, Markdown, TOML, YAML, JSON,
HTML/CSS, Bash, Dockerfile, Terraform, and Tailwind where those commands are
packaged by the harness. These fallbacks improve availability; they do not make
an unconfigured repository semantically complete.

## Project-Owned Problems To Report, Not Solve

Agents should treat these as project setup findings rather than harness bugs:

- TypeScript `No Project`, missing `tsconfig.json`/`jsconfig.json`, or a server
  root that does not include the file.
- Missing Node types, unresolved imports, missing declaration files, absent SDKs,
  or generated files that the repo has not produced.
- Language server commands missing from the active environment when neither the
  project nor the harness fallback set provides them.
- Diagnostics caused by intentionally partial checkouts or dependency installs.

Good next actions are to tell the user what the server reported, recommend
launching Pi from the project dev shell/root, or point to project-owned config
or dependency installation. Do not run package managers, generate project
configs, or change manifests unless the user or ticket explicitly asks for that
project-specific fix.

## When To Use Non-LSP Search

Use `rg`, direct reads, and tree-sitter-style structural search when:

- You need fast textual evidence before semantic context is ready.
- The language server is still starting and the task can proceed safely from
  source inspection.
- `/lsp status` shows no relevant server, no advertised capability, or a startup
  error that belongs to project setup.
- Workspace symbol output reports per-server failures or empty results and a
  text search is more reliable for the current question.

LSP answers are strongest when the repo has already provided its own working
language environment. The harness makes that state visible and dependable for
agents, but it intentionally stays a thin generic bridge.
