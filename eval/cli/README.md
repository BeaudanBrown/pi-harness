# Synthetic evaluation CLI

The Nix apps expose the generic evaluation stack without adding a session or
endpoint manager.

## Offline self-test

```bash
nix run .#eval-self-test
```

This runs the synthetic contract, CLI, launcher, RPC, workspace, trace, metrics,
and grading suites serially with fake RPC processes. The app starts the tests
with an empty environment containing only an isolated `HOME`, temporary path,
tool `PATH`, and trusted Bubblewrap path. It never invokes a model, provider,
credential, endpoint, or network service. Canonical `nix run .#verify` invokes
this same app.

## Commands

```bash
nix run .#eval -- list --pack /path/to/pack.json --json
nix run .#eval -- run --live-model --pack /path/to/pack.json \
  --scenario SCENARIO --output /path/to/output --model provider/model-id
nix run .#eval -- suite --live-model --pack /path/to/pack.json \
  --suite SUITE --output /path/to/output --model provider/model-id
nix run .#eval -- report --output /path/to/output
```

`run` and `suite` refuse to proceed without the literal `--live-model` flag.
They use the packaged, provenance-verified `pi-r-local` launcher and inherit
provider configuration from the caller environment. They do not start,
health-check, or supervise an endpoint. Suite runs are deliberately sequential;
the live concurrency is one.

Each scenario keeps its materialized Git workspace, hidden evaluator channels,
launcher provenance, complete trace, raw RPC diagnostics, metrics, grading
evidence, `eval-run.json`, and bounded `cli-error.json` on infrastructure
failure. A grade failure exits 2; infrastructure/usage failures exit 1; success
exits 0. `report` writes deterministic `report.json` and `report.md` and uses the
same exit convention.

The output directory must be evaluator-owned and separate from the pack root.
No cleanup is automatic because retained partial artifacts are part of the
failure contract.
