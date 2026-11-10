# Verification

The repository exposes one deterministic verification interface:

```bash
nix run .#verify
```

The same deterministic checks are exported through `checks`, so `nix flake
check` runs them in CI and other standard Nix workflows. Checks consume the
immutable flake source snapshot; they do not depend on the caller's current
working directory and do not use credentials, network services, or live models.

## Deterministic checks

| Check | Contract |
| --- | --- |
| `bridge-chat` | Owner-only intake, real Pi SDK web-search-only sessions, shared existing-login locking, SQLite recovery, packaged worker and separated credential/unit contracts; live acceptance remains separate. |
| `bridge-chat-preflight` | Read-only credential-isolated diagnostic, bounded loopback HTTP, redaction and packaged service configuration pass; no live bridge acceptance is implied. |
| `chat-workspace` | Independent chat-only project execution and publication contracts pass; no managed-session authority is introduced. |
| `source-contracts` | Settings and profiles agree, referenced resources exist, retired resources stay absent, and adapter/RPC authority tripwires hold. |
| `schema-contracts` | Evaluation schemas are valid and their positive and negative fixtures have the expected lexical behavior. |
| `typescript-build` | Extension, evaluation, and test TypeScript compiles once into the shared test build used by every compiled TypeScript Node suite. |
| `unit-tests` | Ordinary Node tests plus native bridge, actual Pi/SDK, disposable tmux/Git, task/archive and offline migration scenarios pass. Legacy platform tests are removed with their features. |
| `pi-r-integration` | The packaged normal and local launchers preserve their Pi-R contracts. |
| `eval-self-test` | The fake-RPC synthetic evaluation laboratory passes in its sanitized environment. |
| `package-contracts` | Public packaged resources, executables, launcher identity, and important negative capability contracts hold. |
| `module-contracts` | Evaluated NixOS assertions, native/local-only launchers, runtime retention and removed-option refusal hold. |
| `verify` | Aggregate dependency over every deterministic check above. |

Build one check while developing with a single Nix invocation (replace the
system component on other platforms):

```bash
nix build .#checks.x86_64-linux.unit-tests
```

`nix run .#verify` is the only canonical invocation. It realizes one aggregate
build graph and prints the checks that passed; do not wrap it in a loop that
builds each named check separately. Nix builds independent checks in parallel,
reuses their outputs when inputs have not changed, and shares one TypeScript
compilation between the ordinary/native TypeScript, bridge-chat, and evaluation
suites. JavaScript package-contract probes run directly from source.
Ordinary/native TypeScript test files use bounded parallelism
while each file retains Node's normal in-file ordering. Bridge-chat and
evaluation files remain serial because they exercise process-global SDK,
sandbox, or Git environment state. These suite-level bounds prevent the
parallel Nix checks from oversubscribing the host with nested Node workers.

For an end-to-end timing measurement, time that same invocation rather than
running a separate build first:

```bash
time nix run .#verify
```

The local performance target is under one minute after the pinned toolchain
closure has been realized. A new machine or garbage-collected store may first
need to fetch the pinned Pi, Pi-R, AgentGraph, browser, image, Python, and NixOS
module dependencies; provision those through the configured binary caches
rather than weakening or duplicating the verification graph.

## Test classification

Test classification is name-based so a new test cannot compile without being
executed by a deterministic suite:

- `tests/test_bridge_chat_preflight.py` belongs to the bridge preflight check;
- `tests/bridge-chat-*.test.{ts,mts}` belong only to the bridge assistant check; `tests/matrix-shared.test.ts` belongs to unit-tests;
- `tests/eval-*.test.ts` belongs to the sanitized evaluation self-test;
- `tests/lsp-live.test.ts` belongs to the explicit live LSP gate;
- every other `tests/*.test.ts` belongs to the ordinary unit suite;
- `tests/bridge-*.test.mjs` (excluding `bridge-chat-*`) also belong to unit-tests:
  these exercise the packaged native Pi writer and disposable local tmux helper,
  require the real package paths, and must not silently skip.

Prompt expansion is exercised by the actual packaged-Pi native adapter suite.
Source-file existence is left to compilation and package checks, not duplicated
as a list of filenames. Offline migration fixtures are synthetic and mounted
kernel-read-only in a device-preserving test namespace; chmod or Nix-store file
ownership alone is not read-only evidence. No real histories enter the Nix store.

The removed managed-session suite was feature-specific to the deleted platform.
Shared renderer/checkpoint/HTTP and independent Aloop coverage remains, alongside
negative package/profile/tool/option checks and old-state/configuration refusal.
See [removal evidence](matrix-pi-removal.md) for disposition and both-repository
measurements. Native replacement tests do not prove legacy incidents repaired.

Do not add a hand-maintained test list. Give a specialized test the established
prefix, or let it run as an ordinary unit test. The TypeScript build includes all
test files before any suite runs.

## Live LSP verification

LSP changes additionally require:

```bash
nix run .#verify-lsp-live
```

This gate starts fake and real local language servers and is deliberately not a
dependency of the canonical deterministic aggregate. It does not use a model or
network endpoint, but it has a much larger runtime closure and platform/tooling
surface.

## Maintaining contracts

Prefer evidence in this order:

1. a behavioral test through the public interface;
2. a structured manifest or schema assertion;
3. a final-package existence or absence assertion;
4. an exact generated-text assertion only when starting the process would be
   long-lived or would cross an external side-effect seam.

Resource inclusion comes from `config/agent/profiles.json`. The source contract
checks that `settings.json`, profiles, and extension files agree; do not add one
verification assertion per extension. Keep negative credential and capability
checks explicit because absence is part of the package's security contract.

When a check fails, build that named check directly. Nix identifies the failing
derivation and preserves its build log; use `nix log <failed-drv>` for complete
output.
