# Handoff: publish the synthetic Pi evaluation laboratory epic

## Purpose of this document

A fresh agent started from the `pi-harness` checkout should use this document to create one GitHub epic and its native sub-issues in `BeaudanBrown/pi-harness`. GitHub Issues are the source of truth; this document is only a publication handoff and may be removed after the issue graph has been published and reconciled.

Use the typed GitHub issue tools, not `gh` through Bash. Inspect existing issues first, validate the complete plan with `apply: false`, review it, then publish with `apply: true`. Use native sub-issue and blocker relationships. Do not create issues in another repository from the pi-harness checkout.

Suggested stable issue-plan key:

```text
synthetic-agent-eval-lab-v1
```

## Settled product decisions

These are requirements, not open questions.

1. The generic evaluation engine belongs in `pi-harness` because this repository owns Pi packaging, normal/lean launchers, model/provider wiring, and RPC integration.
2. The LLM endpoint is assumed to be available. Do not build endpoint startup, service supervision, health polling, model download, or model management into this epic.
3. Evaluations use only completely synthetic datasets and fabricated research questions.
4. The existing SHHS data is real and must never be used, copied, sampled, profiled, summarized, referenced by path, or reproduced in fixtures or traces.
5. Do not copy SHHS schemas, field names, distributions, coding dictionaries, or research questions into synthetic scenarios.
6. Synthetic scenarios should span unrelated fictional domains so improvements do not overfit one analysis shape.
7. The evaluation engine is generic. Project-specific scenario packs, fixtures, generators, and expected oracles remain owned by the evaluated project.
8. The first project integration is pi-r, but the engine must also be reusable for other harness extensions and workflows.
9. Pi must be driven through RPC mode in a separate process. Use strict LF-delimited JSONL framing; do not use Node `readline`, which also splits Unicode line separators.
10. Prompt completion waits for `agent_settled`, not only `agent_end`.
11. Extension UI confirmations are denied by default and may be approved only when a scenario declares the exact expected dialog policy.
12. Live-model evaluation is opt-in and is never part of the canonical deterministic `nix run .#verify` gate.
13. The eval engine itself must have complete offline tests using a fake RPC process.
14. Raw traces, thinking content, temporary workspaces, and session artifacts remain ignored local outputs.
15. Deterministic aggregate baseline summaries may be committed when deliberately promoted.
16. Initial grading is deterministic. Do not add an LLM judge in the first epic.
17. Default live-eval concurrency is one so a local GPU endpoint is not overloaded.
18. Runs require bounded prompt and whole-run timeouts, process-tree cleanup, and retained diagnostics on failure.
19. The runner must prove which Pi, harness, model, scenario, fixture, and candidate project revisions were evaluated.
20. Current-checkout project evaluation must not silently use the deployed or locked package instead of the candidate checkout.

## Intended ownership split

### pi-harness

Owns:

- generic eval CLI;
- strict Pi RPC client;
- process lifecycle and timeouts;
- extension UI request handling;
- synthetic workspace materialization contract;
- generic scenario and result schemas;
- trace capture;
- generic metrics;
- generic assertion engine;
- repeated runs and comparisons;
- Markdown/JSON reporting;
- Nix apps and offline fake-RPC tests;
- launcher provenance and candidate-input verification.

### pi-r

Eventually owns a companion eval pack containing:

- pi-r-specific synthetic scenario declarations;
- deterministic fabricated dataset generators;
- hidden expected-result oracles;
- pi-r-specific suite definitions;
- selected aggregate baseline summaries;
- a flake/resource path exposing the pack if needed.

Any pi-r code change must be tracked by a pi-r GitHub issue created from a separate pi-r checkout. The pi-harness epic may contain a coordination sub-issue, but it must not become the sole task record for pi-r code changes.

### local-llm or nix-dotfiles

Only supplies host-owned model/provider configuration if needed. No scenario semantics, eval engine, datasets, or grading logic belongs there. The endpoint itself is assumed available.

## Target operator interface

The final naming can be refined in the architecture issue, but the intended capabilities are:

```console
nix run .#eval -- list --pack <path>
nix run .#eval -- run <scenario> --pack <path>
nix run .#eval -- suite <suite> --pack <path> --repeat 3 --label candidate
nix run .#eval -- compare baseline candidate
nix run .#eval -- report candidate
nix run .#eval-self-test
```

