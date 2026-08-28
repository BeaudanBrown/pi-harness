# ADR 0001: Synthetic evaluation contracts and ownership boundaries

- **Status:** Accepted
- **Date:** 2026-08-28
- **Issue:** [#26](https://github.com/BeaudanBrown/pi-harness/issues/26)

## Context

`pi-harness` needs a reusable way to evaluate packaged Pi workflows without coupling the harness to one extension or exposing real research data. The first consumer will be pi-r, but pi-r-specific questions, datasets, graders, and expected values do not belong in this repository.

A run must be reproducible and auditable. It must identify the scenario, pack, generated data, hidden expected result, Pi runtime, harness checkout, candidate project checkout, launcher, model, and timeout policy. Raw model output and workspaces may contain sensitive operational detail even when the source dataset is synthetic, so their retention policy differs from reviewed aggregate baselines.

## Decision

### 1. The harness owns the engine; projects own packs

`pi-harness` owns only generic mechanisms:

- strict Pi RPC process control;
- pack loading and canonical path confinement;
- isolated Git workspace creation;
- trace and state capture;
- generic deterministic metrics and assertions;
- run, suite, comparison, and report orchestration;
- launcher and candidate-resource provenance;
- offline fake-RPC testing and Nix app packaging.

An evaluated project owns scenario declarations, fabricated questions, deterministic generators, fixtures, hidden oracles, suite membership, project-specific grader commands, and deliberately promoted baseline summaries. pi-r changes remain tracked in the pi-r repository. Other harness extensions can provide packs through the same contract.

Host repositories may provide model/provider configuration. They do not own evaluation semantics. The model endpoint is assumed to exist: startup, supervision, health polling, downloads, and model management are outside this design.

### 2. All evaluation data is synthetic

Every scenario sets `synthetic: true`; every pack sets `syntheticOnly: true`; and every scenario embeds provenance that validates against `synthetic-provenance.schema.json` with:

- generator ID and version;
- deterministic seed;
- scenario variant ID;
- row count;
- data-content SHA-256;
- expected-oracle SHA-256.

The loader verifies that materialized data and oracle hashes match the scenario's embedded provenance. The generator produces two logical outputs:

1. model-visible workspace data and a fabricated question;
2. an evaluator-only expected oracle.

The evaluator computes expected values independently of model-produced code. It must never copy the oracle into the model workspace.

SHHS is real data and is prohibited. A pack must not use, inspect, copy, sample, profile, summarize, reference by path, or reproduce SHHS data. It must not imitate SHHS schemas, field names, distributions, coding dictionaries, or research questions. Synthetic packs should span unrelated fictional domains to resist overfitting.

### 3. Pack references are confined after canonical resolution

Pack and generated-output references use portable POSIX-relative paths. They cannot be absolute paths, URI-like references, Windows paths, backslash-separated paths, empty segments, `.` segments, or `..` segments.

Fixture and generator-source references resolve beneath the canonical pack root. Generator output references resolve beneath a fresh evaluator-owned output root. A generator declaration names four channels: model-visible `workspacePath` and `questionPath`, plus evaluator-only `oraclePath` and `provenancePath`. The generated question must exactly match the scenario's fabricated question. The generated provenance document must validate against the provenance schema and exactly match the scenario's embedded expected provenance before any prompt is sent.

The loader must:

1. canonicalize the applicable pack or generated-output root;
2. reject lexically invalid references;
3. resolve each existing target through filesystem symlinks;
4. compute the target path relative to the canonical root;
5. reject targets outside that root;
6. reject missing targets;
7. keep evaluator-only oracle and provenance references separate from model-visible workspace/question content; and
8. reject canonical aliasing or containment across those visibility boundaries.

JSON Schema enforces the portable lexical subset. `eval/contracts/path-policy.ts` defines the filesystem-aware canonical check, including symlink escape and oracle overlap rejection. Later loaders must call this policy rather than implementing weaker prefix checks.

For provenance, a file's content hash is SHA-256 over its raw bytes. A directory's content hash is SHA-256 over the stable `pi-harness-eval-tree-sha256-v1` stream produced by sorting entry names bytewise and encoding each logical path, entry type, file byte length, and file bytes with NUL delimiters. Internal symlinks are followed only after canonical confinement; cycles and non-file/non-directory entries fail. The evaluator verifies both workspace and oracle content against the scenario's embedded hashes before prompting. It also requires the provenance `seed` and `scenarioVariantId` to equal the scenario variant's values; JSON Schema cannot express these cross-field equalities, so `path-policy.ts` provides the normative semantic checks. The same semantic layer rejects duplicate loaded scenario IDs, suite IDs, prompt IDs, assertion IDs, and extension-dialog match keys, and rejects suite members that do not resolve to loaded scenario IDs.

Arbitrary external fixture roots and attached real-data roots are not part of the contract.

### 4. Contracts are versioned JSON Schemas

Version 1 schemas live in `eval/contracts/schemas/v1/`:

| Schema | Responsibility |
| --- | --- |
| `pack.schema.json` | pack identity, synthetic-only declaration, scenario references, suites, and promoted baseline references |
| `scenario.schema.json` | synthetic variant, fabricated question, workspace source, hidden oracle, prompts, deadlines, UI policy, and assertions |
| `prompt.schema.json` | ordered prompt identity, content, and optional deadline override |
| `ui-policy.schema.json` | exact declared dialogs with mandatory default denial |
| `assertion.schema.json` | deterministic tool, limit, text, file, Git, command, oracle, and UI assertions |
| `synthetic-provenance.schema.json` | generated-data identity and content/oracle hashes |
| `metrics.schema.json` | deterministic reliability, efficiency, tool, and workspace metrics |
| `run-result.schema.json` | run status, manifest, metrics, grade evidence, and artifact index |
| `comparison.schema.json` | labeled repeated-run aggregates and per-scenario trace links |

The initial contract schemas use `schemaVersion: 1.0.0`. Compatible additions require optional fields. Breaking changes require a new schema directory and explicit migration; validators must not silently reinterpret an unsupported version.

Scenario/UI policy v2 is defined under `eval/contracts/schemas/v2/`. It replaces v1's unobservable extension-ID policy with exact Pi RPC request payloads and method-compatible responses. The v1 files remain unchanged; [`v2/README.md`](../../../eval/contracts/schemas/v2/README.md) is the explicit migration. Other document types remain on v1.

Sensitive environment values are never schema fields and must not appear in manifests or reports.

### 5. UI and grading are deterministic

The undeclared extension-dialog action is always denial. A v2 scenario may approve only an exact declared RPC request payload—method, title, and all method-specific fields—with one method-compatible response. Pi's current RPC request does not expose an extension identity, which is why the original v1 UI shape is preserved only for compatibility and requires migration before live execution.

Initial grading uses declared assertions, workspace/Git evidence, deterministic commands, and hidden oracles. No LLM judge or scientific-prose scoring is included.

### 6. Live execution is opt-in; verification is offline

The future live `.#eval` app is opt-in and defaults to one concurrent run. Canonical `nix run .#verify` may validate schemas, fixtures, path policy, and a fake RPC process, but must never require an endpoint, model, credentials, or network service.

## Vocabulary

- **Eval engine:** Generic pi-harness runtime that loads packs, drives Pi, captures evidence, grades, and reports.
- **Eval pack:** Project-owned, versioned root containing scenario declarations and their confined resources.
- **Scenario:** One fabricated question, workspace source, prompt sequence, policy, and deterministic expected outcomes.
- **Suite:** Named ordered selection of scenario IDs.
- **Variant:** Reproducible scenario case identified by a stable ID and seed.
- **Synthetic provenance:** Required metadata proving how fabricated data and its oracle were generated.
- **Workspace material:** Data and project files visible to the evaluated model.
- **Hidden oracle:** Evaluator-only expected result that is never materialized into the model workspace.
- **Assertion:** One deterministic condition evaluated from traces, metrics, files, Git state, commands, or an oracle.
- **Run:** One scenario variant executed once in one isolated temporary Git repository.
- **Raw trace:** Unmodified RPC commands/events and process diagnostics retained for drill-down.
- **Run result:** Versioned status, manifest, metrics, grade, and artifact index for one run.
- **Comparison:** Deterministic per-scenario and aggregate view across two labeled result sets.
- **Promoted baseline:** Deliberately reviewed aggregate summary committed by a pack owner; never an automatic snapshot of raw traces.
- **Candidate:** The checkout or package under evaluation, whose active resource identity must be proven before prompting.

## Artifact policy

Local run outputs belong under `.pi/tmp/evals/` (already ignored through `.pi/`) and include raw commands/events, stderr, messages, entries, session data, thinking content, final responses, temporary workspaces, diffs, metrics, grades, and reports. Failure diagnostics remain local and retained.

Only intentionally promoted, deterministic aggregate baseline summaries may be committed under a project-owned pack's `baselines/` directory. Promotion requires review. Raw traces, model thinking, temporary workspaces, sessions, credentials, environment dumps, and unredacted launcher arguments are never committable baseline material.

## Consequences

- Project packs remain portable and cannot attach arbitrary host data.
- The first pi-r integration cannot force pi-r concepts into the generic engine.
- Filesystem-aware validation is required in addition to JSON Schema.
- Reproducibility depends on deterministic generators and independently hashed hidden oracles.
- Endpoint availability remains an operator concern.
- Adding an LLM judge would require a separate decision and cannot weaken deterministic evidence.
