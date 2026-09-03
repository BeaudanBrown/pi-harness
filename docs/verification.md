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
| `source-contracts` | Settings and profiles agree, referenced resources exist, retired resources stay absent, and adapter/RPC authority tripwires hold. |
| `schema-contracts` | Evaluation schemas are valid and their positive and negative fixtures have the expected lexical behavior. |
| `typescript-build` | Extension, evaluation, and test TypeScript compiles once into the shared test build. |
| `unit-tests` | Ordinary deterministic Node tests pass. |
| `managed-session-tests` | Relay, adapter, lifecycle, Matrix projection, and real-Pi managed-session integration tests pass. |
| `pi-r-integration` | The packaged normal and local launchers preserve their Pi-R contracts. |
| `eval-self-test` | The fake-RPC synthetic evaluation laboratory passes in its sanitized environment. |
| `package-contracts` | Public packaged resources, executables, launcher identity, and important negative capability contracts hold. |
| `module-contracts` | Evaluated NixOS module assertions and generated managed-session launcher capability contracts hold. |
| `prompt-expansion-contract` | The patched Pi runtime expands extension-injected prompt commands. |
| `verify` | Aggregate dependency over every deterministic check above. |

Build one check while developing with:

```bash
nix build .#checks.$(nix eval --raw --impure --expr builtins.currentSystem).unit-tests
```

`nix run .#verify` realizes the aggregate and prints the checks that passed.
Nix builds independent checks in parallel and reuses their outputs when their
inputs have not changed.

## Test classification

Test classification is name-based so a new test cannot compile without being
executed by a deterministic suite:

- `tests/eval-*.test.ts` belongs to the sanitized evaluation self-test;
- `tests/lsp-live.test.ts` belongs to the explicit live LSP gate;
- `tests/managed-session-*.test.ts` belongs to the managed-session suite;
- every other `tests/*.test.ts` belongs to the ordinary unit suite.

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