The offline self-test may be included in `nix run .#verify`. The live `.#eval` app must never be invoked by the canonical gate.

## Proposed architecture

```text
Eval CLI
  -> scenario/pack loader
  -> synthetic workspace builder
  -> configurable packaged Pi launcher
  -> Pi RPC subprocess
  -> raw command/event trace
  -> generic metrics
  -> deterministic scenario assertions
  -> run report
  -> repeated-run comparison
```

The runner creates one isolated temporary Git repository per run. It launches Pi with that repository as `cwd`, sends prompts, waits for settlement, gathers final RPC state, terminates the process, captures the workspace diff, grades the run, and preserves artifacts.

## Eval-pack contract

A project-owned pack should contain a structure similar to:

```text
evals/
├── pack.json
├── scenarios/
├── suites/
├── fixtures/
├── generators/
└── baselines/
```

A scenario declares:

- stable ID and schema version;
- synthetic fixture or deterministic generator;
- scenario variant/seed;
- fabricated research question and prompt sequence;
- prompt and run timeouts;
- extension UI response policy;
- required and forbidden tool behavior;
- expected file/Git effects;
- deterministic grader commands or expected oracle references;
- expected final observable outcomes.

The pack loader must resolve every referenced path beneath the canonical pack root. It must reject traversal, symlink escape, arbitrary external fixture paths, and attached real-data roots.

## Synthetic dataset rules

Every generated dataset must include provenance metadata containing:

- `synthetic: true`;
- generator ID and version;
- random seed;
- scenario variant ID;
- row count;
- data content hash;
- expected-oracle hash.

The generator produces two separate outputs:

1. workspace data and the fabricated question, visible to the model;
2. expected results/oracle, retained by the evaluator and not copied into the model workspace.

The grader must compute expected values independently from model-produced code. Scenario variants should be reproducible by seed. Include several unrelated fictional domains such as manufacturing quality, ecological surveys, fictional education outcomes, equipment maintenance, synthetic retail cohorts, or environmental sensors.

## Run artifacts

Each run should retain:

```text
run/
├── manifest.json
├── commands.jsonl
├── events.jsonl
├── stderr.log
├── messages.json
├── entries.json
├── session-stats.json
├── final-response.md
├── workspace-before.json
├── workspace-after.json
├── workspace.diff
├── metrics.json
├── grade.json
└── report.md
```

Store local outputs under `.pi/tmp/evals/` or another explicitly ignored harness-owned location.

The manifest records:

- scenario ID/version/hash;
- pack hash;
- generator version and seed;
- fixture/data hash;
- expected-oracle hash;
- pi-harness commit and dirty state;
- evaluated project/package commit and dirty state;
- Pi version;
- model provider and ID;
- thinking level;
- context window and maximum output tokens when available;
- launcher identity;
- machine system;
- timeout policy;
- timestamps and run label.

Sensitive environment values must never appear in manifests or reports.

## Generic metrics

### Reliability

- scenario pass/fail;
- process exit status;
- timeout count;
- extension error count;
- tool error count;
- non-retryable error count;
- truncated completion count;
- whether `agent_settled` was reached.

### Efficiency

- wall-clock duration;
- time to first tool call;
- time to first scenario-defined useful tool call;
- agent turns;
- total and unique tool calls;
- repeated identical tool calls;
- tool calls before first useful action;
- input/output/cache/total tokens when reported;
- peak context usage;
- compaction count;
- final-response length.

### Tool behavior

- required tools used;
- forbidden tools used;
- blocked attempts;
- stale/deprecated tool names;
- repeated failed calls;
- unexpected authority-changing commands;
- unexpected extension confirmations.

### Workspace behavior

- expected files created or changed;
- protected files unchanged;
- expected signatures preserved;
- expected tests or notes created;
- Git status and commits;
- deterministic grader command results;
- generated infrastructure unchanged.

Do not automatically score scientific prose with another model in the initial implementation.

## RPC requirements

The RPC module must:

