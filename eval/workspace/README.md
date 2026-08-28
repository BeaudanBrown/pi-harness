# Confined synthetic workspace materialization

`materializeEvalRun()` is the public seam for issue #28. It loads one v1 eval
pack, resolves every declared pack/scenario reference beneath the canonical pack
root, validates synthetic provenance, and creates one evaluator-owned run:

```text
pi-eval-workspace-XXXXXX/   model-visible Git repository (separate temp root)
run-XXXXXX/
  hidden/                   oracle and synthetic provenance manifest
  generated/                generator channels, when applicable
  evidence/                 inventories, Git evidence, logs, or failure details
```

The returned `workspaceRoot` is the only directory passed to evaluated work and
is a separate sibling under the configured `.pi/tmp/evals/` runs root, not an
ancestor or descendant of the evaluator artifact root. Direct parent traversal
therefore cannot use a fixed `../hidden` path to reach oracle, generated,
provenance, or evidence channels. Those paths are returned separately for evaluator use; process-level
filesystem sandboxing remains the launcher's responsibility.
Fixture symlinks are accepted only when their canonical targets remain inside
the pack; copied workspace material contains no symlinks. Canonical paths and
filesystem identities and file-content fingerprints are checked so symlinks,
hard links, and byte-for-byte copies cannot expose hidden evaluator channels. Imported root `.git` metadata is rejected, and Git
runs with isolated configuration and an empty template. Generator outputs are
accepted only after their question, provenance identity, data hash, and oracle
hash match the scenario exactly.

Callers execute evaluated work through `withWorkspaceEvidence()`, which always
captures after-state in a `finally` path on success, timeout, or failure.
Inventories record symlinks without following them and retain independently
available Git evidence if another evidence channel fails. `captureAfter()`
remains available for explicit non-execution snapshots. Both
successful and failed materialization retain the run by default so diagnostics
remain available. Explicit `cleanup()` removes the complete run after the
caller has finished retaining or inspecting evidence.

Generators execute in a platform sandbox (Bubblewrap on Linux and
`sandbox-exec` on macOS) with read-only access to the synthetic pack, Nix
store, and narrowly required macOS system libraries plus write access only to
their fresh output root. Linux accepts only a canonically resolved Nix-store
Bubblewrap binary, not an ambient executable override. They receive only `PATH`,
`PI_EVAL_OUTPUT_ROOT`, and `PI_EVAL_SEED` in the environment. Arguments are
restricted to scalar values/flags without path separators, traversal tokens, or
URI schemes; generator inputs must be embedded synthetic pack content. Their declared
run deadline is enforced with process-group termination. Nonzero exits and
timeouts retain structured stdout/stderr and partial generated channels.

All fixtures and tests for this module are wholly synthetic and offline.
