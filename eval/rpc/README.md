# Pi RPC evaluation engine

`PiRpcEngine` is the subprocess boundary used by the synthetic evaluation
laboratory. It intentionally does not use Pi's in-process SDK: candidate
launchers must be exercised as separate processes.

## Public seam

```ts
const engine = new PiRpcEngine({
  command: "/path/to/pi",
  args: ["--mode", "rpc", "--no-session"],
  commandTimeoutMs: 30_000,
  promptTimeoutMs: 120_000,
  runTimeoutMs: 300_000,
  uiPolicy: { schemaVersion: "2.0.0", dialogs: [] },
});

await engine.start();
const result = await engine.promptAndWait("A fabricated question");
await engine.stop();
```

The result is returned only after `agent_settled`, then includes state,
messages, append-order entries, session statistics, final assistant text, and
the prompt's complete event sequence. `getDiagnostics()` remains available on
success and failure with commands, parsed records, raw stdout lines, stderr,
malformed input, and exit status.

## Protocol guarantees

- stdout is decoded incrementally and split only on LF; a trailing CR is
  removed, while U+2028 and U+2029 remain JSON string content;
- every parsed stdout record is retained before response/event interpretation;
- command responses are correlated by generated ID and command type;
- prompt settlement is attributed only after its correlated successful response,
  then completion waits for `agent_settled`, never merely `agent_end`;
- exact declared v2/v3 extension dialogs receive their declared response; v1
  policies fail with an explicit migration error;
- undeclared confirmations receive `confirmed: false`, and undeclared
  select/input/editor dialogs receive `cancelled: true`;
- command, prompt, and whole-run deadlines are bounded;
- cancellation and protocol failure issue a best-effort RPC `abort`, then
  terminate the complete detached process group with TERM/KILL escalation;
- the engine supports the repository's Linux/macOS Nix platforms and refuses
  Windows rather than pretending direct-child termination cleans a process tree;
- malformed records, crashes, timeouts, and truncated completions preserve
  diagnostics for later artifact capture.

The engine never starts or health-checks a model endpoint. Its canonical tests
spawn only `tests/fixtures/eval-rpc/fake-rpc.mjs` and use fabricated content.
Live model execution is a later opt-in layer.