- spawn a separate process;
- implement strict LF-only JSONL parsing with partial-buffer support;
- preserve Unicode separators inside JSON strings;
- correlate command IDs and responses;
- record all events before interpretation;
- wait for `agent_settled` after accepted prompts;
- handle retries and compaction events;
- respond to declared extension UI requests;
- deny undeclared dialogs;
- retrieve state, messages, entries, session stats, and final assistant text;
- enforce prompt and whole-run deadlines;
- abort and terminate the entire process tree on timeout or cancellation;
- retain stderr and partial traces after malformed output or crash.

The offline fake RPC process must exercise normal settlement, split records, Unicode separators, UI dialogs, malformed records, retries, compaction, timeout, crash, stderr noise, and truncated completion.

## Current-checkout evaluation

The launcher work must provide a reproducible way to evaluate a candidate project checkout rather than the deployed package. For pi-r development, the intended mechanism is a pi-harness build with its `pi-r` flake input overridden to the candidate checkout. The exact CLI should be documented and tested.

Conceptually:

```console
nix run \
  --override-input pi-r path:/path/to/pi-r \
  path:/path/to/pi-harness#eval \
  -- suite core --pack /path/to/pi-r/evals
```

The run manifest and startup preflight must prove that the candidate pi-r revision/resource identity is active. Merely accepting an override argument is insufficient.

## Suggested issue graph

Create one parent epic and the following native sub-issues. Use stable issue-plan keys shown in parentheses. Apply `enhancement` to all. Apply `ready-for-agent` only to issue 1 initially; blocked children should not receive a ready lifecycle label until their blockers close and their specifications remain valid.

### Parent epic (`epic`)

**Title:** Epic: Build a synthetic Pi agent evaluation laboratory

**Body requirements:**

- Explain the reusable Pi RPC evaluation laboratory.
- State the strict synthetic-only rule and explicit SHHS prohibition.
- State that the endpoint is assumed available.
- State the pi-harness/pi-r/local-host ownership split.
- List success criteria and link all native sub-issues.
- State that live evals are opt-in and canonical verification remains offline.

### Issue 1 (`contracts`)

**Title:** Define synthetic eval-pack, scenario, result, and provenance contracts

**Labels:** `enhancement`, `ready-for-agent`

**Scope:**

- Write the architecture decision and terminology.
- Define JSON schemas for packs, scenarios, prompts, UI policies, assertions, run results, metrics, and comparisons.
- Define path confinement and synthetic provenance rules.
- Define ignored versus committable artifacts.
- Define generic/project-specific seams.

**Acceptance:**

- Schemas validate representative valid and invalid fixtures.
- External paths, traversal, symlink escapes, and missing `synthetic: true` metadata fail.
- Endpoint startup/health management and LLM judging are explicit non-goals.
- The design preserves pi-harness as a thin reusable layer rather than embedding pi-r semantics.

### Issue 2 (`rpc-engine`)

**Title:** Implement the strict Pi RPC subprocess engine

**Blocked by:** `contracts`

**Scope:**

- Strict LF JSONL parser.
- Command correlation.
- Event recording.
- `agent_settled` lifecycle.
- timeout/abort/process-tree cleanup.
- stderr and partial-trace retention.
- extension UI request protocol with default denial.

**Acceptance:**

- Offline fake-process tests cover all RPC failure and lifecycle cases listed above.
- No Node `readline` usage.
- Hanging children are bounded and cleaned up.
- Diagnostics survive every failure.

### Issue 3 (`workspace`)

**Title:** Implement confined synthetic workspace and eval-pack materialization

**Blocked by:** `contracts`

**Scope:**

- Canonical pack-root resolution.
- Deterministic fixture/generator execution.
- hidden oracle separation.
- isolated temporary Git repository per run.
- before/after workspace inventory and diff.
- synthetic provenance manifest.

**Acceptance:**

- Only declared synthetic pack content reaches the workspace.
- External files and attachments are rejected.
- Generator seed reproduces identical data and oracle hashes.
- Oracle data is absent from model-visible workspace.

### Issue 4 (`launcher`)

**Title:** Add current-checkout Pi launcher and runtime provenance verification

**Blocked by:** `contracts`, `rpc-engine`

**Scope:**

- Launch packaged Pi/lean pi-r through RPC.
- Inherit configured model/provider environment.
- Assume endpoint availability; do not supervise it.
- support candidate flake-input overrides.
- verify active model, Pi version, harness revision, extension/resource identity, and evaluated project revision.

