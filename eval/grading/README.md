# Deterministic scenario grading

`executeCaptureAndGradeScenario()` is the production lifecycle seam: it runs the
RPC operation, stops and captures complete trace/workspace evidence, then calls
`gradeScenario()` with the oracle path owned by that materialized workspace
through a materializer-owned weak identity. It likewise grades only the
materialized scenario's version-validated assertion declarations. The
production interface accepts neither independent oracle nor assertion
overrides and ignores mutation of the public oracle-path field. The lower-level `gradeScenario()` evaluates every declared
assertion in order for already-captured evidence. Neither uses an LLM judge. Inputs are immutable trace metrics/records, final assistant text,
workspace before/after evidence, a model-visible workspace root, and a separate
hidden oracle reference produced by materialization.

## Assertions

The grader implements the base v1 assertion contract plus scenario v3's
versioned stale-tool and blocked-attempt additions:

- required/forbidden tools, forbidden stale tool names, and maximum blocked,
  tool-call, error, and turn counts;
- final response `equals`, `contains`, or Unicode-regex `matches`;
- lstat-aware file existence with full canonical target/ancestor checks
  (final or intermediate dangling/escaping symlinks fail), absence, unchanged signatures, and text comparisons;
- protected-path subtree inventory equality, existence/absence, deterministic
  recursive content snapshots, and clean/dirty Git state;
- deterministic grader commands;
- hidden oracle equality as raw bytes, text, or parsed JSON;
- unexpected extension-UI request count.

For protected directories, content operators use stable JSON mapping each
byte-sorted descendant file path (relative to the protected root) to its UTF-8
content; file protected paths use their content directly.

Oracle values are read only from the evaluator-owned hidden channel and compared
directly with observable workspace output. Model-produced code is never used to
compute expected values. Directory oracles map an assertion's full relative
workspace path beneath the canonical oracle root.

## Evidence and failure behavior

All assertions run even after earlier failures. After grading, the integrated
lifecycle rewrites `metrics.json` and `trace-result.json` with the observed
failed grader-command count so trace metrics and `grade.json` remain consistent. Each failure points to
`grade-evidence/<assertion-id>.json`, which records expected/actual values,
relevant zero-based raw trace event indexes, and exact workspace paths.
`grade.json` is stable, declaration-ordered, and validates as the grade portion
of the run-result contract.

Assertion evaluation errors (invalid regex, missing comparison target, malformed
JSON, or filesystem failure) become assertion failures rather than aborting the
grade. Evidence contains hashes—not hidden oracle content—when an oracle
comparison fails.

## Grader-command sandbox

Commands are argv arrays executed without a shell through
`runConfinedWorkspaceCommand()`. The workspace is mounted read-only; host files,
network access, and writes are denied. Linux uses a trusted canonical Nix-store
Bubblewrap binary and its fresh tmpfs root exposes only explicit Nix-store,
workspace, `/tmp`, `/proc`, and `/dev` mounts; an external-file regression test
proves the inherited host root is not visible. macOS uses a narrowed
`sandbox-exec` profile that prohibits
child-process forking so detached descendants cannot escape cleanup. Commands
are bounded to 30 seconds by default (with a validated per-run override), capture stdout/stderr/exit evidence on failure, and cannot
access the hidden oracle.

Tests use only fabricated workspaces, traces, outputs, oracles, and external-file
sentinels. They are offline and require no model or endpoint.