**Acceptance:**

- A test proves candidate pi-r resources are used instead of the deployed lock.
- Mismatched active resources fail before scenario prompts.
- Launcher arguments and manifests redact sensitive values.
- Default concurrency is one.

### Issue 5 (`trace-metrics`)

**Title:** Capture eval traces and compute deterministic reliability and efficiency metrics

**Blocked by:** `rpc-engine`

**Scope:**

- raw command/event/stderr capture;
- final RPC state capture;
- metrics listed in this handoff;
- stable JSON result format;
- bounded human-readable run summary.

**Acceptance:**

- Metrics are derived deterministically from fixture traces.
- Raw events remain unchanged and available for drill-down.
- Token fields tolerate unavailable provider data.
- Failed and timed-out runs still produce result artifacts.

### Issue 6 (`grader`)

**Title:** Implement declarative assertions and deterministic scenario grading

**Blocked by:** `contracts`, `workspace`, `trace-metrics`

**Scope:**

- required/forbidden tools;
- max tool/error/turn limits;
- final-text checks;
- file/Git/protected-path assertions;
- deterministic grader commands;
- expected-oracle comparison;
- UI-policy violations.

**Acceptance:**

- Assertion failures identify exact evidence paths and trace events.
- Grader commands run only inside the synthetic workspace/project environment.
- No LLM judge.
- Multiple independent failures are reported together.

### Issue 7 (`cli-nix`)

**Title:** Package eval CLI and offline self-test as Nix apps

**Blocked by:** `rpc-engine`, `workspace`, `trace-metrics`, `grader`, `launcher`

**Scope:**

- `.#eval` live app;
- `.#eval-self-test` offline app;
- CLI commands for list/run/suite/report;
- explicit live-model opt-in;
- output-directory handling;
- fake-RPC self-test in canonical verification.

**Acceptance:**

- `nix run .#eval-self-test` is offline and deterministic.
- `nix run .#verify` may call self-test but never calls a model.
- `.#eval` fails clearly without explicit live opt-in.
- CLI preserves all failure artifacts.

### Issue 8 (`comparison`)

**Title:** Add repeated runs, aggregate baselines, and candidate comparison reports

**Blocked by:** `trace-metrics`, `grader`, `cli-nix`

**Scope:**

- repeat count and stable labels;
- aggregate pass rates and distributions;
- median duration/tokens/tools;
- per-scenario regression table;
- links to individual traces;
- deliberate baseline-promotion workflow.

**Acceptance:**

- Compare two fixture result sets deterministically.
- Never hide individual failures behind aggregate scores.
- Avoid unsupported statistical significance claims for small samples.
- Raw traces remain ignored; promoted aggregate summaries are reviewable.

### Issue 9 (`pi-r-coordination`)

**Title:** Coordinate the first fully synthetic pi-r evaluation pack

**Blocked by:** `contracts`, `workspace`, `grader`, `launcher`

**Scope in pi-harness:**

- finalize the project-pack seam;
- document how a project exports or passes its pack;
- define the candidate pi-r override recipe;
- from a separate pi-r checkout, create linked pi-r issue(s) for pi-r-owned changes;
- record links in both repositories.

**Required pi-r scenarios:**

1. compact `r_exec` smoke;
2. transactional rollback;
3. retained-object lifecycle;
4. provisional documentation followed by continued execution;
5. direct Approved Function body edit without prior inspection;
6. multi-file iterative implementation;
7. protected paths and source data;
8. structural-change routing to user-only revision;
9. all-missing synthetic date field without semantic inference from parser class;
10. ambiguous fabricated event definition that requires clarification;
11. complete fabricated cohort analysis across an unrelated fictional domain.

**Acceptance:**

- No SHHS data, paths, schema, field names, distributions, or questions.
- Every dataset is deterministic and marked synthetic.
- The pi-r issue is the source of truth for pi-r repository changes.
- At least one pack fixture validates against the generic contracts.

### Issue 10 (`golden-path`)

**Title:** Run and diagnose the first local-model synthetic golden path

**Blocked by:** `cli-nix`, `comparison`, `pi-r-coordination`

**Scope:**

- Run the first pi-r smoke and core suites against the assumed-available local endpoint.
- Use several deterministic scenario seeds.
- retain traces and reports;
- diagnose failures without weakening assertions;
- promote an initial reviewed aggregate baseline.

**Acceptance:**

- Candidate resource provenance is proven.
- Every scenario uses synthetic data.
- Repeated-run report includes pass rate, tool errors, timeouts, tokens, tool calls, duration, and trace links.
- Failures have actionable evidence.
- Initial aggregate baseline is reviewed before commit.

### Issue 11 (`docs`)

**Title:** Document synthetic eval operation, scenario authoring, and baseline promotion

**Blocked by:** `cli-nix`, `comparison`, `pi-r-coordination`, `golden-path`

**Scope:**

- running smoke/core suites;
- current-checkout overrides;
- adding synthetic generators and hidden oracles;
- reading traces and metrics;
- reproducing regressions;
- promoting baselines;
- data and trace safety;
- explicit non-goals.

**Acceptance:**

- A fresh contributor can run offline self-tests without a model.
- A configured operator can run one live scenario without editing source.
- Documentation explicitly prohibits real datasets, including SHHS.
- Documentation states the endpoint is assumed available.

## Dependency summary

```text
contracts
├── rpc-engine
│   ├── launcher
│   └── trace-metrics
├── workspace
└── pi-r-coordination

trace-metrics + workspace + contracts -> grader
rpc-engine + workspace + trace-metrics + grader + launcher -> cli-nix
trace-metrics + grader + cli-nix -> comparison
contracts + workspace + grader + launcher -> pi-r-coordination
cli-nix + comparison + pi-r-coordination -> golden-path
cli-nix + comparison + pi-r-coordination + golden-path -> docs
```

## Epic-level acceptance criteria

The parent epic is complete when:

1. pi-harness exposes a generic live `eval` app and deterministic offline `eval-self-test`.
2. Canonical verification remains offline and requires no endpoint, model, credentials, or network service.
3. The engine drives Pi through strict RPC and handles settlement, UI requests, retries, compaction, timeout, crash, and cleanup.
4. Every workspace is isolated, Git-backed, and materialized only from a confined synthetic pack.
5. Synthetic provenance and hidden expected oracles are enforced.
6. Generic metrics, assertions, reports, repeated runs, and comparisons work.
7. Candidate project resource identity is proven in every run.
8. A linked pi-r eval pack exists under pi-r issue tracking and contains no real data or SHHS-derived material.
9. The first repeated local-model golden path has been run and an aggregate baseline deliberately reviewed.
10. Operational and authoring documentation is complete.

## Verification expectations for implementation issues

For pi-harness changes:

```console
nix run .#verify
nix run .#eval-self-test
```

Live evidence is supplementary and must never replace offline tests. Live commands must be bounded by timeouts and preserve diagnostics.

For future pi-r pack changes, run pi-r's canonical deterministic gate in that checkout as well as pack validation through the harness eval self-test interface.

## Issue publication procedure for the fresh agent

1. Start in `/home/beau/documents/projects/pi-harness`.
2. Read `AGENTS.md`, `README.md`, `config/agent/settings.json`, `nix/module.nix`, `nix/package.nix`, and `docs/agents/{issue-tracker,triage-labels,domain}.md`.
3. Inspect open issues for an existing equivalent epic or generated plan markers.
4. Ensure `ready-for-agent` exists; use existing `enhancement` and `documentation` category labels.
5. Create one declarative `github_issue_plan` using stable plan key `synthetic-agent-eval-lab-v1` and stable issue keys from this document.
6. Set each child `parent: "epic"`.
7. Encode `blockedBy` exactly as listed.
8. Label only `contracts` as `ready-for-agent` initially. Use category labels on all issues; use `documentation` in addition to `enhancement` for the final docs issue if desired.
9. Call `github_issue_plan` with `apply: false` first and review every title, body, label, parent, and blocker edge.
10. Publish with `apply: true` only after the dry run is valid.
11. Inspect the resulting parent and native sub-issue graph.
12. If blocker relationships require a separate publication step, use the typed native relationship tool with dry-run first.
13. Report issue numbers and the ready frontier.
14. Do not start implementation unless the user asks or a ready issue is explicitly selected.
15. Once the graph is durable and reconciled, remove this handoff document in a separate documentation commit if it is no longer useful.
